"""Portfolio-level risk control.

Phase 4 measured what per-trade stops do to these strategies and the answer was
unambiguous: not one of 31 validated candidates improved under any pure stop,
and the tighter the stop the worse both the return and the drawdown. The reason
is structural — for a trend or breakout strategy the exit signal *is* the stop,
and a price stop bolted on top is a second exit rule that fires on noise, banks
the loss, and re-enters into the same decline paying fees each way.

That closes the trade-level door and opens this one. The controls here act on
the book as a whole, where they cannot pre-empt any individual strategy's own
exit logic:

``kill switch``
    Stop opening positions once portfolio drawdown from its peak crosses a
    threshold. Existing positions keep their own exit rules — closing them all
    at the bottom is precisely the behaviour the stop study showed to be
    destructive.

``volatility-scaled sizing``
    A flat 200 USDT is a different amount of risk in XRP than in INJ. Sizing on
    recent realised volatility equalises what each position can actually cost.

``correlation cap``
    Six positions in assets that move together is one position with six sets of
    fees. Refuse a new entry that is too correlated with what is already open.

All three are off by default. Each one narrows what the bot may do, and a
control that silently blocks trades is worse than no control if its owner did
not choose it.
"""

from __future__ import annotations

import math
import threading
import time
from typing import Any

import numpy as np

from . import storage
from .exchange import INTERVAL_MS, exchange

# Sizing is expressed relative to a reference volatility so that the configured
# quote amount keeps its plain meaning: a symbol at the reference gets exactly
# that amount. Measured, not guessed - the median mean-absolute daily return
# across twelve liquid USDT pairs over the last 90 days is 2.28%, and the first
# version of this used 4%, which pushed almost every symbol against the ceiling
# and turned the control into a flat 1.6x multiplier.
REFERENCE_VOL = 0.023
SIZE_FLOOR = 0.4
SIZE_CEILING = 1.6
VOL_BARS = 30
CORRELATION_BARS = 90

DEFAULTS: dict[str, Any] = {
    # Percent of peak equity lost before new entries stop. 0 disables.
    "max_drawdown_pct": 0.0,
    # Drawdown the book must recover to before entries resume. Re-entering at
    # the exact threshold would flip the switch on and off on every tick.
    "resume_drawdown_pct": 0.0,
    # Scale position size by realised volatility. Off by default.
    "volatility_sizing": False,
    # Refuse an entry correlating above this with an open position. 0 disables.
    "max_correlation": 0.0,
}


def settings_for(config: dict[str, Any]) -> dict[str, Any]:
    return {**DEFAULTS, **(config.get("risk_controls") or {})}


# ------------------------------------------------------------- kill switch

# Both read the rebased series rather than the table: a change of notional
# capital is not a drawdown, and the raw levels would make the kill switch fire
# on one. It did, once.


def peak_equity() -> float:
    series = storage.equity_series()
    return max((float(row["total_value"]) for row in series), default=0.0)


def current_equity(config: dict[str, Any]) -> float:
    series = storage.equity_series(limit=1)
    if series:
        return float(series[-1]["total_value"])
    return float(config.get("start_capital", 10_000.0))


def drawdown_state(config: dict[str, Any]) -> dict[str, Any]:
    """Where the book stands against its own high-water mark."""
    settings = settings_for(config)
    peak = peak_equity()
    equity = current_equity(config)
    drawdown = (equity / peak - 1) * 100 if peak > 0 else 0.0

    limit = float(settings["max_drawdown_pct"] or 0.0)
    resume = float(settings["resume_drawdown_pct"] or 0.0) or limit / 2
    was_halted = bool(storage.get_state("risk_halted"))

    if limit <= 0:
        halted = False
    elif was_halted:
        # Hysteresis: having stopped at -20%, do not resume until -10%, or the
        # switch chatters on every tick that crosses the line.
        halted = drawdown < -resume
    else:
        halted = drawdown <= -limit

    if halted != was_halted:
        storage.set_state("risk_halted", halted)
        storage.log_event(
            "risk",
            f"Entries halted: drawdown {drawdown:.1f}% past the {limit:.0f}% limit"
            if halted else
            f"Entries resumed: drawdown recovered to {drawdown:.1f}%",
            {"drawdown_pct": round(drawdown, 2), "peak": round(peak, 2),
             "equity": round(equity, 2)},
        )

    return {
        "peak": round(peak, 2),
        "equity": round(equity, 2),
        "drawdown_pct": round(drawdown, 2),
        "limit_pct": limit,
        "resume_pct": resume,
        "halted": halted,
        "enabled": limit > 0,
    }


