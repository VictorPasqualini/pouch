"""FastAPI application: JSON API plus the static dashboard."""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import backtest as bt
from . import coverage
from . import feeds
from . import parity
from . import report, research, sentiment, signals, storage
from . import portfolio, screening, tracking, walkforward
from . import strategies as st
from .config import WEB_DIR, settings
from .exchange import BinanceError, exchange
from .live import bot, get_config, save_config


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # A research thread dies with the process, so never leave a run 'running'.
    storage.execute(
        "UPDATE research_runs SET status = 'interrupted', finished_at = ? "
        "WHERE status = 'running'", (storage.now(),)
    )
    config = get_config()
    if config.get("enabled") and config.get("allocations"):
        bot.start()
        storage.log_event("info", "Bot resumed after restart")
    # Started with the server rather than with the bot, and never stopped by
    # /api/bot/stop. The dataset's value is being unbroken, so pausing trading
    # to change a strategy must not put a hole in it. It resumes only if it was
    # collecting when the process died, so a deliberate stop survives a restart.
    if feeds.get_config().get("enabled"):
        feeds.collector.start()
    yield
    # Shutdown is not the operator choosing to stop. Neither of these writes
    # that choice down, so a restart resumes whatever was running before it.
    bot.stop(remember=False)
    feeds.collector.stop(remember=False)


app = FastAPI(title="Pouch", version="1.0.0", docs_url="/api/docs", lifespan=lifespan)


@app.exception_handler(BinanceError)
async def binance_error_handler(_request, exc: BinanceError):
    return JSONResponse(status_code=502, content={"detail": str(exc), "code": exc.code})


# ------------------------------------------------------------------- schemas

class ResearchRequest(BaseModel):
    symbols: list[str] | None = None
    intervals: list[str] | None = None
    candles: int = Field(default=research.DEFAULT_CANDLES, ge=500, le=10_000)
    strategies: list[str] | None = None


class BacktestRequest(BaseModel):
    symbol: str = "BTCUSDT"
    interval: str = "1h"
    strategy: str = "ema_cross"
    params: dict[str, Any] | None = None
    risk: dict[str, float] | None = None
    candles: int = Field(default=2000, ge=200, le=10_000)


class AllocationRequest(BaseModel):
    result_ids: list[int] | None = None
    allocations: list[dict[str, Any]] | None = None
    quote_per_trade: float | None = None


class RiskRequest(BaseModel):
    max_drawdown_pct: float = Field(0.0, ge=0, le=90)
    resume_drawdown_pct: float = Field(0.0, ge=0, le=90)
    volatility_sizing: bool = False
    max_correlation: float = Field(0.0, ge=0, le=1)


class ConfigRequest(BaseModel):
    mode: str | None = None
    poll_seconds: int | None = Field(default=None, ge=10, le=3600)
    max_positions: int | None = Field(default=None, ge=1, le=20)
    quote_per_trade: float | None = Field(default=None, gt=0)
    start_capital: float | None = Field(default=None, gt=0)


# -------------------------------------------------------------------- status

@app.get("/api/status")
def status() -> dict[str, Any]:
    return {
        "exchange": exchange.ping(),
        "bot": bot.status(),
        "settings": {
            "testnet": settings.testnet,
            "quote_asset": settings.quote_asset,
            "fee_rate": settings.fee_rate,
            "slippage_rate": settings.slippage_rate,
            "symbols": settings.symbols,
            "intervals": settings.intervals,
        },
        "research": research.run_status(),
    }


@app.get("/api/overview")
def overview() -> dict[str, Any]:
    return report.overview()


@app.get("/api/equity")
def equity(limit: int = 500) -> list[dict[str, Any]]:
    return report.equity_curve(limit)


@app.get("/api/trades")
def trades(limit: int = 100) -> list[dict[str, Any]]:
    return report.trades(limit)


@app.get("/api/orders")
def orders(limit: int = 200) -> dict[str, Any]:
    """Raw buy/sell ledger, with the running cash totals underneath it."""
    rows = report.orders(limit)
    return {"orders": rows, "totals": report.ledger_totals(rows)}


@app.get("/api/trades/history")
def trade_history(bars: int = report.HISTORY_BARS) -> list[dict[str, Any]]:
    """Simulated trade-by-trade history of the allocations currently running."""
    return report.allocation_history(bars)


