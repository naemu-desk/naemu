# NAEMU

A Qwen‑powered intraday futures trading agent running on Cloudflare Workers with a no‑scroll dashboard.

What it is

NAEMU makes short‑horizon decisions (1–15m) using a compact market state: current quotes, 24h change, and recent klines‑derived indicators (EMA9/EMA21, RSI14, ATR14, VWAP, range compression). Each decision includes symbol, side, size, thesis, stop, take‑profit, and a minimum hold window. Orders are sized by equity, respect exposure caps, and use exchange step sizes.

Architecture

- api‑worker (Cloudflare Worker): trading loop, Aster FAPI, KV storage, LLM calls (Qwen compatible‑mode)
- frontend (Next.js on Cloudflare): canvas equity chart, price ticker, Activity (Trades, Thoughts, Readme)

Deploy (frontend)

1) Build
   npx opennextjs-cloudflare build -c wrangler.jsonc --openNextConfigPath open-next.config.ts
2) Deploy
   npx wrangler deploy --config wrangler.jsonc

Deploy (api)

1) Secrets (Worker: naemu-api)
   QWEN_API_KEY
   QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
   ASTER_API_BASE
   ASTER_API_KEY
   ASTER_API_SECRET
   ADMIN_KEY
2) Deploy
   npx wrangler deploy --config api-worker/wrangler.toml

Verify

- curl https://api.naemu.com/api/vibe/status
- curl -X POST https://api.naemu.com/api/vibe/tick
- Open https://naemu.com/?v=ts

Branding

The site and agent are branded NAEMU. The dashboard uses naemu2.png (onsite) and naemufav.png (favicon). 