# --------------------------------------------------------- volatility sizing

def realised_volatility(symbol: str, interval: str, bars: int = VOL_BARS) -> float:
    """Recent volatility, expressed per day whatever the interval.

    Per-bar volatility is not comparable across timeframes: a 4h bar moves far
    less than a daily one, so sizing on the raw figure would hand every 4h
    allocation a larger position for no reason other than its clock. Scaling by
    the square root of the bars per day puts every symbol on the same axis,
    which is the axis ``REFERENCE_VOL`` is quoted on.
    """
    frame = exchange.history(symbol, interval, bars + 5)
    if len(frame) < 10:
        return REFERENCE_VOL
    returns = frame["close"].pct_change().dropna().tail(bars)
    value = float(returns.abs().mean())
    if not (value > 0 and math.isfinite(value)):
        return REFERENCE_VOL
    step_ms = INTERVAL_MS.get(interval) or 86_400_000
    return value * math.sqrt(86_400_000 / step_ms)


def size_for(symbol: str, interval: str, base_quote: float,
             config: dict[str, Any]) -> tuple[float, dict[str, Any]]:
    """The quote amount to spend, scaled by how violent this symbol is.

    Returns the amount and the reasoning behind it, so a position that was sized
    down can say why rather than looking like an arbitrary number.
    """
    settings = settings_for(config)
    if not settings["volatility_sizing"]:
        return base_quote, {"scaled": False}

    volatility = realised_volatility(symbol, interval)
    # Clamped: a symbol three times as volatile gets a third of the size, but
    # the bounds stop one quiet week from concentrating the whole book in one
    # asset, and stop one violent day from sizing a position out of existence.
    factor = max(SIZE_FLOOR, min(SIZE_CEILING, REFERENCE_VOL / volatility))
    return round(base_quote * factor, 2), {
        "scaled": True,
        "volatility_pct": round(volatility * 100, 3),
        "reference_pct": round(REFERENCE_VOL * 100, 3),
        "factor": round(factor, 3),
    }


# ----------------------------------------------------------- correlation cap

def _returns(symbol: str, interval: str, bars: int) -> np.ndarray:
    frame = exchange.history(symbol, interval, bars + 5)
    values = frame["close"].pct_change().dropna().tail(bars).to_numpy(dtype=float)
    return values


def correlation(symbol_a: str, symbol_b: str, interval: str,
                bars: int = CORRELATION_BARS) -> float:
    a, b = _returns(symbol_a, interval, bars), _returns(symbol_b, interval, bars)
    size = min(len(a), len(b))
    if size < 30:
        return 0.0
    value = float(np.corrcoef(a[-size:], b[-size:])[0, 1])
    return value if math.isfinite(value) else 0.0


def correlation_block(symbol: str, interval: str, open_symbols: list[str],
                      config: dict[str, Any]) -> dict[str, Any] | None:
    """Whether this entry duplicates exposure the book already carries."""
    settings = settings_for(config)
    limit = float(settings["max_correlation"] or 0.0)
    if limit <= 0 or not open_symbols:
        return None

    for other in open_symbols:
        if other == symbol:
            continue
        try:
            value = correlation(symbol, other, interval)
        except Exception:
            continue
        if value >= limit:
            return {"blocked_by": other, "correlation": round(value, 3),
                    "limit": limit}
    return None


# ------------------------------------------------- concentração do livro

STRUCTURAL_BARS = 365
BOOK_TTL = 900.0
_book_cache: dict[str, Any] = {}
_book_lock = threading.Lock()


def effective_bets(count: int, avg_correlation: float) -> float:
    """Quantas apostas independentes um livro de ``count`` nomes carrega.

    Para ``n`` posições de mesmo tamanho e mesma volatilidade, com correlação
    média ``r`` entre elas, a variância da carteira é ``s²·[1 + (n-1)·r] / n``.
    Uma carteira de ``k`` posições independentes teria variância ``s²/k``.
    Igualando as duas, ``k = n / [1 + (n-1)·r]``.

    É o número que responde "quantas apostas eu tenho, de verdade": dezessete
    nomes com correlação média 0,67 reduzem risco como 1,5 posições
    independentes reduziriam. A diversificação é nominal.

    A fórmula assume tamanhos e volatilidades iguais, o que quase nunca é
    verdade — por isso ``volatility`` vem ao lado, dizendo o quanto essa
    premissa está sendo violada. Como aproximação de ordem de grandeza ela é
    sólida, e a ordem de grandeza é o que decide se vale ligar o teto de
    correlação.
    """
    if count <= 1:
        return float(count)
    denominator = 1 + (count - 1) * max(0.0, avg_correlation)
    return count / denominator if denominator > 0 else float(count)