@app.get("/api/risk")
def risk() -> dict[str, Any]:
    """What the portfolio-level controls are set to, and what they are doing."""
    config = get_config()
    symbols = sorted({p["symbol"] for p in bot.open_positions()})
    return portfolio.state(config, symbols)


@app.post("/api/risk")
def update_risk(request: RiskRequest) -> dict[str, Any]:
    config = save_config({"risk_controls": request.model_dump()})
    return portfolio.state(config)


@app.get("/api/validation")
def validation(refresh: bool = False) -> dict[str, Any]:
    """Walk-forward verdict on every allocation, on its deployed parameters."""
    state = walkforward.validation_state(get_config()["allocations"], refresh=refresh)
    # The per-regime slice, pooled across the book. Computed here rather than
    # cached with the reports because it is cheap and derived: the expensive
    # part is the walk-forward itself.
    state["regimes"] = walkforward.book_regimes(state.get("reports") or [])
    return state


@app.get("/api/parity")
def parity_report(limit: int = 50) -> dict[str, Any]:
    """Each live trade next to the trade the backtest would have made."""
    return parity.report(limit)


@app.get("/api/coverage")
def coverage_report() -> dict[str, Any]:
    """Which candle closes the bot was awake for, and which it slept through."""
    return coverage.report()


class BaselineIn(BaseModel):
    at: str | None = Field(None, description="ISO instant; defaults to now")


@app.post("/api/coverage/baseline")
def coverage_baseline(body: BaselineIn) -> dict[str, Any]:
    """Start counting candle coverage from now.

    Missed closes never expire, so a run that began on a laptop being switched
    on and off carries that record forever and can never reach the gate however
    reliable the machine becomes afterwards. Moving the baseline is how a change
    of deployment gets measured on its own terms.

    Deliberately not wired to a button. The closes set aside stay in the report
    and the old figure goes to the event log, but the one use that defeats the
    whole device is moving it because the number is unflattering, and a button
    invites exactly that.
    """
    from datetime import datetime
    moment = None
    if body.at:
        try:
            moment = datetime.fromisoformat(body.at)
        except ValueError:
            raise HTTPException(400, "at must be an ISO 8601 instant")
    return coverage.set_baseline(moment)


@app.get("/api/tracking")
def tracking_report() -> dict[str, Any]:
    """The realised curve against the band predicted when the book was deployed."""
    return tracking.report()


@app.get("/api/signals")
def live_signals(refresh: bool = False) -> dict[str, Any]:
    """What each allocation is watching, and how close it is to acting."""
    return signals.snapshot(get_config().get("allocations") or [], refresh=refresh)


@app.get("/api/readiness")
def readiness() -> dict[str, Any]:
    """Gates that decide whether this book has earned a real-money account."""
    return report.readiness()


@app.get("/api/screen")
def screen(symbols: str, interval: str = "1d",
           candles: int = screening.SCREEN_CANDLES) -> list[dict[str, Any]]:
    """Describe the price shape of symbols. Descriptive only - see screening.py."""
    wanted = [item.strip().upper() for item in symbols.split(",") if item.strip()]
    if not wanted:
        raise HTTPException(status_code=400, detail="no symbols given")
    return screening.screen(wanted[:40], interval, candles)


@app.get("/api/monthly")
def monthly() -> dict[str, Any]:
    """Realised result month by month, credited on the exit."""
    return report.monthly()


@app.get("/api/trades/export.csv")
def trades_csv(limit: int = 5000) -> PlainTextResponse:
    """Every trade as a spreadsheet, for reading somewhere this is not.

    Written by hand rather than through `csv` because the only awkward field is
    the reason text, and quoting that is three lines. Numbers are left
    unformatted - a locale-formatted number is a string to every spreadsheet
    that opens this, and the whole point is to do arithmetic on it elsewhere.
    """
    rows = report.trades(limit)
    columns = [
        ("id", "id"), ("symbol", "moeda"), ("interval", "tempo_grafico"),
        ("strategy", "estrategia"), ("status", "estado"), ("mode", "modo"),
        ("qty", "quantidade"), ("entry_time", "entrada_em"),
        ("entry_price", "entrada_preco"), ("entry_quote", "entrada_valor"),
        ("exit_time", "saida_em"), ("exit_price", "saida_preco"),
        ("exit_quote", "saida_valor"), ("pnl", "resultado"),
        ("return_pct", "retorno_pct"), ("duration_seconds", "duracao_segundos"),
        ("reason", "motivo"),
    ]

    def cell(value: Any) -> str:
        if value is None:
            return ""
        text = str(value)
        if any(ch in text for ch in (",", '"', "\n", "\r")):
            return '"' + text.replace('"', '""') + '"'
        return text

    lines = [",".join(label for _, label in columns)]
    lines.extend(",".join(cell(row.get(key)) for key, _ in columns) for row in rows)
    stamp = storage.now()[:10]
    return PlainTextResponse(
        "\r\n".join(lines),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition":
                 f'attachment; filename="pouch-operacoes-{stamp}.csv"'})


