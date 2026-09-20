/* Pouch dashboard ---------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'dashboard',
  status: null,
  overview: null,
  equity: [],
  leaderboard: [],
  selected: new Set(),
  researchTimer: null,
  detailCurve: null,
  breakdown: null,
  breakdownGroup: 'by_strategy',
  feeds: null,
  processes: [],
  monthlyYear: null,
  monthlyData: null,
};

const VIEW_META = {
  dashboard: ['Painel', 'Resultado consolidado das estratégias em operação'],
  lab: ['Estratégias', 'O que está ligado, com quanto opera, e de onde saem as alocações'],
};

/* ------------------------------------------------------------------- utils */

async function api(path, options = {}) {
  /* Callers pass a path relative to the API root - `/overview`, not
     `/api/overview`. One caller could not: the process roster hands back the
     routes to call, and those are real paths, so prefixing them again produced
     `/api/api/sentiment/stop` and a silent 404 behind a toast. Accepting both
     forms here kills the whole class of it, at the one place that builds URLs. */
  const response = await fetch(path.startsWith('/api/') ? path : `/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.detail || response.statusText);
  return data;
}

const nf = (value, digits = 2) =>
  (value ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

const money = (value, digits = 2) => `$${nf(value, digits)}`;
const signed = (value, digits = 2) => `${value >= 0 ? '+' : ''}${nf(value, digits)}`;
const pct = (value, digits = 2) => `${signed(value, digits)}%`;
const cls = (value) => (value > 0 ? 'pos' : value < 0 ? 'neg' : '');

function dt(iso, withTime = true) {
  if (!iso) return '—';
  const date = new Date(iso);
  const day = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  if (!withTime) return day;
  return `${day} ${date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3800);
}

function setText(id, value, className) {
  const el = $(id);
  if (!el) return;
  el.textContent = value;
  if (className !== undefined) el.className = el.className.replace(/\b(pos|neg)\b/g, '').trim() + ' ' + className;
}

/* Every panel is redrawn on a fifteen-second poll, and a book of daily
   strategies has nothing new to say on almost all of those ticks. Writing
   innerHTML anyway is what moved the page: the browser drops the subtree,
   lays the document out again, and the scroll offset is clamped to whatever
   height the page had while the new markup was still being built.

   So the markup is compared before it is written, and an identical redraw
   costs a string compare instead of a layout. The previous string is kept on
   the node rather than read back from `innerHTML`, because that getter
   returns the browser's own re-serialisation - attributes reordered, entities
   re-encoded - which almost never matches what was set and would make every
   comparison miss.

   Returns whether it actually wrote, because listeners bound to the new
   children must only be bound when there are new children. Re-binding after a
   skipped write would stack a fresh listener on the same node every tick. */
function setHTML(target, html) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el || el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}

/* ------------------------------------------------------------------ charts */

