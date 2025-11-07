<p align="center">
  <img src="./public/naemu2.png" alt="奈木 (NAEMU)" width="120" />
</p>

## What 奈木 (NAEMU) does

奈木 (NAEMU) trades Aster futures intraday. It makes short‑horizon decisions (1–15 minutes) using a compact market state and a Qwen model plan (action, symbol, size, thesis, stop, take‑profit, min‑hold). Orders respect exchange step size and risk caps.

## How it works end to end

### Configuration and state

The API worker stores configuration and runtime data in Cloudflare KV. A default config is kept in code and mirrored to KV at first run.

```ts
// api-worker/src/index.ts
type VibeConfig = {
  status: 'running' | 'stopped';
  universe: string[];
  maxRiskPerTradeUsd: number;
  maxDailyLossUsd: number;
  maxExposureUsd: number;
  leverageCap: number;
  marginMode: 'cross' | 'isolated';
  model: string;
};

const DEFAULT_VIBE_CONFIG: VibeConfig = {
  status: 'running',
  universe: ['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','SOLUSDT','ASTERUSDT','CAKEUSDT','ZORAUSDT','PUMPUSDT','ZECUSDT'],
  maxRiskPerTradeUsd: 500,
  maxDailyLossUsd: 2000,
  maxExposureUsd: 10000,
  leverageCap: 5,
  marginMode: 'cross',
  model: 'qwen2.5-32b-instruct'
};
```

### Market data and indicators

Each tick the worker fetches Aster futures data, merges a small kline window, and derives EMA9/EMA21, RSI14, ATR14, VWAP, and range compression. Symbols use exchangeInfo to learn step size and minimum notional.

### Decision loop with Qwen

The agent calls Qwen (compatible mode via DashScope) and asks for a compact JSON plan with one clear action.

```ts
// api-worker/src/index.ts
async function callLLMDecider(env: Env, state: any, cfg: VibeConfig) {
  const apiKey = env.QWEN_API_KEY;
  const baseUrl = (env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  const model = cfg.model || 'qwen2.5-32b-instruct';
  const sys = `You are an intraday futures trading decider focused on 1 to 15 minute horizons. Use ema9, ema21, rsi14, atr14, vwap, and rangePct with current prices. Output strict JSON with keys action, symbol, size_usd, thesis, stop_loss_price, take_profit_price, min_hold_minutes.`;
  const user = { role: 'user', content: `State: ${JSON.stringify(state).slice(0, 9000)}` } as const;
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, response_format: { type: 'json_object' }, messages: [ { role:'system', content: sys }, user ] })
  });
  // parse JSON plan and return { parsed, meta }
}
```

Sizing uses a simple rule that targets a slice of equity within a hard cap. This increases trade size without breaking risk limits.

```ts
// api-worker/src/index.ts
// inside the decision handler after parsing llm output
const targetRisk = Math.max(0, Math.floor((state.balances?.equityUsd || availableBalance) * 0.20));
const sizeUsd = Math.min(cfg.maxRiskPerTradeUsd, targetRisk);
```

Orders are rounded to the correct step size and checked against minimum notional. Open trades are tracked in KV. A close event produces a closed trade entry with PnL for the UI.

### HTTP surface

Key routes are served by the worker.

```text
GET  /api/vibe/status
POST /api/vibe/run
POST /api/vibe/stop
POST /api/vibe/tick
GET  /api/vibe/prices
GET  /api/vibe/open-trades
GET  /api/vibe/trades
GET  /api/vibe/equity
GET  /api/vibe/logs
```

You can test locally or in production with curl.

```bash
curl https://api.naemu.com/api/vibe/status
curl -X POST https://api.naemu.com/api/vibe/tick
```

## The dashboard

The site is a Next.js app deployed to Cloudflare. It fetches from the API at a fixed base url.

```ts
// app/page.tsx
const API_BASE = 'https://api.naemu.com';
```

### Price ticker

The top bar shows a loop of tokens with icons and live prices. Updates arrive every three seconds with random delays per symbol to avoid synchronized jumps. Hover pauses the marquee and clicking opens the Aster futures page in a new tab.

```tsx
function PriceCell({ k, img, label }: { k: string; img: string; label: string }) {
  const v = data[k];
  const changed = !!(changeRef.current[k] && Date.now() - changeRef.current[k].t < 900);
  const val = typeof v === 'number' ? `$${v.toFixed(digitsFor(k, v))}` : '—';
  const href = `https://www.asterdex.com/en/futures/v1/${symbolFor(k)}`;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, textDecoration: 'none' }}>
      <img src={img} alt="" style={{ width: 16, height: 16 }} />
      <strong>{label}</strong>
      <span className={changed ? 'flashWhite' : ''}>{val}</span>
    </a>
  );
}
```

### Activity panel

Trades shows open positions and completed trades. The open view displays entry and current price on separate lines with quantity and unrealized profit and loss. Icons include the NAEMU mark and the coin.

```tsx
{openTrades.map((t) => {
  const base = String(t.symbol||'').replace('USDT','');
  const qty = typeof t.qty === 'number' ? ((t.side==='SHORT'?-1:1)*Math.abs(t.qty)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
  const entry = typeof t.entryPrice === 'number' ? fmtUsdSep(t.entryPrice, priceDigits(t.entryPrice)) : '—';
  const cur = typeof t.currentPrice === 'number' ? fmtUsdSep(t.currentPrice, priceDigits(t.currentPrice)) : '—';
  return (
    <div>
      <div style={{ display:'flex', alignItems:'center', gap:4 }}>
        <img src="/naemu2.png" alt="" style={{ width: 24, height: 24 }} />
        <img src={iconPathForSymbolLower(base.toLowerCase())} alt="" style={{ width: base==='ETH'?16:14, height: base==='ETH'?16:14 }} />
        <span>Open: {base}</span>
      </div>
      <div>Entry: {entry} → {cur}</div>
      <div>Quantity: {qty}</div>
    </div>
  );
})}
```

Thoughts shows human style summaries of status and decisions with timestamps, no extra headings or styling beyond body text. Readme explains the agent and includes the Qwen logo.

### Chart pane

The equity chart is drawn on canvas and uses theme variables for colors. Hover shows a small label with the NAEMU icon, value, and time.

```tsx
<div ref={labelRef} style={{ position: 'absolute', pointerEvents: 'none', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
  <img src="/naemu2.png" alt="" style={{ width: 28, height: 28 }} />
  <span data-val>$0</span>
  <span data-time></span>
  </div>
```

## Theme

The site uses CSS variables with a data attribute on the html tag. A small inline script sets the theme early and a toggle switches it at runtime. The default is dark. Icons switch between sun and moon. The price bar uses a visible divider to match the dark surface.

## Deploy

Frontend

1. Build

```bash
npx opennextjs-cloudflare build -c wrangler.jsonc --openNextConfigPath open-next.config.ts
```

2. Deploy

```bash
npx wrangler deploy --config wrangler.jsonc
```

API

1. Set secrets on the worker named naemu-api

```text
QWEN_API_KEY
QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
ASTER_API_BASE
ASTER_API_KEY
ASTER_API_SECRET
ADMIN_KEY
```

2. Deploy

```bash
npx wrangler deploy --config api-worker/wrangler.toml
```

Verify

```bash
curl https://api.naemu.com/api/vibe/status
curl -X POST https://api.naemu.com/api/vibe/tick
```