@app.get("/api/breakdown")
def breakdown() -> dict[str, Any]:
    return report.breakdown()


@app.get("/api/events")
def events(limit: int = 60, source: str | None = None) -> list[dict[str, Any]]:
    """Recent activity, optionally for one book only.

    Two books writing into one feed makes it unreadable: what a reader wants
    from an activity list is what the book in front of them just did.
    """
    return storage.recent_events(limit, source)


@app.get("/api/strategies")
def strategies() -> list[dict[str, Any]]:
    return st.catalog()


# --------------------------------------------------------------- market feeds

@app.get("/api/feeds")
def feeds_coverage() -> dict[str, Any]:
    """What market context has been collected, and how far back it reaches."""
    return feeds.coverage()


@app.get("/api/feeds/series")
def feeds_series(feed: str, symbol: str | None = None,
                 limit: int = 500) -> list[dict[str, Any]]:
    return feeds.series(feed, symbol, limit)


@app.get("/api/feeds/headlines")
def feeds_headlines(limit: int = 50) -> list[dict[str, Any]]:
    return feeds.headlines(limit)


@app.post("/api/feeds/start")
def feeds_start() -> dict[str, Any]:
    return feeds.collector.start()


@app.post("/api/feeds/stop")
def feeds_stop() -> dict[str, Any]:
    """Stop collecting, and remember it across restarts.

    The period spent off is not recoverable: funding and fear-and-greed can be
    backfilled, positioning and headlines cannot, so the gap is permanent. The
    stop is logged as a warning for that reason.
    """
    return feeds.collector.stop()


@app.post("/api/feeds/collect")
def feeds_collect(feed: str | None = None) -> dict[str, Any]:
    """Poll now, without waiting for the cadence. For checking, not for use."""
    return {"written": feeds.collector.run_once(only=feed)}


@app.post("/api/feeds/backfill")
def feeds_backfill() -> dict[str, Any]:
    """Pull the two series that have downloadable history, once.

    Funding pages back to 2020 and Fear and Greed to 2018. Everything else has
    a retention window measured in days and can only be accumulated forward,
    which is the whole reason the collector exists.
    """
    return {
        "fear_greed": feeds.backfill_fear_greed(),
        "positioning": feeds.backfill_positioning(),
        "funding": feeds.backfill_funding(),
    }


# ------------------------------------------------------------------ research

@app.post("/api/research/start")
def research_start(request: ResearchRequest) -> dict[str, Any]:
    return research.start_run(
        request.symbols, request.intervals, request.candles, request.strategies
    )


@app.get("/api/research/status")
def research_status(run_id: int | None = None) -> dict[str, Any] | None:
    return research.run_status(run_id)


@app.get("/api/research/leaderboard")
def leaderboard(run_id: int | None = None, limit: int = 40,
                only_validated: bool = False) -> list[dict[str, Any]]:
    return research.leaderboard(run_id, limit, only_validated)


@app.get("/api/research/result/{result_id}")
def research_result(result_id: int) -> dict[str, Any]:
    result = research.result_by_id(result_id)
    if not result:
        raise HTTPException(404, "result not found")
    return result


@app.get("/api/research/runs")
def research_runs(limit: int = 20) -> list[dict[str, Any]]:
    return storage.query(
        "SELECT id, created_at, finished_at, status, progress, total, stage "
        "FROM research_runs ORDER BY id DESC LIMIT ?", (limit,)
    )


