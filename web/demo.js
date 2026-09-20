/* Dados falsos, temporários -------------------------------------------------

   Servido em /demo, e só ali. Quando a página é aberta nesse caminho, este
   arquivo troca `window.fetch` antes de app.js rodar e devolve respostas com o
   mesmo formato que a API real devolveria. Em qualquer outro caminho ele
   retorna na primeira linha e não faz absolutamente nada.

   Nada disso encosta em app.js: não existe uma única referência a este arquivo
   lá dentro.

   Fazer assim, e não plantando valores no app, tem um motivo: o dia em que
   isto sair, sai inteiro. Deletar o arquivo e a tag <script> que o carrega
   remove todo o rastro, e não fica um `if (fake)` esquecido num renderizador
   para alguém descobrir em produção.

   Nada aqui é conservador: os números foram escolhidos para exercitar o
   layout, não para parecer um resultado plausível. Há mês bom e mês ruim,
   posição ganhando e perdendo, moeda que puxa e moeda que arrasta.

   PARA REMOVER: apagar este arquivo, a linha do <script> em index.html e a
   rota /demo em bot/api.py.
   -------------------------------------------------------------------------- */

(() => {
  /* Ligado pelo caminho, não por botão nem por localStorage. O botão tinha de
     morar no cabeçalho do painel de verdade, e um controle cuja única função é
     fazer a tela mentir não pertence ao lado do saldo da conta. Numa URL
     própria é escolha por navegação, impossível de acertar sem querer. */
  if (location.pathname.replace(/\/+$/, '') !== '/demo') return;

  addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = 'DADOS FALSOS — apenas para avaliar o layout. '
      + '<a href="/">abrir o painel de verdade</a>';
    document.body.prepend(bar);
  });

  const START = 10000;
  const COINS = [
    ['SOLUSDT', 'supertrend', 'Supertrend', '4h', 168.4],
    ['XRPUSDT', 'bollinger_breakout', 'Bollinger Breakout', '1d', 2.31],
    ['ADAUSDT', 'rsi_reversion', 'RSI Mean Reversion', '1d', 0.842],
    ['LINKUSDT', 'donchian_breakout', 'Donchian Breakout', '1d', 21.7],
    ['AVAXUSDT', 'ema_cross', 'EMA Crossover', '4h', 38.9],
    ['DOTUSDT', 'macd_trend', 'MACD Trend', '1d', 6.14],
    ['UNIUSDT', 'momentum', 'Momentum (ROC)', '1d', 12.8],
  ];

  /* Um gerador com semente, para a tela não mudar a cada atualização. Um
     layout que se reorganiza sozinho a cada quinze segundos é impossível de
     avaliar. */
  let seed = 20260919;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const between = (lo, hi) => lo + rnd() * (hi - lo);
  const iso = (daysAgo, hour = 12) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - daysAgo);
    d.setUTCHours(hour, (daysAgo * 17) % 60, 0, 0);
    return d.toISOString().replace('.000Z', '+00:00');
  };

  /* ------------------------------------------------------------- operações */

  const closed = [];
  for (let i = 0; i < 46; i += 1) {
    const [symbol, strategy, label, interval, price] = COINS[i % COINS.length];
    const held = Math.round(between(2, 26));
    const exitDays = Math.round(between(1, 150));
    const win = rnd() < 0.58;
    const ret = win ? between(1.4, 14.5) : -between(0.9, 7.2);
    const quote = 500;
    const entryPrice = price * between(0.72, 1.18);
    closed.push({
      id: i + 1,
      symbol,
      strategy,
      strategy_label: label,
      interval,
      status: 'closed',
      mode: 'testnet',
      params: { period: 20, mult: 2 },
      risk: {},
      qty: quote / entryPrice,
      entry_time: iso(exitDays + held),
      entry_price: entryPrice,
      entry_quote: quote,
      exit_time: iso(exitDays),
      exit_price: entryPrice * (1 + ret / 100),
      exit_quote: quote * (1 + ret / 100),
      pnl: quote * ret / 100,
      return_pct: ret,
      duration_seconds: held * 86400,
      reason: win ? 'signal' : (rnd() < 0.5 ? 'stop' : 'signal'),
      entry_signal: { rule: 'fast EMA crossed above slow EMA', values: {} },
      exit_signal: { rule: 'fast EMA crossed back below slow EMA', values: {} },
    });
  }

  const open = COINS.slice(0, 4).map(([symbol, strategy, label, interval, price], i) => {
    const quote = 500;
    const entryPrice = price * between(0.88, 1.06);
    const mark = entryPrice * (1 + [4.8, -2.1, 11.3, -0.6][i] / 100);
    const qty = quote / entryPrice;
    return {
      id: 200 + i,
      symbol,
      strategy,
      strategy_label: label,
      interval,
      status: 'open',
      mode: 'testnet',
      params: { period: 20, mult: 2 },
      risk: {},
      qty,
      entry_time: iso(Math.round(between(2, 19))),
      entry_price: entryPrice,
      entry_quote: quote,
      exit_time: null,
      exit_price: null,
      pnl: null,
      return_pct: null,
      duration_seconds: null,
      reason: null,
      mark_price: mark,
      value: qty * mark,
      unrealised_pnl: qty * mark - quote,
      unrealised_pct: (qty * mark / quote - 1) * 100,
      entry_signal: { rule: 'price closed above the 20-bar high', values: {} },
      pending_exit_rule: 'price closes below the 10-bar low',
    };
  });

  const realised = closed.reduce((sum, t) => sum + t.pnl, 0);
  const unrealised = open.reduce((sum, p) => sum + p.unrealised_pnl, 0);
  const wins = closed.filter((t) => t.pnl > 0);

  /* ---------------------------------------------------------- séries e cortes */

  const equity = (() => {
    const rows = [];
    let value = START;
    for (let d = 180; d >= 0; d -= 1) {
      value += between(-55, 72);
      rows.push({ ts: iso(d, 9), total_value: value, open_positions: 3 });
    }
    // A última leitura tem de bater com os totais, ou o gráfico contradiz o
    // número grande no topo da própria tela.
    rows[rows.length - 1].total_value = START + realised + unrealised;
    return rows;
  })();

  const monthly = (() => {
    const months = [];
    let running = START;
    const now = new Date();
    // Dezoito meses, para o seletor de ano ter dois anos e o de doze
    // colunas ter meses vazios de verdade no ano corrente.
    const pnls = [231.8, -142.0, 508.6, 96.4, -310.7, 622.9, 187.2, 44.1,
                  412.5, -186.3, 743.1, 298.7, -94.2, 519.4, 168.9, -221.6];
    pnls.forEach((pnl, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (pnls.length - 1 - i), 1));
      const opening = running;
      running += pnl;
      months.push({
        month: d.toISOString().slice(0, 7),
        trades: 4 + ((i * 3) % 7),
        pnl,
        wins: 3 + (i % 4),
        losses: 1 + (i % 3),
        return_pct: pnl / opening * 100,
        win_rate_pct: 45 + ((i * 11) % 35),
        equity_end: running,
      });
    });
    return {
      months,
      years: [...new Set(months.map((m) => m.month.slice(0, 4)))].sort(),
      start_capital: START,
      realised_total: running - START,
      profitable_months: months.filter((m) => m.pnl > 0).length,
      best: months.reduce((a, b) => (b.pnl > a.pnl ? b : a)),
      worst: months.reduce((a, b) => (b.pnl < a.pnl ? b : a)),
    };
  })();

  const group = (field) => {
    const buckets = new Map();
    for (const t of closed) {
      const key = field === 'strategy' ? t.strategy_label : t.symbol;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    return [...buckets.entries()].map(([name, rows]) => ({
      name,
      trades: rows.length,
      pnl: rows.reduce((s, t) => s + t.pnl, 0),
      win_rate_pct: rows.filter((t) => t.pnl > 0).length / rows.length * 100,
      avg_return_pct: rows.reduce((s, t) => s + t.return_pct, 0) / rows.length,
      best_return_pct: Math.max(...rows.map((t) => t.return_pct)),
      worst_return_pct: Math.min(...rows.map((t) => t.return_pct)),
      avg_duration_seconds: 9 * 86400,
    })).sort((a, b) => b.pnl - a.pnl);
  };

  /* ------------------------------------------------------------- as respostas */

  const FIXTURES = {
    '/api/overview': () => ({
      start_capital: START,
      total_value: START + realised + unrealised,
      total_pnl: realised + unrealised,
      total_return_pct: (realised + unrealised) / START * 100,
      realised_pnl: realised,
      unrealised_pnl: unrealised,
      invested: open.reduce((s, p) => s + p.entry_quote, 0),
      wins: wins.length,
      losses: closed.length - wins.length,
      closed_trades: closed.length,
      win_rate_pct: wins.length / closed.length * 100,
      profit_factor: 1.84,
      max_drawdown_pct: -8.4,
      sharpe: 1.12,
      mode: 'testnet',
      fees_estimate: 138.2,
      fees_measured: 0,
      fees_measured_orders: 0,
      turnover: 46000,
      positions: open,
    }),
    '/api/equity': () => equity,
    '/api/monthly': () => monthly,
    '/api/breakdown': () => ({ by_strategy: group('strategy'), by_symbol: group('symbol') }),
    '/api/trades': () => [...open, ...closed],
  };

  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
    const fixture = FIXTURES[path];
    if (!fixture) return real(input, init);
    return Promise.resolve(new Response(JSON.stringify(fixture()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };
})();