function drawChart(canvas, series, { fill = true, tipTarget = null, format = money } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  /* The `height` attribute is also the backing-store size, and the line below
     overwrites it with height * dpr. Reading it back on the next draw fed that
     product in as the new intent and multiplied again - 240, then 300, then
     375 on a 1.25x display - so the chart grew a little on every fifteen-second
     tick and never stopped. The CSS height is the intention, so it is read once
     and remembered on the node instead of recovered from a field we clobber. */
  const height = canvas.__h ?? (canvas.__h = Number(canvas.getAttribute('height')) || 240);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = series.flatMap((s) => s.points);
  if (points.length < 2) return null;
  // A band's far edge is drawn but is not a point, so it has to be folded into
  // the extent by hand or the shaded area gets clipped at the axis.
  const edges = series.flatMap((s) => (s.bandTo || []).map((y) => ({ y })));

  const pad = { top: 14, right: 56, bottom: 22, left: 10 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  let min = Math.min(...points.concat(edges).map((p) => p.y));
  let max = Math.max(...points.concat(edges).map((p) => p.y));
  const span = max - min || Math.abs(max) * 0.02 || 1;
  min -= span * 0.12;
  max += span * 0.12;

  const n = Math.max(...series.map((s) => s.points.length));
  const xAt = (i, len) => pad.left + (len <= 1 ? plotW : (i / (len - 1)) * plotW);
  const yAt = (v) => pad.top + plotH - ((v - min) / (max - min)) * plotH;

  // grid + right-hand axis labels
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (plotH / 4) * i;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.left, y + 0.5);
    ctx.lineTo(pad.left + plotW, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = '#5d6a80';
    ctx.textAlign = 'left';
    const value = max - ((max - min) / 4) * i;
    ctx.fillText(nf(value, Math.abs(value) > 1000 ? 0 : 2), pad.left + plotW + 8, y);
  }

  // Bands go down first: they are context, and the lines that carry the answer
  // have to sit on top of them.
  series.filter((s) => s.bandTo).forEach((s) => {
    const len = s.points.length;
    if (len < 2) return;
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = xAt(i, len);
      const y = yAt(p.y);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    for (let i = len - 1; i >= 0; i -= 1) ctx.lineTo(xAt(i, len), yAt(s.bandTo[i]));
    ctx.closePath();
    ctx.fillStyle = s.bandColor || 'rgba(91,124,250,0.13)';
    ctx.fill();
  });

  series.forEach((s) => {
    const len = s.points.length;
    if (len < 2 || !s.color) return;
    ctx.lineWidth = s.width || 2;
    ctx.strokeStyle = s.color;
    if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
    ctx.beginPath();
    s.points.forEach((p, i) => {
      const x = xAt(i, len);
      const y = yAt(p.y);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (fill && s.fill !== false) {
      const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      gradient.addColorStop(0, s.fillColor || 'rgba(91,124,250,0.28)');
      gradient.addColorStop(1, 'rgba(91,124,250,0)');
      ctx.lineTo(xAt(len - 1, len), pad.top + plotH);
      ctx.lineTo(xAt(0, len), pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
    }
    ctx.setLineDash([]);
  });

  // x-axis: first and last timestamp
  const first = series[0].points[0];
  const last = series[0].points[series[0].points.length - 1];
  ctx.fillStyle = '#5d6a80';
  ctx.textAlign = 'left';
  ctx.fillText(dt(first.t, false), pad.left, height - 9);
  ctx.textAlign = 'right';
  ctx.fillText(dt(last.t, false), pad.left + plotW, height - 9);

  if (tipTarget) attachTip(canvas, tipTarget, series[0], { xAt, yAt, pad, plotH }, format);
  return { xAt, yAt };
}

function attachTip(canvas, tip, series, geo, format = money) {
  canvas.onmousemove = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const len = series.points.length;
    const ratio = (x - geo.pad.left) / (rect.width - geo.pad.left - 56);
    const index = Math.max(0, Math.min(len - 1, Math.round(ratio * (len - 1))));
    const point = series.points[index];
    tip.hidden = false;
    tip.style.left = `${geo.xAt(index, len)}px`;
    tip.style.top = `${geo.yAt(point.y)}px`;
    setHTML(tip, `<b>${format(point.y)}</b><span>${dt(point.t)}</span>`);
  };
  canvas.onmouseleave = () => { tip.hidden = true; };
}

/* ------------------------------------------------------------------- gates */

/* Six conditions, on one line. They used to own a screen that said "não" in
   full sentences; that screen is gone and the question it asked is not. A
   strip costs one row and still answers it, and the detail travels in the
   tooltip rather than in a paragraph nobody reads twice.

   The order is the order they clear in. Execution first - does the engine do
   what the model says - because until that holds, nothing else on the line
   means anything: a book that is profitable while filling somewhere the
   backtest never modelled is profitable by accident. */
const GATE_SHORT = {
  validation: 'validação',
  parity: 'paridade',
  coverage: 'presença',
  sample: 'amostra',
  tracking: 'previsto',
  drawdown: 'rebaixamento',
};

async function loadGates() {
  let data;
  try {
    data = await api('/readiness');
  } catch {
    /* The readiness report walks every allocation forward and can fail on its
       own; that is not a reason to take the dashboard down with it. */
    $('#gatebar').hidden = true;
    return;
  }
  const gates = data.gates || [];
  $('#gatebar').hidden = gates.length === 0;
  if (!gates.length) return;

  const done = gates.filter((g) => g.ok).length;
  setText('#gatebar-verdict', `${done}/${gates.length}`);
  $('#gatebar-verdict').className = `gatebar-verdict ${data.ready ? 'is-ready' : ''}`;

  /* The same answer twice: once as a count, once in words. The count says how
     far along; the word says what to do with the numbers on the rest of the
     screen. A dashboard that only shows the fraction invites reading a rising
     equity curve as a result while three of the six are still open. */
  const trust = $('#gatebar-trust');
  trust.textContent = data.ready ? 'confiável' : 'não confiável';
  trust.className = `gatebar-trust ${data.ready ? 'is-ok' : 'is-bad'}`;
  trust.title = data.ready
    ? 'Os seis portões fecharam: o motor executa o que o modelo diz e o '
      + 'resultado ao vivo se comporta como o medido.'
    : `Faltam ${gates.length - done} de ${gates.length} portões. Os números `
      + 'desta tela são reais, mas ainda não constituem evidência de que a '
      + 'vantagem existe — nem de que o motor executa o que foi medido.';

  setHTML('#gatebar-items', gates.map((gate) => `
    <span class="gatepill ${gate.ok ? 'is-ok' : ''}" title="${escape(gate.label)} — ${escape(gate.detail || '')}">
      <i class="gatedot"></i>${GATE_SHORT[gate.key] || gate.key}
      ${gate.progress != null && !gate.ok
        ? `<b>${nf(gate.progress * 100, 0)}%</b>` : ''}
    </span>`).join(''));
}

/* --------------------------------------------------------------- dashboard */

async function loadStatus() {
  const status = await api('/status');
  state.status = status;

  const { exchange, bot } = status;
  $('#dot-market').className = `dot ${exchange.market_data ? 'on' : 'off'}`;
  $('#dot-account').className = `dot ${exchange.account ? 'on' : 'off'}`;
  $('#dot-bot').className = `dot ${bot.running ? 'on' : 'idle'}`;
  $('#brand-mode').textContent = bot.mode === 'paper' ? 'papel' : (exchange.testnet ? 'testnet' : 'REAL');
  $('#free-balance').textContent = exchange.account ? money(exchange.quote_balance) : '—';

  if (!exchange.account && exchange.account_error) {
    $('#free-balance').textContent = 'sem chave';
  }
  if (status.research?.status === 'running') watchResearch();
}

async function loadDashboard() {
  const [overview, equity] = await Promise.all([
    api('/overview'), api('/equity'),
  ]);
  state.overview = overview;
  state.equity = equity;

  setText('#kpi-equity', money(overview.total_value));
  setText('#kpi-equity-delta',
    `${pct(overview.total_return_pct)} sobre ${money(overview.start_capital, 0)}`,
    cls(overview.total_return_pct));
  setText('#kpi-pnl', `${overview.total_pnl >= 0 ? '+' : '−'}${money(Math.abs(overview.total_pnl))}`,
    cls(overview.total_pnl));
  setText('#kpi-pnl-split',
    `realizado ${money(overview.realised_pnl)} · aberto ${money(overview.unrealised_pnl)}`);
  setText('#kpi-winrate', `${nf(overview.win_rate_pct, 1)}%`);
  setText('#kpi-winrate-sub', `${overview.wins}G / ${overview.losses}P em ${overview.closed_trades}`);
  renderEquity(equity, overview);
  renderPositions(overview.positions);

  const breakdown = await api('/breakdown');
  state.breakdown = breakdown;
  renderBreakdown(breakdown[state.breakdownGroup || 'by_strategy']);
  state.monthlyData = await api('/monthly');
  renderMonthly(state.monthlyData);
  await loadPanelTrades();
  await loadGates();
}

/* Months are drawn against the largest month in either direction, not against
   a fixed scale, so the shape is readable whether the book makes tens or
   thousands. The baseline is shared and centred: a loss is on the other side
   of it rather than a number with a minus sign to be parsed. */
function renderMonthly(data) {
  const all = data.months || [];
  const years = data.years || [];
  $('#monthly-empty').hidden = all.length > 0;
  if (!all.length) {
    setHTML('#monthly-list', '');
    setHTML('#monthly-years', '');
    setText('#monthly-summary', '—');
    return;
  }

  /* The year defaults to the most recent one with trades, and sticks once the
     reader picks another - a poll that quietly snapped the view back to the
     current year every fifteen seconds would make the picker useless. */
  if (!years.includes(state.monthlyYear)) state.monthlyYear = years[years.length - 1];
  const year = state.monthlyYear;

  setHTML('#monthly-years', years.map((y) => `
    <button class="seg-btn ${y === year ? 'is-on' : ''}" data-year="${y}">${y}</button>`).join(''));

  /* Twelve slots, always, whether or not the book traded in them. A year drawn
     only over the months that happened silently rescales itself: three
     columns in January and twelve in December, and the same bar means
     something different each time you look. An empty month is also a fact -
     it says the book stood still, which is most of what this book does. */
  const byMonth = new Map(all.map((m) => [m.month, m]));
  const slots = Array.from({ length: 12 }, (_, i) => {
    const key = `${year}-${String(i + 1).padStart(2, '0')}`;
    return byMonth.get(key) || { month: key, pnl: 0, trades: 0, win_rate_pct: 0, empty: true };
  });

  /* Scaled across every year, not within the chosen one, so switching years
     compares like with like instead of re-normalising each to its own best
     month. */
  const scale = Math.max(...all.map((m) => Math.abs(m.pnl))) || 1;
  setHTML('#monthly-list', slots.map((m) => {
    if (m.empty) {
      return `
      <div class="mcol is-empty" title="${monthName(m.month)} · sem operações encerradas">
        <span class="mcol-value muted">—</span>
        <span class="mcol-plot"><span class="mcol-half up"></span><span class="mcol-half down"></span></span>
        <span class="mcol-name">${monthName(m.month)}</span>
      </div>`;
    }
    const height = Math.max(Math.abs(m.pnl) / scale * 100, 1.5);
    const up = m.pnl >= 0;
    return `
    <div class="mcol" title="${monthName(m.month)} · ${signed(m.pnl)} · ${m.trades} operações · acerto ${nf(m.win_rate_pct, 0)}%">
      <span class="mcol-value ${cls(m.pnl)}">${signed(m.pnl, 0)}</span>
      <span class="mcol-plot">
        <span class="mcol-half up">${up
          ? `<i class="mcol-bar pos" style="height:${height}%"></i>` : ''}</span>
        <span class="mcol-half down">${up
          ? '' : `<i class="mcol-bar neg" style="height:${height}%"></i>`}</span>
      </span>
      <span class="mcol-name">${monthName(m.month)}</span>
    </div>`;
  }).join(''));

  const traded = slots.filter((m) => !m.empty);
  const total = traded.reduce((sum, m) => sum + m.pnl, 0);
  const up = traded.filter((m) => m.pnl > 0).length;
  setText('#monthly-summary', traded.length
    ? `${year}: ${signed(total)} em ${traded.length} ${traded.length === 1 ? 'mês' : 'meses'}`
      + ` · ${up} ${up === 1 ? 'positivo' : 'positivos'}`
    : `${year}: nenhuma operação encerrada`);
}

/* Delegated from the container, which outlives the buttons: they are rebuilt
   whenever the data changes, and a listener bound to a button dies with the
   node that carried it. */
document.addEventListener('click', (event) => {
  const button = event.target.closest('#monthly-years [data-year]');
  if (!button || button.dataset.year === state.monthlyYear) return;
  state.monthlyYear = button.dataset.year;
  if (state.monthlyData) renderMonthly(state.monthlyData);
});

const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
                   'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthName = (key) => {
  const [year, month] = key.split('-');
  return `${MONTHS_PT[Number(month) - 1] || month}/${year.slice(2)}`;
};

/* The same grouped view the Operações tab draws, capped and scrolled from
   inside. A trade history only grows, and a panel that grows with it pushes
   everything under it off the screen a little further every week. */
async function loadPanelTrades() {
  const box = $('#panel-trades');
  const groups = groupBySymbol((await api('/trades?limit=200')).map(normaliseLive));
  const total = groups.reduce((sum, g) => sum + g.trades.length, 0);
  $('#panel-trades-empty').hidden = total > 0;
  setText('#panel-trades-count',
    `${total} ${total === 1 ? 'operação' : 'operações'} · ${groups.length} moedas`);
  if (!setHTML(box, groups.map((g, i) => tradeGroup(g, i, 'p')).join(''))) return;
  bindTradeRows(box);
}

/* Shared with the Operações tab: one expander, two places that draw it. */
function bindTradeRows(box) {
  $$('.trade-row', box).forEach((row) => row.addEventListener('click', () => {
    const detail = $(`#${row.dataset.detail}`, box);
    detail.hidden = !detail.hidden;
    row.classList.toggle('is-open', !detail.hidden);
    setHTML($('td.expander', row), detail.hidden ? '&#9656;' : '&#9662;');
  }));
}

function renderEquity(rows, overview) {
  const canvas = $('#equity-chart');
  const empty = $('#equity-empty');
  if (rows.length < 2) {
    canvas.style.display = 'none';
    empty.hidden = false;
    $('#equity-range').textContent = '—';
    return;
  }
  canvas.style.display = 'block';
  empty.hidden = true;

  const points = rows.map((row) => ({ t: row.ts, y: row.total_value }));
  const up = points[points.length - 1].y >= points[0].y;
  drawChart(canvas, [{
    points,
    color: up ? '#19d69b' : '#ff5f70',
    fillColor: up ? 'rgba(25,214,155,0.22)' : 'rgba(255,95,112,0.20)',
  }, {
    points: points.map((p) => ({ t: p.t, y: overview.start_capital })),
    color: 'rgba(255,255,255,0.18)', width: 1, dash: [4, 4], fill: false,
  }], { tipTarget: $('#equity-tip') });

  $('#equity-range').textContent = `${dt(rows[0].ts)} — ${dt(rows[rows.length - 1].ts)}`;
}

function renderPositions(positions) {
  const body = $('#positions-table tbody');
  $('#positions-empty').hidden = positions.length > 0;
  $('#positions-table').style.display = positions.length ? '' : 'none';
  setHTML(body, positions.map((p) => `
    <tr>
      <td class="sym">${p.symbol}</td>
      <td>${p.strategy
        ? `<span class="chip">${escape(p.strategy)}</span> <span class="muted">${escape(p.interval)}</span>`
        : `<span class="chip">ranking</span> <span class="muted">p ${nf(p.entry_prob, 3)}</span>`}</td>
      <td class="num">${money(p.entry_quote)}</td>
      <td class="num">${nf(p.entry_price, 4)}</td>
      <td class="num">${nf(p.mark_price, 4)}</td>
      <td class="num">${money(p.value)}</td>
      <td class="num ${cls(p.unrealised_pnl)}">${signed(p.unrealised_pnl)} <span class="muted">${pct(p.unrealised_pct)}</span></td>
    </tr>`).join(''));
}

function renderBreakdown(rows) {
  const box = $('#breakdown-list');
  $('#breakdown-empty').hidden = rows.length > 0;
  if (!rows.length) { setHTML(box, ''); return; }
  const scale = Math.max(...rows.map((r) => Math.abs(r.pnl))) || 1;
  setHTML(box, rows.map((r) => `
    <div class="bar-row">
      <span class="bar-name">${r.name}</span>
      <span class="bar-value ${cls(r.pnl)}">${signed(r.pnl)}</span>
      <div class="bar-track">
        <div class="bar-fill ${r.pnl >= 0 ? 'pos' : 'neg'}"
             style="left:0;width:${Math.abs(r.pnl) / scale * 100}%"></div>
      </div>
      <span class="bar-meta">${r.trades} ops · acerto ${nf(r.win_rate_pct, 0)}% · média ${pct(r.avg_return_pct)}</span>
    </div>`).join(''));
}

// Event messages carry exception text, which can contain anything.
function escape(value) {
  return String(value).replace(/[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

/* --------------------------------------------------------------------- lab */

async function loadLab() {
  const onlyValidated = $('#chk-validated').checked;
  const rows = await api(`/research/leaderboard?limit=50&only_validated=${onlyValidated}`);
  state.leaderboard = rows;
  renderLeaderboard(rows);
  const [status, runs] = await Promise.all([
    api('/research/status'), api('/research/runs?limit=50'),
  ]);
  renderResearchProgress(status);
  renderSweepState(status, runs);
  const [feeds, procs, catalog, config, risk] = await Promise.all([
    api('/feeds'), api('/processes'), api('/strategies'),
    api('/bot/config'), api('/risk'),
  ]);
  renderFeeds(feeds);
  renderProcesses(procs);
  renderBot(procs, config);
  renderRisk(risk);
  renderAllocations(config);
  /* Last on the page, and deliberately: it is reference material about what
     exists to be chosen, not a control. Someone reaches for it once, when a
     name in the ranking above means nothing to them. */
  setHTML('#catalog-list', catalog.map((c) => `
    <div class="catalog-card">
      <strong>${c.label}</strong>
      <span class="family">${c.family} · ${c.grid_size} combinações</span>
      <p>${c.description}</p>
    </div>`).join(''));
}

// Series whose past can be downloaded are already researchable; the rest are
// worth showing precisely because the number that matters is how long they have
// been accumulating, and that only goes up if the process stays alive.
const FEED_LABELS = {
  funding: ['Financiamento', 'perpétuos Binance, histórico completo desde 2020'],
  open_interest: ['Contratos em aberto', 'retenção de 30 dias, só acumula daqui'],
  long_short: ['Posição comprada', 'retenção de 30 dias, só acumula daqui'],
  fear_greed: ['Medo e ganância', 'índice diário, histórico desde 2018'],
  headlines: ['Manchetes', 'RSS público, carimbado na hora em que vimos'],
};

function renderFeeds(data) {
  const chip = $('#feeds-state');
  chip.textContent = data.running ? 'coletando' : 'parado';
  chip.className = `chip ${data.running ? 'ok' : 'warn'}`;
  state.feeds = data;

  renderCollectProgress(data.progress || {}, [...data.feeds, data.news]);

  const rows = [...data.feeds, data.news];
  setHTML('#feeds-list', rows.map((row) => {
    const [name, note] = FEED_LABELS[row.feed] || [row.feed, ''];
    const status = row.status || {};
    // A feed that has never failed shows nothing; one that has shows the error,
    // because a collector quietly returning zero rows for a week is the exact
    // failure this whole panel exists to make impossible to miss.
    const error = status.last_error
      ? `<span class="feed-error" title="${escape(status.last_error)}">falhou</span>` : '';
    return `
    <div class="feed">
      <div class="feed-name">${name} ${error}<span class="muted">${note}</span></div>
      <div class="feed-nums">
        <span><b>${(row.rows || 0).toLocaleString('pt-BR')}</b> linhas</span>
        <span><b>${row.days || 0}</b> dias</span>
        ${row.sources ? `<span><b>${row.sources}</b> fontes</span>` : ''}
        ${row.symbols ? `<span><b>${row.symbols}</b> pares</span>` : ''}
        <span class="muted">visto ${dt(status.last_run)}</span>
      </div>
    </div>`;
  }).join(''));
}

/* How far the collection has got, as a share of the year it needs.
   
   Measured from the first row this process ever wrote, never from the oldest
   timestamp in the data: funding backfills to 2020 and Fear and Greed to 2018,
   so a `source_ts` reading would report the dataset as finished on the day it
   was installed. What the walk-forward can use is only what was observed
   forward, and that clock started when the collector did. */
function renderCollectProgress(progress, rows) {
  const pct = progress.pct || 0;
  $('#collect-bar').style.width = `${pct}%`;
  setText('#collect-pct', `${nf(pct, 1)}% do primeiro ano`);
  setText('#collect-detail', progress.started_at
    ? `${nf(progress.days, 0)} de ${progress.target_days} dias`
      + ` · faltam ${nf(progress.days_left, 0)}`
      + ` · desde ${dt(progress.started_at, false)}`
    : 'nada coletado ainda');

  const forward = rows.filter((r) => r.first_seen);
  const failing = rows.filter((r) => r.status && r.status.last_error).length;
  setHTML('#collect-stats', [
    ['Linhas guardadas', (progress.rows || 0).toLocaleString('pt-BR'),
      `${forward.length} de ${rows.length} fontes ativas`],
    ['Dias corridos', nf(progress.days || 0, 0),
      `alvo ${progress.target_days || 365}`],
    ['Manchetes', ((rows.find((r) => r.feed === 'headlines') || {}).rows || 0)
      .toLocaleString('pt-BR'), 'pontuadas pelo FinBERT'],
    ['Fontes com falha', String(failing),
      failing ? 'veja o detalhe abaixo' : 'nenhuma agora'],
  ].map(([label, value, note]) => `
    <div class="sweep-stat">
      <span class="sweep-stat-label">${label}</span>
      <strong class="sweep-stat-value">${value}</strong>
      <span class="sweep-stat-note">${note}</span>
    </div>`).join(''));
}

function renderLeaderboard(rows) {
  const body = $('#leaderboard-table tbody');
  $('#leaderboard-empty').hidden = rows.length > 0;
  $('#leaderboard-table').style.display = rows.length ? '' : 'none';
  const wrote = setHTML(body, rows.map((row) => {
    const test = row.test;
    const beats = test.total_return_pct > test.buy_hold_return_pct;
    return `
    <tr class="clickable ${state.selected.has(row.id) ? 'selected' : ''}" data-id="${row.id}">
      <td class="tight"><input type="checkbox" data-pick="${row.id}" ${state.selected.has(row.id) ? 'checked' : ''}></td>
      <td class="sym">${row.symbol}</td>
      <td>${row.interval}</td>
      <td>${row.label}<br><span class="muted">${paramText(row.params)}</span></td>
      <td class="num ${cls(test.total_return_pct)}">${pct(test.total_return_pct)}</td>
      <td class="num muted">${pct(test.buy_hold_return_pct)}</td>
      <td class="num">${nf(test.sharpe, 2)}</td>
      <td class="num neg">${nf(test.max_drawdown_pct, 1)}%</td>
      <td class="num">${test.trades}</td>
      <td class="num">${nf(row.score, 2)}</td>
      <td>${row.validated
        ? '<span class="chip ok">aprovada</span>'
        : `<span class="chip ${beats ? 'warn' : 'bad'}">${beats ? 'parcial' : 'reprovada'}</span>`}</td>
    </tr>`;
  }).join(''));

  if (!wrote) return;
  $$('#leaderboard-table tbody tr').forEach((tr) => {
    tr.addEventListener('click', (event) => {
      const id = Number(tr.dataset.id);
      if (event.target.matches('input[data-pick]')) {
        if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
        tr.classList.toggle('selected', state.selected.has(id));
        return;
      }
      showDetail(id);
    });
  });
}

const paramText = (params) =>
  Object.entries(params).filter(([, v]) => v !== 0).map(([k, v]) => `${k}=${v}`).join(' ');

async function showDetail(id) {
  const row = await api(`/research/result/${id}`);
  $('#detail-panel').hidden = false;
  $('#detail-title').textContent = `${row.label} · ${row.symbol} ${row.interval}`;

  const cards = [
    ['Retorno fora da amostra', pct(row.test.total_return_pct), cls(row.test.total_return_pct)],
    ['Retorno no treino', pct(row.train.total_return_pct), cls(row.train.total_return_pct)],
    ['Buy & hold (OOS)', pct(row.test.buy_hold_return_pct), ''],
    ['Sharpe OOS', nf(row.test.sharpe, 2), ''],
    ['Drawdown OOS', `${nf(row.test.max_drawdown_pct, 1)}%`, 'neg'],
    ['Operações OOS', String(row.test.trades), ''],
    ['Acerto OOS', `${nf(row.test.win_rate_pct, 0)}%`, ''],
    ['Fator de lucro', nf(row.test.profit_factor, 2), ''],
    ['Exposição', `${nf(row.test.exposure_pct, 0)}%`, ''],
    ['Consistência OOS', `${nf(row.test.consistency_pct, 0)}%`, ''],
    ['Risco', riskText(row.risk), ''],
  ];
  setHTML('#detail-metrics', cards.map(([label, value, klass]) =>
    `<div class="detail-item"><span>${label}</span><strong class="${klass}">${value}</strong></div>`).join(''));

  const points = row.curve.map((p) => ({ t: p.time, y: p.equity }));
  drawChart($('#detail-chart'), [{
    points, color: '#5b7cfa', fillColor: 'rgba(91,124,250,0.24)',
  }]);
  $('#detail-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function riskText(risk) {
  const parts = [];
  if (risk.stop_pct) parts.push(`stop ${(risk.stop_pct * 100).toFixed(0)}%`);
  if (risk.take_pct) parts.push(`alvo ${(risk.take_pct * 100).toFixed(0)}%`);
  if (risk.trail_pct) parts.push(`trailing ${(risk.trail_pct * 100).toFixed(0)}%`);
  return parts.join(' · ') || 'só sinal';
}

/* What the search has already spent, before offering to spend more.
   
   A leaderboard is a list of survivors, and survivors of a large search are
   partly survivors of luck: 13 strategies over hundreds of parameter sets on
   dozens of symbols will clear every gate by chance somewhere. The out-of-
   sample split, the buy-and-hold comparison and the consistency gate each push
   that rate down, and none of them drive it to zero.
   
   So the running total of candidates tested is shown as the headline figure of
   this tab. It is the denominator nobody keeps in their head, and it is the
   one number that makes "approved" mean less each time the button is pressed. */
function renderSweepState(status, runs) {
  const chip = $('#sweep-state');
  const done = (runs || []).filter((r) => r.status === 'done');
  const tested = (runs || []).reduce((sum, r) => sum + (r.total || 0), 0);

  if (!status) {
    chip.textContent = 'nunca rodou';
    chip.className = 'chip';
    setHTML('#sweep-stats', '');
    setText('#sweep-note', 'Nenhuma varredura ainda. O ranking abaixo está vazio'
      + ' até a primeira rodar.');
    $('#sweep-form').open = true;
    return;
  }

  const running = status.status === 'running';
  chip.textContent = running ? 'rodando' : (status.status === 'done' ? 'concluída' : status.status);
  chip.className = `chip ${running ? 'warn' : (status.status === 'done' ? 'ok' : '')}`;

  const config = status.config || {};
  const symbols = (config.symbols || []).length;
  const intervals = (config.intervals || []).join(', ') || '—';
  setHTML('#sweep-stats', [
    ['Candidatos testados', tested.toLocaleString('pt-BR'), 'somando todas as varreduras'],
    ['Varreduras', String(done.length), 'concluídas até agora'],
    ['Última', status.finished_at ? dt(status.finished_at) : dt(status.created_at),
      `${symbols} ${symbols === 1 ? 'par' : 'pares'} · ${intervals}`],
    ['Resultados guardados', String(status.results ?? 0), 'na última varredura'],
  ].map(([label, value, note]) => `
    <div class="sweep-stat">
      <span class="sweep-stat-label">${label}</span>
      <strong class="sweep-stat-value">${value}</strong>
      <span class="sweep-stat-note">${note}</span>
    </div>`).join(''));

  setText('#sweep-note', tested
    ? `${tested.toLocaleString('pt-BR')} candidatos já foram testados nesta base.`
      + ' Cada varredura nova amplia esse número, e com ele a chance de uma'
      + ' aprovada ter passado por sorte — é por isso que a decisão final é a'
      + ' caminhada para a frente na aba Validação, não este ranking.'
    : 'Nenhum candidato testado ainda.');
}

function renderResearchProgress(status) {
  const box = $('#research-progress');
  if (!status || status.status !== 'running') {
    box.hidden = true;
    $('#btn-research').disabled = false;
    $('#btn-research').textContent = 'Rodar pesquisa';
    return;
  }
  box.hidden = false;
  $('#btn-research').disabled = true;
  $('#btn-research').textContent = 'Pesquisando…';
  $('#research-stage').textContent = status.stage || 'processando';
  $('#research-count').textContent = `${status.progress}/${status.total} · ${status.results} candidatos`;
  $('#research-bar').style.width = `${status.total ? (status.progress / status.total) * 100 : 0}%`;
}

function watchResearch() {
  if (state.researchTimer) return;
  state.researchTimer = setInterval(async () => {
    const status = await api('/research/status');
    renderResearchProgress(status);
    if (!status || status.status !== 'running') {
      clearInterval(state.researchTimer);
      state.researchTimer = null;
      if (status?.status === 'error') toast(`Pesquisa falhou: ${status.error?.slice(0, 90)}`, 'error');
      else toast('Pesquisa concluída', 'ok');
      if (state.view === 'lab') loadLab();
    } else if (state.view === 'lab') {
      loadLab();
    }
  }, 2500);
}

/* ------------------------------------------------------------------ trades */

const REASON_PT = {
  signal: 'sinal de saída da estratégia',
  stop: 'stop de perda',
  target: 'alvo de lucro',
  'trailing stop': 'stop móvel',
  end: 'ainda aberta no fim da janela',
  manual: 'fechada manualmente',
  stale: 'sem saldo para vender',
};

/* The strategy rules live in the engine in English, because the code, the README
   and the roadmap are English. The interface is not, and a card that mixes the
   two is the one place a reader has to stop and translate to check whether the
   numbers beside it make sense. Keyed by the exact string in strategies.py. */
const RULE_PT = {
  'fast EMA rises above the slow EMA': 'a média exponencial rápida cruza acima da lenta',
  'fast EMA falls back below the slow EMA': 'a média exponencial rápida volta a cair abaixo da lenta',
  'MACD histogram turns positive': 'o histograma do MACD fica positivo',
  'MACD histogram turns negative': 'o histograma do MACD fica negativo',
  'Supertrend flips bullish': 'o Supertrend vira para alta',
  'Supertrend flips bearish': 'o Supertrend vira para baixa',
  'price closes above the N-bar high': 'o preço fecha acima da máxima do período',
  'price closes below the M-bar low': 'o preço fecha abaixo da mínima do período',
  'price closes above the upper Bollinger band': 'o preço fecha acima da banda superior de Bollinger',
  'price falls back below the moving average': 'o preço volta a cair abaixo da média móvel',
  'price closes below the lower Bollinger band': 'o preço fecha abaixo da banda inferior de Bollinger',
  'price recovers above the moving average': 'o preço se recupera acima da média móvel',
  'RSI drops below the oversold threshold': 'o RSI cai abaixo do limite de sobrevenda',
  'RSI recovers above the upper threshold': 'o RSI se recupera acima do limite superior',
  '%K crosses above %D while still near oversold': 'a %K cruza acima da %D ainda perto da sobrevenda',
  '%K reaches the overbought threshold': 'a %K atinge o limite de sobrecompra',
  'rate of change rises above the threshold': 'a taxa de variação sobe acima do limite',
  'rate of change falls back below the threshold': 'a taxa de variação volta a cair abaixo do limite',
  'fast EMA above slow EMA while ADX confirms a trending market':
    'média rápida acima da lenta com o ADX confirmando mercado em tendência',
  'EMA trend reverses or ADX drops below the minimum':
    'a tendência das médias inverte ou o ADX cai abaixo do mínimo',
  'price falls the entry z-score below rolling VWAP':
    'o preço cai o z-score de entrada abaixo do VWAP móvel',
  'price returns to the exit z-score above VWAP':
    'o preço volta ao z-score de saída acima do VWAP',
  'enough member sleeves vote long at once': 'estratégias suficientes votam comprado ao mesmo tempo',
  'votes fall back below the minimum': 'os votos caem abaixo do mínimo',
  'always in': 'sempre comprado',
  'never exits': 'nunca sai',
};

/* Values span many magnitudes (a price of 0.32, an ADX of 27, a VWAP of
   64 000), so pick the precision per number instead of fixing it. */
function num(value) {
  if (value == null) return '—';
  const size = Math.abs(value);
  if (size === 0) return '0';
  if (size >= 1000) return nf(value, 2);
  if (size >= 1) return nf(value, 4);
  return nf(value, 6);
}

function dur(seconds) {
  if (seconds == null) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days) return hours ? `${days}d ${hours}h` : `${days}d`;
  if (hours) return mins ? `${hours}h ${mins}min` : `${hours}h`;
  if (mins) return `${mins}min`;
  return `${seconds}s`;
}

const esc = (text) => String(text ?? '').replace(/[<>&]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function valueList(values) {
  const entries = Object.entries(values || {});
  if (!entries.length) return '<p class="muted">Sem indicadores registrados.</p>';
  return `<dl class="sigvals">${entries.map(([name, value]) =>
    `<div><dt>${esc(indicatorText(name))}</dt><dd>${num(value)}</dd></div>`).join('')}</dl>`;
}

/* Indicator names come from the engine too, and several carry their own period
   ("MA 14", "20-bar high"), so an exact map is not enough: translate the whole
   name where it is fixed, and the words around the number where it is not. */
const INDICATOR_PT = {
  price: 'preço',
  'upper band': 'banda superior',
  'lower band': 'banda inferior',
  'signal line': 'linha de sinal',
  histogram: 'histograma',
  'Supertrend direction': 'direção do Supertrend',
  'exit level': 'nível de saída',
  'oversold level': 'nível de sobrevenda',
  'overbought level': 'nível de sobrecompra',
  threshold: 'limite',
  'ADX minimum': 'ADX mínimo',
  'entry z-score': 'z-score de entrada',
  'exit z-score': 'z-score de saída',
  'z-score': 'z-score',
  votes: 'votos',
  'votes required': 'votos necessários',
  'realised volatility': 'volatilidade realizada',
  'volatility cap': 'teto de volatilidade',
};

const INDICATOR_PATTERNS = [
  [/^MA (\d+)$/, 'média móvel $1'],
  [/^EMA (\d+) \(trend filter\)$/, 'média exponencial $1 (filtro de tendência)'],
  [/^EMA (\d+)$/, 'média exponencial $1'],
  [/^VWAP (\d+)$/, 'VWAP $1'],
  [/^(\d+)-bar high$/, 'máxima de $1 candles'],
  [/^(\d+)-bar low$/, 'mínima de $1 candles'],
  [/^vote: (.+)$/, 'voto: $1'],
];

function indicatorText(name) {
  if (INDICATOR_PT[name]) return INDICATOR_PT[name];
  for (const [pattern, replacement] of INDICATOR_PATTERNS) {
    if (pattern.test(name)) return name.replace(pattern, replacement);
  }
  // ADX, ATR, RSI, ROC and MACD read the same in both languages.
  return name;
}

/* `exit_rule` carries the strategy's own rule when the strategy exited, and the
   bare reason code ("end", "stop") when something else did. Translate both, so
   the detail card never shows an English string the rest of the UI translates.
   A protective exit arrives already worded by the engine, with its own
   percentages in it, and falls through unchanged. */
function ruleText(rule) {
  return RULE_PT[rule] || REASON_PT[rule] || rule || '—';
}

/* The candle the rule fired on is not always the candle the order was sent on.
   Strategies hold a position between their entry and exit pulses, so one that
   is added to the book while its signal is already long buys candles after the
   move that justified it - and the indicator values shown belong to that
   earlier candle, not to the fill. Saying so is the difference between "it
   bought a breakout" and "it bought into a breakout that was ten days old". */
function triggerLine(signal) {
  if (!signal || !signal.bar_time) return '';
  const late = signal.bars_since_trigger;
  const when = `candle de ${dt(signal.bar_time)}`;
  const close = signal.bar_close == null ? '' : `, fechamento ${num(signal.bar_close)}`;
  return `<p class="sigmeta muted">sinal disparou no ${when}${close}${late
    ? ` · ${late} ${late === 1 ? 'candle' : 'candles'} antes da ordem` : ''}</p>`;
}

function triggerText(trigger) {
  const OP = { '>': 'acima de', '>=': 'pelo menos', '<': 'abaixo de', '<=': 'no máximo' };
  const left = indicatorText(trigger.left);
  const right = trigger.right ? indicatorText(trigger.right) : num(trigger.right_value);
  return `${left} ${OP[trigger.operator] || trigger.operator} ${right}`;
}

/* The decision itself, on one line, above the full indicator list. */
function triggerBox(trigger) {
  if (!trigger) return '';
  return `<p class="sigtrigger ${trigger.met ? 'is-met' : ''}">
    <span class="sigtrigger-label">${esc(triggerText(trigger))}</span>
    <span class="sigtrigger-nums mono">${num(trigger.left_value)}
      <span class="muted">vs</span> ${num(trigger.right_value)}</span>
  </p>`;
}

function sideCard(title, rule, values, price, time, signal) {
  return `
    <div class="sigcard">
      <h4>${title}</h4>
      <p class="sigrule">${esc(ruleText(rule))}</p>
      <p class="sigmeta">preço ${num(price)}${time ? ` · ${dt(time)}` : ''}</p>
      ${triggerLine(signal)}
      ${triggerBox(signal && signal.trigger)}
      ${valueList(values)}
    </div>`;
}

/* One row plus its hidden explanation row. Trades are normalised upstream so
   live positions and simulated ones render through the same code. */
function tradeRow(trade, key) {
  const open = !trade.exit_time;
  const reason = REASON_PT[trade.reason] || trade.reason || '—';
  return `
    <tr class="trade-row" data-detail="${key}">
      <td class="expander">&#9656;</td>
      <td>${dt(trade.entry_time)}</td>
      <td>${open ? '<span class="chip warn">aberta</span>' : dt(trade.exit_time)}</td>
      <td>${dur(trade.duration_seconds)}</td>
      <td class="num">${num(trade.entry_price)}</td>
      <td class="num">${trade.exit_price == null ? num(trade.mark_price) : num(trade.exit_price)}</td>
      <td class="num ${cls(trade.pnl)}">${trade.pnl == null ? '—' : signed(trade.pnl)}</td>
      <td class="num ${cls(trade.return_pct)}">${trade.return_pct == null ? '—' : pct(trade.return_pct)}</td>
      <td class="mono num">${trade.entry_signal && trade.entry_signal.trigger
        ? `${num(trade.entry_signal.trigger.left_value)} <span class="muted">vs</span>`
          + ` ${num(trade.entry_signal.trigger.right_value)}`
        : '<span class="muted">—</span>'}</td>
      <td class="muted">${open ? 'em andamento' : esc(reason)}</td>
    </tr>
    <tr class="trade-detail" id="${key}" hidden>
      <td colspan="10">
        <div class="sigpair">
          ${sideCard('Sinal de entrada', trade.entry_rule, trade.entry_values,
                     trade.entry_price, trade.entry_time, trade.entry_signal)}
          ${open
            ? `<div class="sigcard"><h4>Saída</h4>
                 <p class="sigrule">${esc(ruleText(trade.exit_rule))}</p>
                 <p class="sigmeta muted">Ainda não ocorreu — é a regra que o robô
                   está esperando. Marcada a ${num(trade.mark_price)}.</p></div>`
            : sideCard('Sinal de saída', trade.exit_rule, trade.exit_values,
                       trade.exit_price, trade.exit_time, trade.exit_signal)}
        </div>
      </td>
    </tr>`;
}

function tradeGroup(group, index, scope = 't') {
  const trades = group.trades;
  const closed = trades.filter((t) => t.exit_time);
  const wins = closed.filter((t) => t.pnl > 0).length;
  const pnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const spans = closed.map((t) => t.duration_seconds).filter((v) => v != null);
  const avg = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  const params = Object.entries(group.params || {}).map(([k, v]) => `${k}=${v}`).join(' ');

  return `
    <div class="tgroup">
      <div class="tgroup-head">
        <span class="sym">${esc(group.symbol)}</span>
        <span class="chip">${esc(group.strategy_label || group.strategy)}</span>
        <span class="muted">${esc(group.interval)}</span>
        <span class="muted mono">${esc(params)}</span>
        <span class="tgroup-stats">
          <b class="${cls(pnl)}">${signed(pnl)}</b>
          <span class="muted">${trades.length} ops · ${closed.length
            ? `acerto ${nf(wins / closed.length * 100, 0)}%` : 'nenhuma fechada'}${avg == null
            ? '' : ` · duração média ${dur(Math.round(avg))}`}</span>
        </span>
      </div>
      <div class="table-wrap">
        <table class="trades-table">
          <thead>
            <tr><th></th><th>Entrada</th><th>Saída</th><th>Duração</th>
                <th class="num">Preço entrada</th><th class="num">Preço saída</th>
                <th class="num">Resultado</th><th class="num">%</th>
                <th class="num">Sinal de compra</th><th>Motivo da saída</th></tr>
          </thead>
          <tbody>${trades.map((t, i) => tradeRow(t, `${scope}-${index}-${i}`)).join('')}</tbody>
        </table>
      </div>
    </div>`;
}

/* Live positions carry their snapshot in entry_signal/exit_signal; simulated
   ones arrive flattened. Normalise so one renderer serves both. */
function normaliseLive(row) {
  return {
    ...row,
    entry_rule: row.entry_signal?.rule
      || 'não registrado (posição aberta antes do detalhamento de sinais)',
    exit_rule: row.exit_signal?.rule
      || (row.exit_time ? row.reason : row.pending_exit_rule),
    entry_values: row.entry_signal?.values,
    exit_values: row.exit_signal?.values,
  };
}

function groupBySymbol(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.symbol}|${row.strategy}|${row.interval}`;
    if (!groups.has(key)) {
      groups.set(key, {
        symbol: row.symbol, strategy: row.strategy, interval: row.interval,
        strategy_label: row.strategy_label, params: row.params, trades: [],
      });
    }
    groups.get(key).trades.push(row);
  }
  return [...groups.values()];
}

/* The ledger is deliberately not grouped. Grouping answers "how is this coin
   doing"; the panel above it already does that. This one answers "what did the
   robot do, in order", which is the question a statement answers, and a
   statement that reorders itself is not a statement. */
/* ------------------------------------------------------------- processes */

/* Every loop that wakes on a clock, with its switch next to it. They used to
   be scattered - the robot in the header, the lab inside its own book, market
   collection in the research tab - so no single screen could answer what was
   actually running. `enabled` and `running` are reported separately on purpose:
   a process can be switched on and still be down, and the two cases need
   different responses from whoever is reading. */
/* The robot, on its own card and with its own form.

   Separate from the collectors because it is the only one that moves money:
   its switch needs to say how much per order, in what mode, against what
   ceiling, and a collector's switch needs none of that.

   The form itself is static markup and is never redrawn. It sits inside a
   panel the fifteen-second poll rewrites, and a field rebuilt under someone's
   fingers throws away what they were typing. Only the values are pushed in,
   and only into fields that are not focused. */
function renderBot(data, config) {
  const bot = (data.processes || []).find((row) => row.key === 'bot');
  if (!bot) return;

  const chip = $('#bot-state');
  chip.textContent = bot.running ? 'rodando' : (bot.enabled ? 'ligado, parado' : 'desligado');
  chip.className = `chip ${bot.running ? 'ok' : (bot.enabled ? 'warn' : '')}`;

  const toggle = $('#btn-toggle-bot');
  toggle.textContent = bot.running ? 'Desligar' : 'Ligar';
  toggle.className = `btn btn-small ${bot.running ? 'btn-danger' : 'btn-primary'}`;
  toggle.disabled = Boolean(bot.blocked) && !bot.running;
  $('#bot-blocked').hidden = !bot.blocked;
  $('#bot-blocked').textContent = bot.blocked || '';

  /* The money facts, readable without opening the form. How much leaves the
     account per order is not a setting to go looking for. */
  const live = config.mode !== 'paper' && state.status?.exchange?.testnet === false;
  setHTML('#bot-summary', [
    [config.mode === 'paper' ? 'papel' : (live ? 'CONTA REAL' : 'testnet'),
     'modo', live ? 'neg' : ''],
    [money(config.quote_per_trade, 0), 'por operação', ''],
    [String(config.max_positions), 'posições no máximo', ''],
    [money(config.quote_per_trade * config.max_positions, 0), 'comprometido no teto', ''],
    [`${config.poll_seconds}s`, 'entre ciclos', ''],
  ].map(([value, label, tone]) => `
    <span class="botfact">
      <b class="${tone}">${value}</b><span class="muted">${label}</span>
    </span>`).join(''));

  /* Values in, but never over a field being edited. */
  const fill = (sel, value) => {
    const el = $(sel);
    if (el && el !== document.activeElement) el.value = value;
  };
  fill('#in-mode', config.mode);
  fill('#in-poll', config.poll_seconds);
  fill('#in-quote', config.quote_per_trade);
  fill('#in-maxpos', config.max_positions);
  fill('#in-capital', config.start_capital);
}

function renderAllocations(config) {
  const list = config.allocations || [];
  $('#allocations-empty').hidden = list.length > 0;
  setText('#allocations-count', list.length
    ? `${list.length} ${list.length === 1 ? 'estratégia' : 'estratégias'}` : '—');
  const wrote = setHTML('#allocations-list', list.map((a, index) => `
    <div class="alloc">
      <div class="alloc-main">
        <strong>${a.symbol} · ${a.label || a.strategy}</strong>
        <span>${a.interval} · ${paramText(a.params || {})} · ${riskText(a.risk || {})}</span>
      </div>
      <button class="btn btn-small btn-danger" data-drop="${index}">Remover</button>
    </div>`).join(''));

  if (wrote) $$('[data-drop]').forEach((button) => button.addEventListener('click', async () => {
    const next = list.filter((_, i) => i !== Number(button.dataset.drop));
    await api('/bot/allocations', { method: 'POST', body: { allocations: next } });
    toast('Estratégia removida');
    loadLab();
  }));
}

/* The collectors. The robot is drawn above by renderBot; these two neither
   trade nor need a form. */
function renderProcesses(data) {
  const rows = (data.processes || []).filter((row) => row.key !== 'bot');
  state.processes = rows;
  const on = rows.filter((row) => row.running).length;
  setText('#processes-summary', `${on} de ${rows.length} rodando`);

  const wrote = setHTML('#processes-list', rows.map((row) => {
    const chip = row.running
      ? '<span class="chip ok">rodando</span>'
      : `<span class="chip ${row.enabled ? 'warn' : ''}">${
          row.enabled ? 'ligado, parado' : 'desligado'}</span>`;
    const tone = row.blocked ? 'is-blocked' : (row.running ? 'is-on' : 'is-off');
    return `
    <div class="proc ${tone}">
      <div class="proc-main">
        <span class="proc-name">${esc(row.label)} ${chip}</span>
        <span class="proc-detail">${esc(row.detail)}</span>
        ${row.blocked ? `<span class="proc-blocked">${esc(row.blocked)}</span>` : ''}
      </div>
      <span class="proc-every">a cada ${every(row.every_seconds)}</span>
      <button class="btn btn-small ${row.running ? 'btn-danger' : 'btn-primary'}"
              data-proc="${row.key}" ${row.blocked && !row.running ? 'disabled' : ''}>
        ${row.running ? 'Desligar' : 'Ligar'}
      </button>
    </div>`;
  }).join(''));
  if (!wrote) return;

  $$('[data-proc]').forEach((button) => button.addEventListener('click', async () => {
    const row = state.processes.find((item) => item.key === button.dataset.proc);
    if (!row) return;
    /* Only the off direction asks, and only where off costs something that
       cannot be bought back. Confirming a switch that is free to undo trains
       people to click through the one that is not. */
    if (row.running && row.warn_on_stop
        && !confirm(`Desligar ${row.label}? ${row.warn_on_stop}`)) return;
    try {
      const result = await api(row.running ? row.stop : row.start, { method: 'POST' });
      toast(result.message === 'no strategies allocated'
        ? 'Nenhuma estratégia alocada'
        : `${row.label}: ${row.running ? 'desligado' : 'ligado'}`, 'ok');
      loadLab();
    } catch (error) { toast(error.message, 'error'); }
  }));
}

/* Cadences here span ten minutes to six hours, and "21600s" is a number the
   reader has to do arithmetic on to understand. */
function every(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  const hours = seconds / 3600;
  return `${nf(hours, hours % 1 ? 1 : 0)} h`;
}

/* ---------------------------------------------------------------- settings */

/* The kill switch has to state what it is doing right now, not only what it is
   set to: "desligado" and "armado mas longe do limite" look identical otherwise. */
function renderRisk(risk) {
  const settings = risk.settings || {};
  const dd = risk.drawdown || {};
  $('#in-maxdd').value = settings.max_drawdown_pct ?? 0;
  $('#in-resumedd').value = settings.resume_drawdown_pct ?? 0;
  $('#in-maxcorr').value = settings.max_correlation ?? 0;
  $('#in-volsize').checked = Boolean(settings.volatility_sizing);

  const chip = $('#risk-state');
  const active = dd.enabled || settings.volatility_sizing || settings.max_correlation > 0;
  chip.textContent = dd.halted ? 'entradas bloqueadas' : (active ? 'ativo' : 'desligado');
  chip.className = `chip ${dd.halted ? 'bad' : (active ? 'ok' : '')}`;

  const parts = [];
  if (dd.enabled) {
    parts.push(`Queda atual ${num(dd.drawdown_pct)}% do topo de ${num(dd.peak)} USDT`
      + ` — limite ${num(dd.limit_pct)}%, volta a operar em ${num(dd.resume_pct)}%.`);
  }
  const pairs = risk.correlations || [];
  if (pairs.length) {
    const worst = pairs[0];
    parts.push(`Par mais correlacionado em carteira: ${esc(worst.a)} e ${esc(worst.b)},`
      + ` ${worst.correlation}.`);
  }
  $('#risk-detail').textContent = parts.join(' ');
}


/* ------------------------------------------------------------------ router */

function switchView(view) {
  state.view = view;
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  const [title, subtitle] = VIEW_META[view];
  $('#view-title').textContent = title;
  $('#view-subtitle').textContent = subtitle;
  window.scrollTo(0, 0);
  refresh();
}

async function refresh({ keepScroll = false } = {}) {
  /* Hold the document's floor at the height it has right now, for as long as
     the redraw takes. Every version of this jump had the same shape: a panel
     is rewritten, the page is briefly shorter than the reader's scroll offset,
     and the browser clamps the offset to the new bottom. Reserving the height
     means there is nothing to clamp to.

     The previous attempt put the offset back afterwards instead, which fixed
     the clamp and introduced a worse bug: a reader who scrolled while the
     request was in flight got yanked back to where they were a second ago.
     Holding the floor needs no correction at all, so there is nothing to yank. */
  const floor = keepScroll ? document.documentElement.scrollHeight : 0;
  if (floor) document.body.style.minHeight = `${floor}px`;
  try {
    await loadStatus();
    if (state.view === 'dashboard') await loadDashboard();
    else if (state.view === 'lab') await loadLab();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    if (floor) document.body.style.minHeight = '';
  }
}

/* ------------------------------------------------------------------- wire */

$$('.nav-item').forEach((item) =>
  item.addEventListener('click', () => switchView(item.dataset.view)));

$('#btn-save-risk').addEventListener('click', async () => {
  try {
    renderRisk(await api('/risk', { method: 'POST', body: {
      max_drawdown_pct: Number($('#in-maxdd').value),
      resume_drawdown_pct: Number($('#in-resumedd').value),
      max_correlation: Number($('#in-maxcorr').value),
      volatility_sizing: $('#in-volsize').checked,
    } }));
    toast('Controles de risco salvos');
  } catch (error) {
    toast(error.message, 'error');
  }
});

$('#btn-refresh').addEventListener('click', (event) => {
  event.currentTarget.querySelector('svg').classList.add('spin');
  refresh({ keepScroll: true }).finally(() =>
    setTimeout(() => event.currentTarget.querySelector('svg').classList.remove('spin'), 400));
});

$('#btn-toggle-bot').addEventListener('click', async () => {
  const running = state.status?.bot?.running;
  try {
    const result = await api(running ? '/bot/stop' : '/bot/start', { method: 'POST' });
    toast(result.message === 'no strategies allocated'
      ? 'Nenhuma estratégia alocada — escolha no Laboratório'
      : (running ? 'Robô parado' : 'Robô ligado'), result.running || !running ? 'ok' : 'error');
    refresh();
  } catch (error) { toast(error.message, 'error'); }
});

$('#btn-close-all').addEventListener('click', async () => {
  if (!confirm('Encerrar todas as posições abertas a mercado?')) return;
  try {
    const result = await api('/bot/close-all', { method: 'POST' });
    toast(`${result.closed.length} posição(ões) encerrada(s)`, 'ok');
    refresh();
  } catch (error) { toast(error.message, 'error'); }
});

$('#btn-research').addEventListener('click', async () => {
  const symbols = $('#in-symbols').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const intervals = $('#in-intervals').value.split(',').map((s) => s.trim()).filter(Boolean);
  const candles = Number($('#in-candles').value);
  try {
    const result = await api('/research/start', { method: 'POST', body: { symbols, intervals, candles } });
    if (!result.started) { toast(`Já existe uma pesquisa rodando (#${result.run_id})`, 'error'); }
    else toast('Pesquisa iniciada');
    state.selected.clear();
    watchResearch();
    renderResearchProgress(await api('/research/status'));
  } catch (error) { toast(error.message, 'error'); }
});

$('#chk-validated').addEventListener('change', loadLab);

$$('#breakdown-toggle .seg-btn').forEach((button) => button.addEventListener('click', () => {
  $$('#breakdown-toggle .seg-btn').forEach((other) => other.classList.toggle('is-on', other === button));
  state.breakdownGroup = button.dataset.group;
  if (state.breakdown) renderBreakdown(state.breakdown[state.breakdownGroup]);
}));

$('#btn-allocate').addEventListener('click', async () => {
  if (!state.selected.size) { toast('Marque ao menos uma estratégia na tabela', 'error'); return; }
  try {
    const config = await api('/bot/allocations', {
      method: 'POST', body: { result_ids: [...state.selected] },
    });
    toast(`${config.allocations.length} estratégia(s) prontas para operar`, 'ok');
    state.selected.clear();
    loadLab();
  } catch (error) { toast(error.message, 'error'); }
});

$('#btn-close-detail').addEventListener('click', () => { $('#detail-panel').hidden = true; });

$('#btn-save-config').addEventListener('click', async () => {
  try {
    await api('/bot/config', {
      method: 'POST',
      body: {
        mode: $('#in-mode').value,
        poll_seconds: Number($('#in-poll').value),
        quote_per_trade: Number($('#in-quote').value),
        max_positions: Number($('#in-maxpos').value),
        start_capital: Number($('#in-capital').value),
      },
    });
    toast('Ajustes salvos', 'ok');
    refresh();
  } catch (error) { toast(error.message, 'error'); }
});

$('#btn-tick').addEventListener('click', async () => {
  try {
    const result = await api('/bot/tick', { method: 'POST' });
    toast(`Ciclo executado: ${result.actions.length} ação(ões) em ${result.checked} estratégia(s)`, 'ok');
    refresh();
  } catch (error) { toast(error.message, 'error'); }
});

$('#btn-reset').addEventListener('click', async () => {
  if (!confirm('Apagar todo o histórico de operações, ordens e patrimônio?')) return;
  await api('/bot/reset', { method: 'POST' });
  toast('Histórico zerado', 'ok');
  refresh();
});

window.addEventListener('resize', () => {
  if (state.view === 'dashboard' && state.equity.length > 1 && state.overview) {
    renderEquity(state.equity, state.overview);
  }
});

refresh();
setInterval(() => { if (!document.hidden) refresh({ keepScroll: true }); }, 15000);