@app.post("/api/backtest")
def run_backtest(request: BacktestRequest) -> dict[str, Any]:
    if request.strategy not in st.REGISTRY:
        raise HTTPException(400, f"unknown strategy: {request.strategy}")
    frame = research.load_history(request.symbol, request.interval, request.candles)
    strategy = st.build(request.strategy, request.params)
    risk = request.risk or {}
    result = research.evaluate(frame, strategy, risk)
    benchmark = bt.run(frame, st.build("buy_hold").signal(frame))
    return {
        "symbol": request.symbol,
        "interval": request.interval,
        "strategy": strategy.describe(),
        "risk": risk,
        "metrics": result.metrics,
        "score": bt.robust_score(result.metrics),
        "curve": result.curve(),
        "benchmark_curve": benchmark.curve(),
        "trades": result.trades[-100:],
    }


# ----------------------------------------------------------------------- bot

@app.get("/api/bot/config")
def bot_config() -> dict[str, Any]:
    return get_config()


@app.post("/api/bot/config")
def update_config(request: ConfigRequest) -> dict[str, Any]:
    patch = {k: v for k, v in request.model_dump().items() if v is not None}
    if patch.get("mode") not in (None, "testnet", "paper"):
        raise HTTPException(400, "mode must be 'testnet' or 'paper'")
    return save_config(patch)


@app.post("/api/bot/allocations")
def set_allocations(request: AllocationRequest) -> dict[str, Any]:
    allocations: list[dict[str, Any]] = list(request.allocations or [])
    for result_id in request.result_ids or []:
        result = research.result_by_id(result_id)
        if not result:
            raise HTTPException(404, f"result {result_id} not found")
        allocations.append({
            "symbol": result["symbol"],
            "interval": result["interval"],
            "strategy": result["strategy"],
            "label": result["label"],
            "params": result["params"],
            "risk": result["risk"],
            "source_result_id": result_id,
        })
    # One live allocation per symbol: two strategies on the same asset would
    # fight over the same spot balance.
    unique: dict[str, dict[str, Any]] = {}
    for allocation in allocations:
        unique.setdefault(allocation["symbol"], allocation)
    patch: dict[str, Any] = {"allocations": list(unique.values())}
    if request.quote_per_trade:
        patch["quote_per_trade"] = request.quote_per_trade
    config = save_config(patch)
    storage.log_event("info", f"Allocations set: {len(config['allocations'])} strategies")
    return config


@app.post("/api/bot/start")
def bot_start() -> dict[str, Any]:
    return bot.start()


@app.post("/api/bot/stop")
def bot_stop() -> dict[str, Any]:
    return bot.stop()


@app.post("/api/bot/tick")
def bot_tick() -> dict[str, Any]:
    return bot.tick()


@app.post("/api/bot/close-all")
def bot_close_all() -> dict[str, Any]:
    return {"closed": bot.close_all("manual")}


@app.post("/api/bot/reset")
def bot_reset() -> dict[str, Any]:
    """Wipe trading history. Open positions are left untouched on the exchange."""
    bot.stop()
    for table in ("positions", "orders", "equity_snapshots", "events"):
        storage.execute(f"DELETE FROM {table}")
    storage.set_state("position_peaks", {})
    storage.set_state("risk_halted", False)
    # Equity history is gone, so the kill switch and the post-stop stand-aside
    # flags have nothing left to refer to.
    for allocation in (get_config().get("allocations") or []):
        storage.set_state(f"standaside:{allocation['symbol']}", False)
    storage.log_event("info", "Trading history reset")
    return {"reset": True}


# ----------------------------------------------------------------- processes
#
# Everything that wakes on a clock, in one place. They were each switched from
# wherever they happened to be shown - the robot from the header, the lab from
# its own book, collection from the research tab - which meant no screen could
# answer "what is this process actually doing right now".