def _book_returns(symbols: list[str], interval: str,
                  bars: int) -> dict[str, np.ndarray]:
    """Uma busca de histórico por moeda, não uma por par.

    São 136 pares entre dezessete nomes. Chamar ``correlation`` para cada um
    faria 272 buscas para ler dezessete séries.
    """
    series: dict[str, np.ndarray] = {}
    for symbol in symbols:
        try:
            values = _returns(symbol, interval, bars)
        except Exception:
            continue
        if len(values) >= 30:
            series[symbol] = values
        # a moeda sem histórico suficiente some daqui e some das contas
    return series


def _concentration(symbols: list[str], interval: str, bars: int) -> dict[str, Any]:
    """Correlação entre todos os pares do livro, num horizonte."""
    series = _book_returns(symbols, interval, bars)
    names = sorted(series)

    pairs: list[dict[str, Any]] = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            size = min(len(series[a]), len(series[b]))
            value = float(np.corrcoef(series[a][-size:], series[b][-size:])[0, 1])
            if math.isfinite(value):
                pairs.append({"a": a, "b": b, "value": round(value, 3)})

    values = sorted(pair["value"] for pair in pairs)
    average = sum(values) / len(values) if values else 0.0
    step_ms = INTERVAL_MS.get(interval) or 86_400_000

    return {
        "interval": interval,
        "bars": bars,
        "window_days": round(bars * step_ms / 86_400_000),
        "measured": len(names),
        "skipped": sorted(set(symbols) - set(names)),
        "avg_correlation": round(average, 3),
        "median_correlation": round(values[len(values) // 2], 3) if values else None,
        "effective_bets": round(effective_bets(len(names), average), 1),
        "pairs": len(pairs),
        "pairs_above_70": sum(1 for v in values if v > 0.70),
        "pairs_above_80": sum(1 for v in values if v > 0.80),
        "highest": max(pairs, key=lambda p: p["value"]) if pairs else None,
        "lowest": min(pairs, key=lambda p: p["value"]) if pairs else None,
        "per_symbol": {
            symbol: round(
                sum(p["value"] for p in pairs if symbol in (p["a"], p["b"]))
                / max(1, sum(1 for p in pairs if symbol in (p["a"], p["b"]))), 3)
            for symbol in names
        },
    }


def exposure_history(config: dict[str, Any]) -> dict[str, Any]:
    """Quanto do livro esteve realmente dentro, medido no que aconteceu.

    Sai de ``equity_snapshots``, não de simulação: é a exposição que este robô
    teve, não a que uma estratégia teria tido. Sem histórico não há resposta, e
    dizer isso é melhor do que devolver zero com cara de medição.
    """
    rows = storage.query(
        "SELECT open_positions, positions_value, total_value "
        "FROM equity_snapshots ORDER BY ts")
    cap = int(config.get("max_positions", 3) or 0)
    quote = float(config.get("quote_per_trade", 0.0) or 0.0)
    ceiling = round(cap * quote, 2) if cap and quote else None
    if not rows:
        return {"samples": 0, "cap": cap, "ceiling": ceiling}

    counts = [int(row["open_positions"] or 0) for row in rows]
    committed = [float(row["positions_value"] or 0.0) for row in rows]
    totals = [float(row["total_value"] or 0.0) for row in rows]
    deployed = [c / t * 100 for c, t in zip(committed, totals) if t > 0]

    return {
        "samples": len(rows),
        "cap": cap,
        "ceiling": ceiling,
        "avg_open": round(sum(counts) / len(counts), 2),
        "max_open": max(counts),
        "flat_pct": round(sum(1 for c in counts if c == 0) / len(counts) * 100, 1),
        "at_cap_pct": round(
            sum(1 for c in counts if cap and c >= cap) / len(counts) * 100, 1),
        "avg_committed": round(sum(committed) / len(committed), 2),
        "max_committed": round(max(committed), 2),
        "avg_deployed_pct": round(sum(deployed) / len(deployed), 1) if deployed else None,
    }


def book_view(config: dict[str, Any], force: bool = False) -> dict[str, Any]:
    """O livro visto como carteira, e não como uma lista de alocações.

    A varredura pergunta "esta regra presta nesta moeda?" uma vez por moeda, de
    forma independente. Ninguém nunca pergunta se as dezessete juntas formam
    uma carteira — e é essa a pergunta que decide se vale ligar o teto de
    correlação e o dimensionamento por volatilidade.

    Dois horizontes, porque eles discordam e a discordância é informação:

    ``near``
        A janela que os próprios controles usam - noventa velas do tempo
        gráfico do livro. É o que ``correlation_block`` vai enxergar na hora de
        recusar uma entrada, então é o número que prevê o comportamento.

    ``structural``
        Um ano de velas diárias. É a fotografia de fundo, e ela costuma ser
        pior: em quinze dias duas moedas conseguem divergir, em um ano de
        altcoins contra dólar elas quase nunca divergem.

    Decidir pelo primeiro sozinho subestima o risco; pelo segundo sozinho,
    prevê errado o que o teto vai fazer.

    Cacheado por quinze minutos: são trinta e quatro buscas de histórico, e
    nada disso muda dentro de um ciclo de tela.
    """
    allocations = config.get("allocations") or []
    symbols = sorted({a["symbol"] for a in allocations if a.get("symbol")})
    # Um livro pode misturar tempos gráficos, e correlação entre séries de
    # relógios diferentes não significa nada sem reamostrar. O dominante decide,
    # e a tela diz qual foi.
    intervals = [a.get("interval", "1h") for a in allocations]
    interval = max(set(intervals), key=intervals.count) if intervals else "1h"

    if not symbols:
        return {"count": 0, "measured": 0, "interval": interval,
                "exposure": exposure_history(config),
                "settings": settings_for(config), "cached": False}

    key = f"{interval}:{','.join(symbols)}"
    now = time.time()
    with _book_lock:
        hit = _book_cache.get(key)
        if hit and not force and now - hit["computed_at_ts"] < BOOK_TTL:
            return {**hit, "exposure": exposure_history(config), "cached": True}

    near = _concentration(symbols, interval, CORRELATION_BARS)
    structural = _concentration(symbols, "1d", STRUCTURAL_BARS)

    volatility: list[dict[str, Any]] = []
    for symbol in sorted(set(near["per_symbol"]) | set(structural["per_symbol"])):
        try:
            daily = realised_volatility(symbol, interval)
        except Exception:
            continue
        volatility.append({
            "symbol": symbol,
            "volatility_pct": round(daily * 100, 2),
            # O que o dimensionamento por volatilidade faria com esta moeda, se
            # estivesse ligado. Mostrar o fator é o que transforma a opção num
            # número em vez de numa promessa.
            "size_factor": round(
                max(SIZE_FLOOR, min(SIZE_CEILING, REFERENCE_VOL / daily)), 2),
            "near_correlation": near["per_symbol"].get(symbol),
            "structural_correlation": structural["per_symbol"].get(symbol),
        })
    volatility.sort(key=lambda row: -row["volatility_pct"])

    vols = [row["volatility_pct"] for row in volatility]
    result = {
        "count": len(allocations),
        "interval": interval,
        "near": near,
        "structural": structural,
        "volatility": volatility,
        "vol_spread": round(max(vols) / min(vols), 2) if vols and min(vols) > 0 else None,
        "vol_bars": VOL_BARS,
        "settings": settings_for(config),
        "computed_at": storage.now(),
        "computed_at_ts": now,
    }
    with _book_lock:
        _book_cache[key] = result
    return {**result, "exposure": exposure_history(config), "cached": False}


# ------------------------------------------------------------------ summary

def state(config: dict[str, Any], open_symbols: list[str] | None = None) -> dict[str, Any]:
    """Everything the dashboard needs to show what the controls are doing."""
    settings = settings_for(config)
    summary = {"settings": settings, "drawdown": drawdown_state(config)}

    open_symbols = open_symbols or []
    pairs: list[dict[str, Any]] = []
    if settings["max_correlation"] and len(open_symbols) > 1:
        for index, first in enumerate(open_symbols):
            for second in open_symbols[index + 1:]:
                try:
                    value = correlation(first, second, "1d")
                except Exception:
                    continue
                pairs.append({"a": first, "b": second, "correlation": round(value, 3)})
    summary["correlations"] = sorted(pairs, key=lambda p: -p["correlation"])
    return summary