@app.get("/api/processes")
def processes() -> dict[str, Any]:
    """Every background loop: whether it is running, and how often it wakes."""
    bot_config = get_config()
    return {"processes": [
        {
            "key": "bot",
            "label": "Robô — livro validado",
            "detail": "Lê o sinal na última vela fechada e decide entrada e saída.",
            "running": bot.running,
            "enabled": bool(bot_config.get("enabled")),
            "every_seconds": int(bot_config.get("poll_seconds", 60)),
            "start": "/api/bot/start",
            "stop": "/api/bot/stop",
            # The one process that refuses to start with nothing to trade, so
            # the panel says why rather than showing a button that does nothing.
            "blocked": ("nenhuma estratégia alocada"
                        if not bot_config.get("allocations") else None),
        },
        {
            "key": "feeds",
            "label": "Coleta de contexto de mercado",
            "detail": "Financiamento, posicionamento, medo e ganância, manchetes.",
            "running": feeds.collector.running,
            "enabled": bool(feeds.get_config().get("enabled")),
            # The thread wakes twice a minute and does nothing on almost every
            # wake; what matters to a reader is the fastest feed it serves.
            "every_seconds": min(feeds.CADENCE_SECONDS.values()),
            "start": "/api/feeds/start",
            "stop": "/api/feeds/stop",
            "warn_on_stop": ("Posicionamento e manchetes não podem ser recuperados"
                             " depois: o período desligado fica faltando para sempre."),
            "blocked": None,
        },
        {
            "key": "sentiment",
            "label": "Pontuação de manchetes (FinBERT)",
            "detail": "Roda no relógio da coleta. ~500 MB residentes depois do"
                      " primeiro uso — é o que aperta a máquina pequena.",
            "running": bool(sentiment.get_config().get("enabled")) and feeds.collector.running,
            "enabled": bool(sentiment.get_config().get("enabled")),
            "every_seconds": feeds.CADENCE_SECONDS["headlines"],
            "start": "/api/sentiment/start",
            "stop": "/api/sentiment/stop",
            "blocked": ("a coleta está desligada, então nada chega para pontuar"
                        if not feeds.collector.running else None),
        },
    ]}


# ----------------------------------------------------------------- sentiment


@app.get("/api/sentiment")
def sentiment_status(days: int = 120) -> dict[str, Any]:
    return {**sentiment.status(), "series": sentiment.daily_series(days)}


@app.post("/api/sentiment/score")
def sentiment_score(limit: int = 500) -> dict[str, Any]:
    """Score whatever is still unscored. Normally the collector has done it."""
    return sentiment.score_pending(limit)


@app.post("/api/sentiment/start")
def sentiment_start() -> dict[str, Any]:
    return sentiment.set_enabled(True)


@app.post("/api/sentiment/stop")
def sentiment_stop() -> dict[str, Any]:
    """Stop scoring headlines, and stop paying the ~500 MB the model costs.

    Collection is unaffected. `sentiment` goes NULL from here, which is the
    discontinuity `sentiment_model` exists to make visible.
    """
    return sentiment.set_enabled(False)


@app.post("/api/sentiment/retry")
def sentiment_retry() -> dict[str, Any]:
    """Try loading the model again after a failed download."""
    return sentiment.retry_load()


# -------------------------------------------------------------------- static

app.mount("/assets", StaticFiles(directory=WEB_DIR), name="assets")


def _page() -> HTMLResponse:
    """The page, with a build stamp on each asset URL.

    A dashboard is deployed by restarting a process, and the browser has no way
    to know that the JavaScript behind an unchanged URL is now different. It
    revalidates when it feels like it, so a panel added today can be invisible
    tomorrow for reasons that look like a bug in the panel. Stamping the URL
    with the file's own modification time makes a changed file a different URL,
    which is the only version of this that cannot go stale.
    """
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    for name in ("app.js", "style.css", "demo.js"):
        path = WEB_DIR / name
        stamp = int(path.stat().st_mtime) if path.exists() else 0
        html = html.replace(f"/assets/{name}", f"/assets/{name}?v={stamp}")
    # The stamping above fixes stale assets and cannot fix a stale document:
    # this URL never changes, carries no validator, and a browser is free to
    # serve it from its own cache for as long as it likes. When it does, the
    # page it serves still points at yesterday's stamps, so every asset is
    # stale too and the whole mechanism above is bypassed. Small, uncached,
    # regenerated per request - there is nothing here worth keeping.
    return HTMLResponse(html, headers={"Cache-Control": "no-store, must-revalidate"})


@app.get("/")
def index() -> HTMLResponse:
    return _page()


@app.get("/demo")
def demo() -> HTMLResponse:
    """The same page, with fabricated numbers, for judging the layout.

    A path rather than a button, because the button had to live in the header
    of the real dashboard: a control whose only purpose is to make the screen
    lie does not belong next to the account balance. On its own URL it is
    opt-in by navigation, impossible to hit by accident, and trivially
    removable - this route and `web/demo.js` go together.

    Served by the same function, so the two can never drift apart. `demo.js`
    reads the path and only patches `fetch` when it is this one.
    """
    return _page()
