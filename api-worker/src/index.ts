import { keccak_256 } from 'js-sha3';
import * as secp from '@noble/secp256k1';

export interface Env {
  MEAP_KV: KVNamespace;
  OPENAI_API_KEY?: string;
  ASTER_PRIVATE_KEY?: string;
  ASTER_API_BASE?: string;
  ADMIN_KEY?: string;
  QWEN_API_KEY?: string;
  QWEN_BASE_URL?: string; // default: https://dashscope.aliyuncs.com/compatible-mode/v1
}

function cors(headers: Record<string, string> = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...headers,
  };
}

// ---------- Aster signing helpers ----------
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function evmAddressFromPrivateKey(privHex: string): `0x${string}` {
  const priv = privHex.startsWith('0x') ? privHex.slice(2) : privHex;
  const pub = secp.getPublicKey(priv, false); // uncompressed 65 bytes, 0x04 + X(32) + Y(32)
  const pubNoPrefix = pub.slice(1);
  const hashHex = keccak_256(pubNoPrefix); // hex
  const addr = '0x' + hashHex.slice(-40);
  return addr as `0x${string}`;
}

async function personalSign(privHex: string, message: string): Promise<string> {
  const msgBytes = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const prefixed = new Uint8Array(prefix.length + msgBytes.length);
  prefixed.set(prefix, 0);
  prefixed.set(msgBytes, prefix.length);
  const digestHex = keccak_256(prefixed);
  const digest = hexToBytes('0x' + digestHex);
  const [sig, recId] = await secp.sign(digest, privHex.startsWith('0x') ? privHex.slice(2) : privHex, { recovered: true, der: false });
  const v = 27 + recId;
  const full = new Uint8Array(65);
  full.set(sig, 0);
  full[64] = v;
  return bytesToHex(full);
}

async function asterRequest(env: Env, method: string, path: string, body?: any): Promise<Response> {
  const base = (env.ASTER_API_BASE || '').trim().replace(/\/+$/, '');
  const priv = env.ASTER_PRIVATE_KEY || '';
  if (!base) throw new Error('ASTER base missing');
  const addr = priv ? evmAddressFromPrivateKey(priv) : (undefined as any);
  const ts = Math.floor(Date.now() / 1000); // seconds
  const m = method.toUpperCase();
  const p = path.startsWith('/') ? path : `/${path}`;
  const bodyText = body === undefined || body === null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
  const bodySha256 = await sha256Hex(bodyText);
  const canonical = `${ts}\n${m}\n${p}\n${bodySha256}`;
  // Helper to send one request with given url path
  const send = async (urlPath: string, headers: Record<string,string>): Promise<Response> => {
    return fetch(`${base}${urlPath}`, { method: m, headers, body: bodyText || undefined });
  };

  // Try EVM-sign first if wallet key is present
  if (priv) {
    try {
      const sig = await personalSign(priv, canonical);
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-aster-address': addr,
        'x-aster-timestamp': String(ts),
        'x-aster-signature': sig,
      };
      // try primary path
      let r = await send(p, headers);
      if (r.ok || r.status !== 404) return r;
      // try common variants if 404
      // /v1/futures/X -> /fapi/v1/X
      const alt1 = p.startsWith('/v1/futures') ? '/fapi' + p.replace('/v1/futures', '/v1') : null;
      if (alt1) { r = await send(alt1, headers); if (r.ok || r.status !== 404) return r; }
      // /v1/futures/X -> /api/v1/futures/X
      const alt2 = p.startsWith('/v1') ? '/api' + p : null;
      if (alt2) { r = await send(alt2, headers); if (r.ok || r.status !== 404) return r; }
      // positions specific fallbacks
      if (p.includes('/positions')) {
        const alt3 = '/fapi/v1/positionRisk';
        r = await send(alt3, headers); if (r.ok || r.status !== 404) return r;
        const alt4 = '/fapi/v2/positionRisk';
        r = await send(alt4, headers); if (r.ok || r.status !== 404) return r;
      }
      // account specific fallback
      if (p.includes('/account')) {
        const alt5 = '/fapi/v1/account';
        r = await send(alt5, headers); if (r.ok || r.status !== 404) return r;
      }
      // if API key exists, fall through to API-key auth
      if (!env.ASTER_API_KEY || !env.ASTER_API_SECRET) return r;
      // fall through to API-key if provided
    } catch {}
  }
  // API-key fallback if configured
  if (env.ASTER_API_KEY && env.ASTER_API_SECRET) {
    const apiKey = env.ASTER_API_KEY;
    const apiSecret = env.ASTER_API_SECRET;
    const sigApi = await hmacHex('SHA-256', apiSecret, canonical);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-aster-key': apiKey,
      'x-aster-timestamp': String(ts),
      'x-aster-signature': sigApi,
    };
    // try primary path
    let r = await send(p, headers);
    if (r.ok || r.status !== 404) return r;
    // try common variants if 404
    const alt1 = p.startsWith('/v1/futures') ? '/fapi' + p.replace('/v1/futures', '/v1') : null;
    if (alt1) { r = await send(alt1, headers); if (r.ok || r.status !== 404) return r; }
    const alt2 = p.startsWith('/v1') ? '/api' + p : null;
    if (alt2) { r = await send(alt2, headers); if (r.ok || r.status !== 404) return r; }
    if (p.includes('/positions')) {
      const alt3 = '/fapi/v1/positionRisk';
      r = await send(alt3, headers); if (r.ok || r.status !== 404) return r;
      const alt4 = '/fapi/v2/positionRisk';
      r = await send(alt4, headers); if (r.ok || r.status !== 404) return r;
    }
    if (p.includes('/account')) {
      const alt5 = '/fapi/v1/account';
      r = await send(alt5, headers); if (r.ok || r.status !== 404) return r;
    }
    return r;
  }
  // If nothing configured, return a 400-like Response
  return new Response('ASTER auth not configured', { status: 400 });
}

async function hmacHex(alg: 'SHA-256', secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: alg }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function asterFapiGetJson(env: Env, path: string): Promise<any | null> {
  const base = (env.ASTER_API_BASE || '').trim().replace(/\/+$/, '');
  const apiKey = env.ASTER_API_KEY;
  const apiSecret = env.ASTER_API_SECRET;
  if (!base || !apiKey || !apiSecret) return null;
  const ts = Date.now(); // ms per Binance spec
  const recv = 5000;
  const query = `timestamp=${ts}&recvWindow=${recv}`;
  const sig = await hmacHex('SHA-256', apiSecret, query);
  const url = `${base}${path}?${query}&signature=${sig}`;
  const r = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

async function asterFapiGetPublicJson(env: Env, pathWithQuery: string): Promise<any | null> {
  const base = (env.ASTER_API_BASE || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  const r = await fetch(`${base}${pathWithQuery}`);
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

// ---------- Indicators ----------
function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

function rsi(values: number[], period = 14): number[] {
  const out: number[] = Array(values.length).fill(NaN);
  if (values.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gains += ch; else losses -= ch;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }
  return out;
}

async function asterFapiSignedPost(env: Env, path: string, params: Record<string, string | number>): Promise<Response> {
  const base = (env.ASTER_API_BASE || '').trim().replace(/\/+$/, '');
  const apiKey = env.ASTER_API_KEY;
  const apiSecret = env.ASTER_API_SECRET;
  if (!base || !apiKey || !apiSecret) return new Response('ASTER_API_BASE/API_KEY/API_SECRET missing', { status: 400 });
  const ts = Date.now();
  const recv = 5000;
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qp.append(k, String(v));
  qp.append('timestamp', String(ts));
  qp.append('recvWindow', String(recv));
  const sig = await hmacHex('SHA-256', apiSecret, qp.toString());
  qp.append('signature', sig);
  const url = `${base}${path}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey, 'content-type': 'application/x-www-form-urlencoded' },
    body: qp.toString()
  });
}

async function handleDebug(req: Request, env: Env) {
  const info: any = { ok: true };
  info.hasEnv = !!env.MEAP_KV;
  if (env.MEAP_KV) {
    try {
      const data = await env.MEAP_KV.get(new URL('/__events.json', req.url).toString(), { type: 'json' });
      info.kvReadable = true;
      info.eventsCount = Array.isArray(data) ? data.length : 0;
    } catch (e: any) {
      info.kvReadable = false;
      info.error = String(e?.message || e);
    }
  } else {
    info.message = 'KV binding not found in worker environment';
  }
  return new Response(JSON.stringify(info, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleEvents(req: Request, env: Env) {
  const key = new URL('/__events.json', req.url).toString();
  const data = (await env.MEAP_KV.get(key, { type: 'json' })) || [];
  return new Response(JSON.stringify({ events: data.slice(-200).reverse() }), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleAgentsGet(req: Request, env: Env) {
  const key = new URL('/__agents.json', req.url).toString();
  const data = (await env.MEAP_KV.get(key, { type: 'json' })) || [];
  return new Response(JSON.stringify({ agents: (data as any[]).slice(-100).reverse() }), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleAgentsPost(req: Request, env: Env) {
  const url = new URL(req.url);
  const keyAgents = new URL('/__agents.json', url).toString();
  const keyEvents = new URL('/__events.json', url).toString();
  const body: any = await req.json().catch(() => ({}));
  const owner = body?.owner;
  if (!owner || owner === '0x0000') {
    return new Response(JSON.stringify({ error: 'wallet_required' }), {
      status: 400,
      headers: cors({ 'Content-Type': 'application/json' })
    });
  }
  const list = ((await env.MEAP_KV.get(keyAgents, { type: 'json' })) as any[]) || [];
  // one agent per wallet: return 409 if exists
  const existing = list.find((a: any) => a?.owner?.toLowerCase?.() === owner?.toLowerCase?.());
  if (existing) {
    return new Response(JSON.stringify({ error: 'exists', agent: existing }), {
      status: 409,
      headers: cors({ 'Content-Type': 'application/json' })
    });
  }
  const agent = { id: `agent_${Date.now()}`, owner, createdAt: Date.now(), webhookUrl: body?.webhookUrl || null, hmacSecret: body?.hmacSecret || null };
  list.push(agent);
  await env.MEAP_KV.put(keyAgents, JSON.stringify(list));
  const events = ((await env.MEAP_KV.get(keyEvents, { type: 'json' })) as any[]) || [];
  events.push({ type: 'agent_created', at: Date.now(), owner, id: agent.id });
  await env.MEAP_KV.put(keyEvents, JSON.stringify(events));
  return new Response(JSON.stringify(agent), { headers: cors({ 'Content-Type': 'application/json' }), status: 201 });
}

async function handleMessage(req: Request, env: Env) {
  const url = new URL(req.url);
  const keyEvents = new URL('/__events.json', url).toString();
  const body: any = await req.json().catch(() => ({}));
  const from = body?.from || 'anon';
  const to = body?.to || 'any-agent';
  const resp = { id: `msg_${Date.now()}`, type: 'Response', from: to, to: from, payload: { ok: true, echo: body?.payload ?? null }, timestamp: new Date().toISOString() };
  const events = ((await env.MEAP_KV.get(keyEvents, { type: 'json' })) as any[]) || [];
  const kind = body?.payload?.kind;
  if (kind === 'onchain_register') {
    events.push({ type: 'onchain_register', at: Date.now(), owner: from, agentId: body?.payload?.agentId, tx: body?.payload?.tx, chain: body?.payload?.chain || 'bsc' });
  } else if (kind === 'onchain_tip') {
    events.push({ type: 'onchain_tip', at: Date.now(), tipper: from, owner: body?.payload?.owner || to, agentId: body?.payload?.agentId, amount: body?.payload?.amount, tx: body?.payload?.tx, chain: body?.payload?.chain || 'bsc' });
  } else {
    // generic message
    events.push({ type: 'message', at: Date.now(), from, to, id: resp.id });
    // also place in recipient inbox
    const keyInbox = new URL(`/inbox_${to}.json`, url).toString();
    const inbox = ((await env.MEAP_KV.get(keyInbox, { type: 'json' })) as any[]) || [];
    inbox.push({ id: resp.id, from, to, at: Date.now(), payload: body?.payload ?? null });
    await env.MEAP_KV.put(keyInbox, JSON.stringify(inbox));

    // webhook delivery if receiver has webhookUrl
    try {
      const keyAgents = new URL('/__agents.json', url).toString();
      const agents = ((await env.MEAP_KV.get(keyAgents, { type: 'json' })) as any[]) || [];
      const agent = agents.find((a: any) => a?.id === to);
      if (agent?.webhookUrl) {
        const payload = { id: resp.id, from, to, at: Date.now(), payload: body?.payload ?? null };
        const headers: Record<string,string> = { 'content-type': 'application/json' };
        // simple HMAC using crypto.subtle if secret provided
        if (agent.hmacSecret) {
          const key = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(agent.hmacSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
          );
          const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(payload)));
          const sigHex = Array.from(new Uint8Array(sigBuf)).map(b=>b.toString(16).padStart(2,'0')).join('');
          headers['x-meap-signature'] = `sha256=${sigHex}`;
        }
        const r = await fetch(agent.webhookUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
        const reply = await r.json().catch(()=>null);
        if (reply?.reply) {
          const outId = `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          const out = { id: outId, from: to, to: from, at: Date.now(), payload: reply.reply };
          // store reply to sender inbox and global events
          const keyInboxFrom = new URL(`/inbox_${from}.json`, url).toString();
          const fromInbox = ((await env.MEAP_KV.get(keyInboxFrom, { type: 'json' })) as any[]) || [];
          fromInbox.push(out);
          await env.MEAP_KV.put(keyInboxFrom, JSON.stringify(fromInbox));
          events.push({ type: 'message', at: Date.now(), from: to, to: from, id: out.id });
        }
      }
    } catch {}
  }
  await env.MEAP_KV.put(keyEvents, JSON.stringify(events));
  return new Response(JSON.stringify(resp), { headers: cors({ 'Content-Type': 'application/json' }) });
}

// ---------------- VIBE TRADER (Aster + Qwen) ----------------
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

type VibeRuntime = {
  lastTickAt?: number;
  sessionLossUsd?: number;
  lastError?: string | null;
  lastProvider?: 'qwen' | undefined;
  lastModel?: string | undefined;
  lastOrderAt?: number | undefined;
  lastSignal?: 'LONG' | 'SHORT' | 'FLAT' | undefined;
};

const DEFAULT_VIBE_CONFIG: VibeConfig = {
  status: 'running',
  universe: ['BTCUSDT','ETHUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','SOLUSDT','ASTERUSDT','CAKEUSDT','ZORAUSDT','PUMPUSDT','ZECUSDT'],
  maxRiskPerTradeUsd: 500, // increased default risk cap
  maxDailyLossUsd: 2000,
  maxExposureUsd: 10000,
  leverageCap: 5,
  marginMode: 'cross',
  model: 'qwen2.5-32b-instruct'
};

async function kvGetJson<T>(env: Env, url: URL, key: string, fallback: T): Promise<T> {
  const fullKey = new URL(key, url).toString();
  const data = await env.MEAP_KV.get(fullKey, { type: 'json' });
  return (data as T) ?? fallback;
}

async function kvPutJson(env: Env, url: URL, key: string, value: any): Promise<void> {
  const fullKey = new URL(key, url).toString();
  await env.MEAP_KV.put(fullKey, JSON.stringify(value));
}

async function appendLog(env: Env, url: URL, entry: any) {
  const logs: any[] = await kvGetJson(env, url, '/vibe_logs.json', []);
  logs.push({ at: Date.now(), ...entry });
  if (logs.length > 500) logs.splice(0, logs.length - 500);
  await kvPutJson(env, url, '/vibe_logs.json', logs);
}

// ----- Trades persistence for UI Completed Trades -----
type OpenTrade = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  notionalEntry: number;
  openedAt: number;
  provider?: string;
  model?: string;
  // thesis-driven fields
  stopLoss?: number; // absolute price
  takeProfit?: number; // absolute price
  minHoldMs?: number; // minimum hold duration
  thesis?: string; // human-readable thesis
};

type ClosedTrade = {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  exitPrice: number;
  notionalEntry: number;
  notionalExit: number;
  openedAt: number;
  closedAt: number;
  holdingMs: number;
  pnlUsd: number;
  provider?: string;
  model?: string;
  thesis?: string;
};

async function getOpenTrades(env: Env, url: URL): Promise<Record<string, OpenTrade>> {
  return (await kvGetJson<Record<string, OpenTrade>>(env, url, '/vibe_open_trades.json', {})) || {};
}

async function setOpenTrades(env: Env, url: URL, map: Record<string, OpenTrade>) {
  await kvPutJson(env, url, '/vibe_open_trades.json', map);
}

async function appendClosedTrade(env: Env, url: URL, trade: ClosedTrade) {
  const list = await kvGetJson<ClosedTrade[]>(env, url, '/vibe_trades.json', []);
  list.push(trade);
  if (list.length > 200) list.splice(0, list.length - 200);
  await kvPutJson(env, url, '/vibe_trades.json', list);
}

async function handleVibeStatus(req: Request, env: Env) {
  const url = new URL(req.url);
  const cfg = await kvGetJson<VibeConfig>(env, url, '/vibe_config.json', DEFAULT_VIBE_CONFIG);
  const rt = await kvGetJson<VibeRuntime>(env, url, '/vibe_runtime.json', {} as VibeRuntime);
  return new Response(JSON.stringify({ ok: true, config: cfg, runtime: rt }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleVibeRun(req: Request, env: Env) {
  const url = new URL(req.url);
  // lock behind admin secret
  const admin = env.ADMIN_KEY;
  const key = req.headers.get('x-admin-key') || '';
  if (!admin || key !== admin) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: cors({ 'Content-Type': 'application/json' }) });
  }
  const body: any = await req.json().catch(() => ({}));
  const cfg = await kvGetJson<VibeConfig>(env, url, '/vibe_config.json', DEFAULT_VIBE_CONFIG);
  const next: VibeConfig = {
    ...cfg,
    status: 'running',
    universe: Array.isArray(body?.universe) && body.universe.length ? body.universe : cfg.universe,
    maxRiskPerTradeUsd: Number(body?.maxRiskPerTradeUsd ?? cfg.maxRiskPerTradeUsd),
    maxDailyLossUsd: Number(body?.maxDailyLossUsd ?? cfg.maxDailyLossUsd),
    maxExposureUsd: Number(body?.maxExposureUsd ?? cfg.maxExposureUsd),
    leverageCap: Number(body?.leverageCap ?? cfg.leverageCap),
    marginMode: body?.marginMode === 'isolated' ? 'isolated' : 'cross',
    model: typeof body?.model === 'string' && body.model ? body.model : cfg.model
  };
  await kvPutJson(env, url, '/vibe_config.json', next);
  await appendLog(env, url, { type: 'vibe_status', status: 'running' });
  return new Response(JSON.stringify({ ok: true, config: next }), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleVibeStop(req: Request, env: Env) {
  const url = new URL(req.url);
  // lock behind admin secret
  const admin = env.ADMIN_KEY;
  const key = req.headers.get('x-admin-key') || '';
  if (!admin || key !== admin) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: cors({ 'Content-Type': 'application/json' }) });
  }
  const cfg = await kvGetJson<VibeConfig>(env, url, '/vibe_config.json', DEFAULT_VIBE_CONFIG);
  const next: VibeConfig = { ...cfg, status: 'stopped' };
  await kvPutJson(env, url, '/vibe_config.json', next);
  await appendLog(env, url, { type: 'vibe_status', status: 'stopped' });
  return new Response(JSON.stringify({ ok: true, config: next }), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function callLLMDecider(env: Env, state: any, cfg: VibeConfig): Promise<any> {
  // Qwen-only
  const apiKey = env.QWEN_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY missing');
  const baseUrl = (env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/$/, '');
  let model = cfg.model || 'qwen3-max';
  const sys = `You are an intraday futures trading decider focused strictly on 1–15 minute horizons.
Use short‑term orderflow/price-action context. You are given per-symbol indicators: ema9, ema21, rsi14, atr14, vwap, rangePct, plus prices and change24h.
All numeric levels you output must be anchored near current price (~0.5%–3% typical). If no clear edge, choose FLAT.
Output strict JSON with keys:
- action: one of LONG, SHORT, FLAT
- symbol: one of ${cfg.universe.join(', ')}
- size_usd: number (<= maxRiskPerTradeUsd=${cfg.maxRiskPerTradeUsd}, and reasonable vs equity)
- thesis: concise short‑term setup
- stop_loss_price: number (hard invalidation near entry)
- take_profit_price: number (near‑term target)
- min_hold_minutes: number between 10 and 180
Respect risk limits: maxRiskPerTradeUsd=${cfg.maxRiskPerTradeUsd}, maxExposureUsd=${cfg.maxExposureUsd}.`;
  const user = { role: 'user', content: `State: ${JSON.stringify(state).slice(0, 9000)}` } as const;
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [ { role: 'system', content: sys }, user ]
    })
  });
  if (!r.ok) throw new Error(`llm_http_${r.status}`);
  const data: any = await r.json();
  const content = data?.choices?.[0]?.message?.content || '{}';
  let parsed: any = {};
  try { parsed = JSON.parse(content); } catch {}
  return { parsed, meta: { provider: 'qwen', model, sys, stateSummary: { equityUsd: state?.balances?.equityUsd, positionsCount: state?.positions?.length ?? 0 } } };
}

async function vibeTick(env: Env, url: URL, ignoreStatus: boolean = false) {
  const cfg = await kvGetJson<VibeConfig>(env, url, '/vibe_config.json', DEFAULT_VIBE_CONFIG);
  const rt = await kvGetJson<VibeRuntime>(env, url, '/vibe_runtime.json', {} as VibeRuntime);
  const eventsKey = new URL('/__events.json', url).toString();
  const events = ((await env.MEAP_KV.get(eventsKey, { type: 'json' })) as any[]) || [];
  if (cfg.status !== 'running' && !ignoreStatus) return { skipped: 'stopped' };

  // Pull account available balance for equity sampling
  let availableBalance = 0;
  let equityUsd = 0;
  try {
    const acct = await asterFapiGetJson(env, '/fapi/v2/account');
    availableBalance = Number(acct?.availableBalance || '0');
    const wallet = Number(acct?.totalWalletBalance || acct?.totalMarginBalance || 0);
    const unrl = Number(acct?.totalUnrealizedProfit || 0);
    equityUsd = Number.isFinite(wallet + unrl) ? wallet + unrl : availableBalance;
  } catch {}
  // Store baseline initial equity once
  try {
    const initKey = new URL('/vibe_initial_equity.json', url).toString();
    const init = await env.MEAP_KV.get(initKey, { type: 'json' });
    if (!init && equityUsd > 0) {
      await env.MEAP_KV.put(initKey, JSON.stringify({ at: Date.now(), equityUsd }));
    }
  } catch {}
  // Include current prices and 24h stats for intraday reasoning
  const prices: Record<string, number> = {};
  const change24h: Record<string, number> = {};
  try {
    const [priceArr, stats24] = await Promise.all([
      Promise.all((cfg.universe || []).map(sym => asterFapiGetPublicJson(env, `/fapi/v1/ticker/price?symbol=${sym}`))),
      asterFapiGetPublicJson(env, '/fapi/v1/ticker/24hr')
    ]);
    for (let i = 0; i < (cfg.universe || []).length; i++) {
      const sym = cfg.universe[i];
      const p = Number((priceArr[i] as any)?.price || 0);
      if (p > 0 && Number.isFinite(p)) prices[sym] = p;
    }
    if (Array.isArray(stats24)) {
      for (const s of stats24) {
        const sym = String(s?.symbol || '');
        if (!sym) continue;
        if (!cfg.universe.includes(sym)) continue;
        const pct = Number(s?.priceChangePercent ?? s?.P ?? 0);
        if (Number.isFinite(pct)) change24h[sym] = pct;
      }
    }
  } catch {}

  // Indicators per symbol (lightweight 1m window)
  const indicators: Record<string, any> = {};
  try {
    const klAll = await Promise.all((cfg.universe || []).map(sym => fetchKlines(env, sym, '1m', 120)));
    for (let i = 0; i < (cfg.universe || []).length; i++) {
      const sym = cfg.universe[i];
      const kl = klAll[i] as any[];
      if (!Array.isArray(kl)) continue;
      indicators[sym] = computeIndicatorsFromKlines(kl);
    }
  } catch {}
  const state = { balances: { equityUsd }, positions: [], universe: cfg.universe, prices, change24h, indicators };

  // Enforce SL/TP and min-hold on existing open trades before making a new decision
  try {
    const openMap = await getOpenTrades(env, url);
    const syms = Object.keys(openMap);
    for (const sym of syms) {
      const t = openMap[sym];
      const now = Date.now();
      const minHoldOk = typeof (t as any).minHoldMs === 'number' ? now - t.openedAt >= (t as any).minHoldMs : true;
      const tick = await asterFapiGetPublicJson(env, `/fapi/v1/ticker/price?symbol=${sym}`);
      const price = Number(tick?.price || 0);
      if (!price || !Number.isFinite(price)) continue;
      let shouldClose = false;
      let reason = '';
      if (minHoldOk) {
        if (typeof (t as any).takeProfit === 'number') {
          if ((t.side === 'LONG' && price >= (t as any).takeProfit) || (t.side === 'SHORT' && price <= (t as any).takeProfit)) {
            shouldClose = true; reason = 'Take-profit hit';
          }
        }
        if (!shouldClose && typeof (t as any).stopLoss === 'number') {
          if ((t.side === 'LONG' && price <= (t as any).stopLoss) || (t.side === 'SHORT' && price >= (t as any).stopLoss)) {
            shouldClose = true; reason = 'Stop-loss hit';
          }
        }
      }
      if (shouldClose) {
        const side = t.side === 'LONG' ? 'SELL' : 'BUY';
        const r = await asterFapiSignedPost(env, '/fapi/v1/order', { symbol: sym, side, type: 'MARKET', quantity: t.qty, reduceOnly: 'true' });
        const txt = await r.text();
        const body = (() => { try { return JSON.parse(txt); } catch { return { raw: txt }; } })();
        await appendLog(env, url, { type: 'vibe_order', status: r.status, ok: r.ok, symbol: sym, side, qty: t.qty, notional: Math.abs(t.qty * price), reason, body });
        if (r.ok) {
          const pnlUsd = t.side === 'LONG' ? (price - t.entryPrice) * t.qty : (t.entryPrice - price) * t.qty;
          const closed: ClosedTrade = {
            symbol: sym,
            side: t.side,
            qty: t.qty,
            entryPrice: t.entryPrice,
            exitPrice: price,
            notionalEntry: t.notionalEntry,
            notionalExit: Math.abs(t.qty * price),
            openedAt: t.openedAt,
            closedAt: now,
            holdingMs: Math.max(0, now - t.openedAt),
            pnlUsd,
            provider: t.provider,
            model: t.model,
            thesis: (t as any).thesis
          };
          await appendClosedTrade(env, url, closed);
          delete openMap[sym];
          await setOpenTrades(env, url, openMap);
        }
      }
    }
  } catch {}

  try {
    // LLM-only decision
    const syms = cfg.universe;
    let selectedAction: 'LONG' | 'SHORT' | 'FLAT' = 'FLAT';
    let selectedSymbol = syms[0];
    let meta: any = { provider: 'qwen', model: cfg.model, sys: 'llm' };
    const llm = await callLLMDecider(env, state, cfg);
    meta = { ...llm.meta };
    if (typeof llm.parsed?.thesis === 'string') meta.thesis = llm.parsed.thesis;
    if (typeof llm.parsed?.stop_loss_price === 'number') meta.stopLoss = llm.parsed.stop_loss_price;
    if (typeof llm.parsed?.take_profit_price === 'number') meta.takeProfit = llm.parsed.take_profit_price;
    if (typeof llm.parsed?.min_hold_minutes === 'number') meta.minHoldMs = Math.max(0, Math.floor(llm.parsed.min_hold_minutes * 60 * 1000));
    await appendLog(env, url, { type: 'vibe_prompt', provider: meta.provider, model: meta.model, sys: meta.sys, state: { equityUsd: state.balances.equityUsd, positionsCount: state.positions.length } });
    selectedSymbol = typeof llm.parsed?.symbol === 'string' && cfg.universe.includes(llm.parsed.symbol) ? llm.parsed.symbol : cfg.universe[0];
    selectedAction = (['LONG','SHORT','FLAT'].includes(llm.parsed?.action) ? llm.parsed.action : 'FLAT') as any;
    // Size clamp: target 10% of equity up to maxRiskPerTradeUsd
    // take larger trades (20% of equity) but still respect config caps
    const targetRisk = Math.max(0, Math.floor((state.balances?.equityUsd || availableBalance) * 0.20));
    const sizeUsd = Math.min(cfg.maxRiskPerTradeUsd, targetRisk);

    // Log decision or status (hide repetitive FLAT by converting into status summary)
    let lastOutput: any = null;
    if (selectedAction === 'FLAT') {
      try {
        const open = await getOpenTrades(env, url);
        const posList = Object.entries(open);
        type Enriched = { sym: string; base: string; side: 'LONG'|'SHORT'; qty: number; entry: number; now: number|null; uPnL: number|null; tp?: number; sl?: number; minHoldLeftMin?: number };
        const enriched: Enriched[] = [];
        let unrealized = 0;
        for (const [sym, t] of posList) {
          const tick = await asterFapiGetPublicJson(env, `/fapi/v1/ticker/price?symbol=${sym}`);
          const price = Number((tick as any)?.price || 0) || null;
          const pnl = price ? (t.side === 'LONG' ? (price - t.entryPrice) * t.qty : (t.entryPrice - price) * t.qty) : null;
          if (pnl !== null) unrealized += pnl;
          let minHoldLeftMin: number|undefined;
          if (typeof (t as any).minHoldMs === 'number') {
            const left = (t as any).minHoldMs - (Date.now() - t.openedAt);
            if (left > 0) minHoldLeftMin = Math.ceil(left / 60000);
          }
          enriched.push({
            sym,
            base: sym.replace('USDT',''),
            side: t.side,
            qty: t.qty,
            entry: t.entryPrice,
            now: price,
            uPnL: pnl,
            tp: (t as any).takeProfit,
            sl: (t as any).stopLoss,
            minHoldLeftMin
          });
        }
        // Performance vs initial equity
        let perfPct = 0;
        try {
          const init = await env.MEAP_KV.get(new URL('/vibe_initial_equity.json', url).toString(), { type: 'json' }) as any;
          const initEq = Number(init?.equityUsd || 0);
          if (initEq > 0 && equityUsd > 0) perfPct = ((equityUsd - initEq) / initEq) * 100;
        } catch {}
        const dirWord = perfPct >= 0 ? 'Up' : 'Down';
        const perfStr = `${dirWord} ${Math.abs(perfPct).toFixed(2)}%`;
        const cashStr = `$${Number(availableBalance || 0).toFixed(2)}`;

        // Biggest mover and nearest invalidation
        const withPnl = enriched.filter(e => typeof e.uPnL === 'number') as Required<Pick<Enriched,'sym'|'base'|'side'|'qty'|'entry'|'now'|'uPnL'|'tp'|'sl'>>[];
        const biggest = withPnl.length ? withPnl.reduce((a,b)=> Math.abs((a as any).uPnL) >= Math.abs((b as any).uPnL) ? a : b) : null;
        function pctDistTo(price: number|null, target?: number) {
          if (!price || typeof target !== 'number' || target <= 0) return null;
          return Math.abs((price - target) / price) * 100;
        }
        let nearest: any = null;
        for (const e of withPnl) {
          const toSl = pctDistTo(e.now, e.sl);
          const toTp = pctDistTo(e.now, e.tp);
          const cand = (toSl !== null && (nearest === null || (toSl as number) < nearest.dist)) ? { base: e.base, side: e.side, dist: toSl, kind: 'SL' } : null;
          if (cand && (nearest === null || cand.dist! < nearest.dist)) nearest = cand;
          const cand2 = (toTp !== null && (nearest === null || (toTp as number) < nearest.dist)) ? { base: e.base, side: e.side, dist: toTp, kind: 'TP' } : null;
          if (cand2 && (nearest === null || cand2.dist! < nearest.dist)) nearest = cand2;
        }

        // Compose primary line based on a rotating template
        const variant = Math.floor(Date.now() / 60000) % 3; // rotate each minute
        const openCount = enriched.length;
        let primary = '';
        if (openCount > 0) {
          const first = enriched[0];
          const entryStr = `$${first.entry.toFixed(first.entry >= 1 ? 2 : 4)}`;
          const nowStr = first.now ? `$${first.now.toFixed(first.now >= 1 ? 2 : 4)}` : '—';
          const qtyStr = Math.abs(first.qty).toFixed(4);
          const tpStr = typeof first.tp === 'number' ? `$${first.tp.toFixed(first.tp >= 1 ? 2 : 4)}` : '—';
          const slStr = typeof first.sl === 'number' ? `$${first.sl.toFixed(first.sl >= 1 ? 2 : 4)}` : '—';
          const uStr = typeof first.uPnL === 'number' ? `$${first.uPnL.toFixed(2)}` : '—';
          const holdStr = typeof first.minHoldLeftMin === 'number' ? `, ~${first.minHoldLeftMin}m min-hold left` : '';
          if (variant === 0) primary = `My capital is ${perfStr.toLowerCase()} to $${equityUsd.toFixed(0)}. I'm holding ${first.base} ${first.side.toLowerCase()} (${qtyStr}) with an unrealized ${uStr}. Plan: target ${tpStr}, stop ${slStr}${holdStr}.`;
          if (variant === 1) primary = `${perfStr} overall; keeping a ${first.side.toLowerCase()} on ${first.base} from ${entryStr} → ${nowStr}. Clear exit: TP ${tpStr}, SL ${slStr}${holdStr}.`;
          if (variant === 2) primary = `${perfStr} and steady. Core position is ${first.base} ${first.side.toLowerCase()} (${qtyStr}); unrealized ${uStr}. Will exit on ${slStr} or take profits near ${tpStr}.`;
        } else {
          primary = `${perfStr} to $${equityUsd.toFixed(0)} with ${cashStr} cash. No open positions; waiting for a clean short‑term setup.`;
        }

        const extraParts: string[] = [];
        if (biggest) extraParts.push(`Biggest mover: ${biggest.base} ${biggest.side.toLowerCase()} (${(biggest.uPnL as number)>=0?'+':''}$${(biggest.uPnL as number).toFixed(0)})`);
        if (nearest && typeof nearest.dist === 'number') extraParts.push(`Nearest ${nearest.kind} on ${nearest.base} ~${nearest.dist.toFixed(1)}%`);
        const extra = extraParts.length ? ` ${extraParts.join('. ')}.` : '';

        const thesisNote = typeof (meta as any)?.thesis === 'string' && (meta as any).thesis.trim() ? ` ${(meta as any).thesis.trim()}` : '';
        const summary = `${primary}${extra}${thesisNote}`.trim();

        // Novelty-based rate limiting
        const lastKey = new URL('/vibe_last_status.json', url).toString();
        const last = (await env.MEAP_KV.get(lastKey, { type: 'json' })) as any || {};
        const lastAt = Number(last.at || 0);
        const lastEq = Number(last.equityUsd || 0);
        const nowTs = Date.now();
        const eq = equityUsd;
        const pctMove = lastEq > 0 ? Math.abs((eq - lastEq) / lastEq) : 0;
        const recentWindow = 3 * 60 * 1000; // allow more frequent if unique
        const noveltyText = JSON.stringify({ summary, eq: eq.toFixed(2), cash: cashStr, openCount, biggest: biggest?.base, nearest: nearest?.base, variant });
        const noveltyHash = await sha256Hex(noveltyText);
        const hashes: string[] = Array.isArray(last.hashes) ? last.hashes : [];
        const isDuplicate = hashes.includes(noveltyHash);
        if (isDuplicate && nowTs - lastAt < recentWindow && pctMove < 0.003) {
          lastOutput = { type: 'vibe_status', skipped: true };
        } else {
          const statusLog: any = { type: 'vibe_status', equityUsd: eq, unrealizedUsd: Math.round(unrealized * 100) / 100, summary, note: '' };
          await appendLog(env, url, statusLog);
          events.push({ type: 'vibe_tick', at: nowTs, ...statusLog });
          await env.MEAP_KV.put(eventsKey, JSON.stringify(events));
          const nextHashes = [noveltyHash, ...hashes].slice(0, 12);
          await env.MEAP_KV.put(lastKey, JSON.stringify({ at: nowTs, equityUsd: eq, hashes: nextHashes }));
          lastOutput = statusLog;
        }
      } catch {}
    } else {
      const log = { type: 'vibe_decision', action: selectedAction, symbol: selectedSymbol, sizeUsd, notes: typeof (meta as any)?.thesis === 'string' ? (meta as any).thesis : '' };
      await appendLog(env, url, log);
      events.push({ type: 'vibe_tick', at: Date.now(), ...log });
      await env.MEAP_KV.put(eventsKey, JSON.stringify(events));
      lastOutput = log;
    }

    // Execute tiny live order if allowed and balances exist
    try {
      if ((selectedAction === 'LONG' || selectedAction === 'SHORT') && env.ASTER_API_SECRET) {
        const notional = sizeUsd;
        const now = Date.now();
        const coolOk = !rt.lastOrderAt || now - rt.lastOrderAt > 3 * 60 * 1000;
        if (coolOk && notional >= 5) {
          const priceJ = await asterFapiGetPublicJson(env, `/fapi/v1/ticker/price?symbol=${selectedSymbol}`);
          const price = Number(priceJ?.price || 0);
          if (price > 0) {
            // stepSize-aware qty rounding
            let qtyRaw = notional / price;
            let qty = Math.max(0.0001, qtyRaw);
            try {
              const info = await getExchangeInfo(env);
              const { step, minNotional } = stepSizeForSymbol(info, selectedSymbol);
              const steps = Math.max(1, Math.floor(qty / step));
              qty = steps * step;
              if (minNotional && qty * price < minNotional) {
                const needQty = Math.ceil(minNotional / price / step) * step;
                qty = Math.max(qty, needQty);
              }
            } catch {}
            const side = selectedAction === 'LONG' ? 'BUY' : 'SELL';
            const r = await asterFapiSignedPost(env, '/fapi/v1/order', { symbol: selectedSymbol, side, type: 'MARKET', quantity: qty });
            const txt = await r.text();
            const body = (() => { try { return JSON.parse(txt); } catch { return { raw: txt }; } })();
            await appendLog(env, url, { type: 'vibe_order', status: r.status, ok: r.ok, symbol: selectedSymbol, side, qty, notional, body, reason: meta?.thesis || '' });
            if (r.ok) {
              rt.lastOrderAt = now;
              rt.lastSignal = selectedAction;
              // Trades UI tracking: close opposite, then open new snapshot
              try {
                const open = await getOpenTrades(env, url);
                const existing = open[selectedSymbol];
                if (existing) {
                  const notionalExit = Math.abs(existing.qty * price);
                  const pnlUsd = existing.side === 'LONG' ? (price - existing.entryPrice) * existing.qty : (existing.entryPrice - price) * existing.qty;
                  await appendClosedTrade(env, url, {
                    symbol: selectedSymbol,
                    side: existing.side,
                    qty: existing.qty,
                    entryPrice: existing.entryPrice,
                    exitPrice: price,
                    notionalEntry: existing.notionalEntry,
                    notionalExit,
                    openedAt: existing.openedAt,
                    closedAt: now,
                    holdingMs: Math.max(0, now - existing.openedAt),
                    pnlUsd,
                    provider: meta.provider,
                    model: meta.model,
                    thesis: (existing as any).thesis
                  });
                }
                open[selectedSymbol] = {
                  symbol: selectedSymbol,
                  side: selectedAction,
                  qty,
                  entryPrice: price,
                  notionalEntry: Math.abs(qty * price),
                  openedAt: now,
                  provider: meta.provider,
                  model: meta.model,
                  thesis: meta?.thesis,
                  stopLoss: typeof meta?.stopLoss === 'number' ? meta.stopLoss : undefined,
                  takeProfit: typeof meta?.takeProfit === 'number' ? meta.takeProfit : undefined,
                  minHoldMs: typeof meta?.minHoldMs === 'number' ? meta.minHoldMs : undefined
                };
                await setOpenTrades(env, url, open);
              } catch {}
            }
          }
        }
      }
    } catch (e: any) {
      await appendLog(env, url, { type: 'vibe_order_error', error: String(e?.message || e) });
    }

    // equity history sample
    try {
      const equity: any[] = await kvGetJson(env, url, '/vibe_equity.json', []);
      equity.push({ at: Date.now(), equityUsd: state.balances.equityUsd });
      if (equity.length > 1440) equity.splice(0, equity.length - 1440);
      await kvPutJson(env, url, '/vibe_equity.json', equity);
    } catch {}

    // positions snapshot (read-only for now; will be replaced with Aster response)
    try {
      await kvPutJson(env, url, '/vibe_positions.json', { positions: state.positions });
    } catch {}

    const nextRt: VibeRuntime = { ...rt, lastTickAt: Date.now(), lastError: null, lastProvider: meta.provider, lastModel: meta.model };
    await kvPutJson(env, url, '/vibe_runtime.json', nextRt);
    return { ok: true, meta, status: lastOutput?.type === 'vibe_status' ? lastOutput : undefined, decision: lastOutput?.type === 'vibe_decision' ? lastOutput : undefined };
  } catch (e: any) {
    const err = String(e?.message || e);
    await appendLog(env, url, { type: 'vibe_error', error: err });
    const nextRt: VibeRuntime = { ...rt, lastTickAt: Date.now(), lastError: err };
    await kvPutJson(env, url, '/vibe_runtime.json', nextRt);
    return { ok: false, error: err };
  }
}

async function handleVibeTick(req: Request, env: Env) {
  const url = new URL(req.url);
  const res = await vibeTick(env, url);
  return new Response(JSON.stringify(res, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleVibeLlmTest(req: Request, env: Env) {
  const url = new URL(req.url);
  try {
    const cfg = await kvGetJson<VibeConfig>(env, url, '/vibe_config.json', DEFAULT_VIBE_CONFIG);
    const state = { balances: { equityUsd: 1000 }, positions: [], universe: cfg.universe };
    const { parsed, meta } = await callLLMDecider(env, state, cfg);
    return new Response(JSON.stringify({ ok: true, meta, sample: parsed }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2), { status: 500, headers: cors({ 'Content-Type': 'application/json' }) });
  }
}

async function handleVibeLogs(req: Request, env: Env) {
  const url = new URL(req.url);
  const logs = await kvGetJson<any[]>(env, url, '/vibe_logs.json', []);
  return new Response(JSON.stringify({ logs: logs.slice(-200).reverse() }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
}

async function handleVibePositions(req: Request, env: Env) {
  const url = new URL(req.url);
  // Live fetch from Aster (Binance-style fapi). No fallback.
  try {
    const base = (env.ASTER_API_BASE || '').trim();
    const apiKey = env.ASTER_API_KEY;
    const apiSecret = env.ASTER_API_SECRET;
    if (!base || !apiKey || !apiSecret) {
      return new Response(JSON.stringify({ ok: false, error: 'ASTER_API_BASE/API_KEY/API_SECRET missing' }, null, 2), { status: 400, headers: cors({ 'Content-Type': 'application/json' }) });
    }
    const ts = Date.now();
    const recv = 5000;
    const query = `timestamp=${ts}&recvWindow=${recv}`;
    const sig = await hmacHex('SHA-256', apiSecret, query);
    const r = await fetch(`${base}/fapi/v2/positionRisk?${query}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': apiKey } });
    const txt = await r.text();
    const body = (() => { try { return JSON.parse(txt); } catch { return { raw: txt }; } })();
    return new Response(JSON.stringify({ status: r.status, ok: r.ok, body }, null, 2), { status: r.status, headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2), { status: 500, headers: cors({ 'Content-Type': 'application/json' }) });
  }
}

async function handleVibeBalances(req: Request, env: Env) {
  const url = new URL(req.url);
  // Live fetch from Aster (Binance-style fapi). No fallback.
  try {
    const base = (env.ASTER_API_BASE || '').trim();
    const apiKey = env.ASTER_API_KEY;
    const apiSecret = env.ASTER_API_SECRET;
    if (!base || !apiKey || !apiSecret) {
      return new Response(JSON.stringify({ ok: false, error: 'ASTER_API_BASE/API_KEY/API_SECRET missing' }, null, 2), { status: 400, headers: cors({ 'Content-Type': 'application/json' }) });
    }
    const ts = Date.now();
    const recv = 5000;
    const query = `timestamp=${ts}&recvWindow=${recv}`;
    const sig = await hmacHex('SHA-256', apiSecret, query);
    const r = await fetch(`${base}/fapi/v2/account?${query}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': apiKey } });
    const txt = await r.text();
    const body = (() => { try { return JSON.parse(txt); } catch { return { raw: txt }; } })();
    return new Response(JSON.stringify({ status: r.status, ok: r.ok, body }, null, 2), { status: r.status, headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2), { status: 500, headers: cors({ 'Content-Type': 'application/json' }) });
  }
}

async function handleVibePrices(req: Request, env: Env) {
  const url = new URL(req.url);
  try {
    // Fetch all tickers and 24h stats once
    const [allTickers, all24h] = await Promise.all([
      asterFapiGetPublicJson(env, '/fapi/v1/ticker/price'),
      asterFapiGetPublicJson(env, '/fapi/v1/ticker/24hr')
    ]);
    const symToPrice: Record<string, number> = {};
    const symToChange: Record<string, number> = {};
    if (Array.isArray(allTickers)) {
      for (const t of allTickers) {
        const sym = String(t?.symbol || '');
        const p = Number(t?.price || 0);
        if (sym && Number.isFinite(p) && p > 0) symToPrice[sym] = p;
      }
    }
    if (Array.isArray(all24h)) {
      for (const t of all24h) {
        const sym = String(t?.symbol || '');
        const pct = Number(t?.priceChangePercent ?? t?.P ?? 0);
        if (sym && Number.isFinite(pct)) symToChange[sym] = pct;
      }
    }
    const exact: Record<string, string> = {
      BTC: 'BTCUSDT',
      ETH: 'ETHUSDT',
      BNB: 'BNBUSDT',
      XRP: 'XRPUSDT',
      DOGE: 'DOGEUSDT',
      SOL: 'SOLUSDT',
      HYPE: 'HYPEUSDT',
      ASTER: 'ASTERUSDT',
      CAKE: 'CAKEUSDT',
      ZORA: 'ZORAUSDT',
      PUMP: 'PUMPUSDT',
      ZCASH: 'ZECUSDT'
    };
    const prices: Record<string, number> = {};
    const change24h: Record<string, number> = {};
    for (const [token, sym] of Object.entries(exact)) {
      const v = symToPrice[sym];
      if (Number.isFinite(v) && v > 0) prices[token] = v;
      const c = symToChange[sym];
      if (Number.isFinite(c)) change24h[token] = c;
    }
    return new Response(JSON.stringify({ prices, change24h }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ prices: {}, change24h: {} }), { headers: cors({ 'Content-Type': 'application/json' }), status: 200 });
  }
}

async function handleVibeOpenTrades(req: Request, env: Env) {
  const url = new URL(req.url);
  try {
    const base = (env.ASTER_API_BASE || '').trim();
    const apiKey = (env as any).ASTER_API_KEY;
    const apiSecret = (env as any).ASTER_API_SECRET;
    if (!base || !apiKey || !apiSecret) {
      return new Response(JSON.stringify({ trades: [], error: 'ASTER_API_BASE/API_KEY/API_SECRET missing' }, null, 2), { status: 200, headers: cors({ 'Content-Type': 'application/json' }) });
    }
    const ts = Date.now();
    const recv = 5000;
    const query = `timestamp=${ts}&recvWindow=${recv}`;
    const sig = await hmacHex('SHA-256', apiSecret, query);
    const r = await fetch(`${base}/fapi/v2/positionRisk?${query}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': apiKey } });
    const txt = await r.text();
    const body = (() => { try { return JSON.parse(txt); } catch { return null; } })();
    const list = Array.isArray(body) ? body : [];
    const out: any[] = [];
    for (const p of list) {
      const symbol = String(p?.symbol || '');
      const amt = Number(p?.positionAmt || 0);
      if (!symbol || !Number.isFinite(amt) || Math.abs(amt) <= 0) continue;
      const entryPrice = Number(p?.entryPrice || 0);
      const markPrice = Number(p?.markPrice || p?.markPrice || 0);
      const unRealizedProfit = Number(p?.unRealizedProfit || 0);
      const side = amt > 0 ? 'LONG' : 'SHORT';
      const qty = Math.abs(amt);
      out.push({
        symbol,
        side,
        qty,
        entryPrice: entryPrice || null,
        currentPrice: Number.isFinite(markPrice) && markPrice > 0 ? markPrice : null,
        unrealizedUsd: Number.isFinite(unRealizedProfit) ? unRealizedProfit : null,
        openedAt: Date.now(), // exchange does not provide openedAt here
      });
    }
    return new Response(JSON.stringify({ trades: out }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ trades: [], error: String(e?.message || e) }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }), status: 200 });
  }
}

async function handleVibeTickers(req: Request, env: Env) {
  try {
    const allTickers = await asterFapiGetPublicJson(env, '/fapi/v1/ticker/price');
    const symbols = Array.isArray(allTickers) ? allTickers.map((t: any) => t?.symbol).filter(Boolean) : [];
    return new Response(JSON.stringify({ count: symbols.length, symbols }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ count: 0, symbols: [] }), { headers: cors({ 'Content-Type': 'application/json' }), status: 200 });
  }
}

async function asterFapiSignedGet(env: Env, path: string, params: Record<string, string | number>): Promise<any | null> {
  const base = (env.ASTER_API_BASE || '').trim().replace(/\/+$/, '');
  const apiKey = (env as any).ASTER_API_KEY;
  const apiSecret = (env as any).ASTER_API_SECRET;
  if (!base || !apiKey || !apiSecret) return null;
  const ts = Date.now();
  const recv = 5000;
  const qp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qp.append(k, String(v));
  qp.append('timestamp', String(ts));
  qp.append('recvWindow', String(recv));
  const sig = await hmacHex('SHA-256', apiSecret, qp.toString());
  qp.append('signature', sig);
  const url = `${base}${path}?${qp.toString()}`;
  const r = await fetch(url, { headers: { 'X-MBX-APIKEY': apiKey } });
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

async function handleVibeBackfillTrades(req: Request, env: Env) {
  const url = new URL(req.url);
  const admin = env.ADMIN_KEY;
  const key = req.headers.get('x-admin-key') || '';
  if (!admin || key !== admin) {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 403, headers: cors({ 'Content-Type': 'application/json' }) });
  }
  try {
    const cfg = await kvGetJson<VibeConfig>(env, url, '/vibe_config.json', DEFAULT_VIBE_CONFIG);
    const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days') || '14')));
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000;
    const universe = Array.isArray(cfg.universe) && cfg.universe.length ? cfg.universe : ['BTCUSDT','ETHUSDT'];

    type Fill = { time: number; price: number; qty: number; isBuy: boolean };
    const symbolToFills: Record<string, Fill[]> = {};

    for (const sym of universe) {
      const data = await asterFapiSignedGet(env, '/fapi/v1/userTrades', { symbol: sym, startTime, limit: 1000 });
      const arr = Array.isArray(data) ? data : [];
      const fills: Fill[] = [];
      for (const t of arr) {
        const time = Number(t?.time || t?.T || 0);
        const price = Number(t?.price || t?.p || 0);
        const qty = Math.abs(Number(t?.qty || t?.q || 0));
        const sideStr = String(t?.side || '').toUpperCase();
        const isBuyer = Boolean(t?.isBuyer ?? t?.buyer ?? (sideStr === 'BUY'));
        if (time && price > 0 && qty > 0) fills.push({ time, price, qty, isBuy: isBuyer });
      }
      fills.sort((a,b)=>a.time-b.time);
      symbolToFills[sym] = fills;
    }

    type CT = {
      symbol: string; side: 'LONG'|'SHORT'; qty: number;
      entryPrice: number; exitPrice: number;
      notionalEntry: number; notionalExit: number;
      openedAt: number; closedAt: number; holdingMs: number; pnlUsd: number;
    };
    const closed: CT[] = [];

    for (const [sym, fills] of Object.entries(symbolToFills)) {
      let netQty = 0; // signed: long positive
      let side: 'LONG' | 'SHORT' | null = null;
      let entryQty = 0; let entryNotional = 0; let openedAt = 0;
      let exitQty = 0; let exitNotional = 0; let lastTime = 0;

      const flushClose = () => {
        if (entryQty > 0 && exitQty > 0) {
          const qty = Math.min(entryQty, exitQty);
          const entryPrice = entryNotional / entryQty;
          const exitPrice = exitNotional / exitQty;
          const s = (side || 'LONG');
          const pnl = s === 'LONG' ? (exitPrice - entryPrice) * qty : (entryPrice - exitPrice) * qty;
          closed.push({
            symbol: sym,
            side: s,
            qty,
            entryPrice,
            exitPrice,
            notionalEntry: entryNotional,
            notionalExit: exitNotional,
            openedAt: openedAt || lastTime,
            closedAt: lastTime,
            holdingMs: Math.max(0, lastTime - (openedAt || lastTime)),
            pnlUsd: pnl
          });
        }
        netQty = 0; side = null; entryQty = 0; entryNotional = 0; exitQty = 0; exitNotional = 0; openedAt = 0;
      };

      for (const f of fills) {
        lastTime = f.time;
        const sgn = f.isBuy ? 1 : -1;
        // If no side yet, determine by first effective direction
        if (side === null) side = sgn > 0 ? 'LONG' : 'SHORT';
        // If incoming trade continues current side
        const continues = (side === 'LONG' && sgn > 0) || (side === 'SHORT' && sgn < 0);
        if (continues) {
          if (entryQty === 0) openedAt = f.time;
          entryQty += f.qty;
          entryNotional += f.price * f.qty;
          netQty += sgn * f.qty;
        } else {
          // This reduces or closes the current side
          exitQty += f.qty;
          exitNotional += f.price * f.qty;
          netQty += sgn * f.qty;
          if (Math.sign(netQty) === 0) {
            // closed fully
            flushClose();
          } else if ((side === 'LONG' && netQty < 0) || (side === 'SHORT' && netQty > 0)) {
            // flipped beyond zero: close current and start new side with remainder
            flushClose();
            // Remainder becomes new side
            side = netQty > 0 ? 'LONG' : 'SHORT';
            // Start new entry with remainder at current fill price
            openedAt = f.time;
            entryQty = Math.abs(netQty);
            entryNotional = entryQty * f.price;
            exitQty = 0; exitNotional = 0;
          }
        }
      }
    }

    // Deduplicate with existing KV
    const key = new URL('/vibe_trades.json', url).toString();
    const existing: any[] = (await env.MEAP_KV.get(key, { type: 'json' })) || [];
    const seen = new Set(existing.map((t:any)=> `${t.symbol}|${t.openedAt}|${t.closedAt}|${t.qty}`));
    const merged = existing.slice();
    for (const ct of closed) {
      const k = `${ct.symbol}|${ct.openedAt}|${ct.closedAt}|${ct.qty}`;
      if (!seen.has(k)) { merged.push(ct); seen.add(k); }
    }
    merged.sort((a:any,b:any)=> (a.closedAt||0) - (b.closedAt||0));
    await env.MEAP_KV.put(key, JSON.stringify(merged));

    return new Response(JSON.stringify({ ok: true, added: closed.length, total: merged.length }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2), { status: 500, headers: cors({ 'Content-Type': 'application/json' }) });
  }
}

function ema(values: number[], period: number): number[] {
  const out: number[] = Array(values.length).fill(NaN);
  if (values.length === 0 || period <= 1) return values.slice();
  const k = 2 / (period + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function atr(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const n = Math.min(highs.length, lows.length, closes.length);
  const out: number[] = Array(n).fill(NaN);
  if (n < 2) return out;
  const trs: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) { trs.push(highs[i] - lows[i]); continue; }
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  // Wilder smoothing
  let prev = trs.slice(0, period).reduce((a,b)=>a+b,0) / Math.max(1, Math.min(period, trs.length));
  for (let i = 0; i < trs.length; i++) {
    if (i < period) { out[i] = NaN; continue; }
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

async function fetchKlines(env: Env, sym: string, interval: string, limit: number): Promise<any[] | null> {
  return await asterFapiGetPublicJson(env, `/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${limit}`);
}

function computeIndicatorsFromKlines(kl: any[]): { ema9: number|null; ema21: number|null; rsi14: number|null; atr14: number|null; vwap: number|null; rangePct: number|null } {
  if (!Array.isArray(kl) || kl.length < 21) return { ema9: null, ema21: null, rsi14: null, atr14: null, vwap: null, rangePct: null };
  const closes: number[] = kl.map((r: any) => Number(r[4]));
  const highs: number[] = kl.map((r: any) => Number(r[2]));
  const lows: number[] = kl.map((r: any) => Number(r[3]));
  const vols: number[] = kl.map((r: any) => Number(r[5]));
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const r = rsi(closes, 14);
  const a = atr(highs, lows, closes, 14);
  // session VWAP over window
  let pv = 0, v = 0;
  for (let i = 0; i < kl.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const vol = Number.isFinite(vols[i]) ? vols[i] : 0;
    pv += tp * vol; v += vol;
  }
  const vwap = v > 0 ? pv / v : null;
  const win = Math.min(30, kl.length);
  const hi = Math.max(...highs.slice(-win));
  const lo = Math.min(...lows.slice(-win));
  const last = closes[closes.length - 1];
  const rangePct = last > 0 ? ((hi - lo) / last) * 100 : null;
  return {
    ema9: Number.isFinite(e9[e9.length - 1]) ? e9[e9.length - 1] : null,
    ema21: Number.isFinite(e21[e21.length - 1]) ? e21[e21.length - 1] : null,
    rsi14: Number.isFinite(r[r.length - 1]) ? r[r.length - 1] : null,
    atr14: Number.isFinite(a[a.length - 1]) ? a[a.length - 1] : null,
    vwap,
    rangePct
  };
}

async function getExchangeInfo(env: Env): Promise<any | null> {
  return await asterFapiGetPublicJson(env, '/fapi/v1/exchangeInfo');
}

function stepSizeForSymbol(info: any, sym: string): { step: number; minNotional?: number } {
  try {
    const s = info?.symbols?.find((x: any) => x?.symbol === sym);
    const lot = s?.filters?.find((f: any) => f?.filterType === 'LOT_SIZE');
    const notional = s?.filters?.find((f: any) => f?.filterType === 'MIN_NOTIONAL' || f?.filterType === 'NOTIONAL');
    const step = Number(lot?.stepSize || 0);
    const minNotional = Number(notional?.notional || notional?.minNotional || 0);
    return { step: Number.isFinite(step) && step > 0 ? step : 0.0001, minNotional: Number.isFinite(minNotional) && minNotional > 0 ? minNotional : undefined };
  } catch { return { step: 0.0001 }; }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === '/api/debug') return handleDebug(req, env);
    if (url.pathname === '/api/events' || url.pathname === '/api/feed' || url.pathname === '/feed') return handleEvents(req, env);
    if (url.pathname === '/api/agents' && req.method === 'GET') return handleAgentsGet(req, env);
    if (url.pathname === '/api/agents' && req.method === 'POST') return handleAgentsPost(req, env);
    if (url.pathname === '/api/messages' && req.method === 'POST') return handleMessage(req, env);
    // Vibe Trader routes
    if (url.pathname === '/api/vibe/status' && req.method === 'GET') return handleVibeStatus(req, env);
    if (url.pathname === '/api/vibe/run' && req.method === 'POST') return handleVibeRun(req, env);
    if (url.pathname === '/api/vibe/stop' && req.method === 'POST') return handleVibeStop(req, env);
    if (url.pathname === '/api/vibe/tick' && req.method === 'POST') return handleVibeTick(req, env);
    if (url.pathname === '/api/vibe/llm-test' && req.method === 'GET') return handleVibeLlmTest(req, env);
    if (url.pathname === '/api/vibe/logs' && req.method === 'GET') return handleVibeLogs(req, env);
    if (url.pathname === '/api/vibe/positions' && req.method === 'GET') return handleVibePositions(req, env);
    if (url.pathname === '/api/vibe/balances' && req.method === 'GET') return handleVibeBalances(req, env);
    if (url.pathname === '/api/vibe/equity' && req.method === 'GET') {
      const eq = (await env.MEAP_KV.get(new URL('/vibe_equity.json', url).toString(), { type: 'json' })) || [];
    return new Response(JSON.stringify({ equity: Array.isArray(eq) ? eq.slice(-1000) : [] }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/vibe/trades' && req.method === 'GET') {
      const list = (await env.MEAP_KV.get(new URL('/vibe_trades.json', url).toString(), { type: 'json' })) || [];
      return new Response(JSON.stringify({ trades: list }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/vibe/backfill-trades' && req.method === 'POST') return handleVibeBackfillTrades(req, env);
    if (url.pathname === '/api/vibe/open-trades' && req.method === 'GET') return handleVibeOpenTrades(req, env);
    if (url.pathname === '/api/vibe/prices' && req.method === 'GET') return handleVibePrices(req, env);
    // Aster diagnostics (no secrets)
    if (url.pathname === '/api/vibe/aster-test' && req.method === 'GET') {
      const results: any = { base: env.ASTER_API_BASE ? true : false };
      try {
        const r1 = await asterRequest(env, 'GET', '/v1/futures/account');
        results.account = { status: r1.status, ok: r1.ok };
      } catch (e: any) { results.account = { error: String(e?.message || e) }; }
      try {
        const r2 = await asterRequest(env, 'GET', '/v1/futures/positions');
        results.positions = { status: r2.status, ok: r2.ok };
      } catch (e: any) { results.positions = { error: String(e?.message || e) }; }
      return new Response(JSON.stringify(results, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
    }
    if (url.pathname === '/api/vibe/tickers' && req.method === 'GET') return handleVibeTickers(req, env);
    if (url.pathname === '/api/vibe/aster-debug' && req.method === 'GET') {
      const hasPriv = !!env.ASTER_PRIVATE_KEY;
      const addr = hasPriv ? evmAddressFromPrivateKey(env.ASTER_PRIVATE_KEY as string) : null;
      const hasApiKey = !!env.ASTER_API_KEY;
      const hasApiSecret = !!env.ASTER_API_SECRET;
      return new Response(JSON.stringify({ base: env.ASTER_API_BASE || null, evm: { enabled: hasPriv, address: addr }, apiKey: { enabled: hasApiKey && hasApiSecret } }, null, 2), { headers: cors({ 'Content-Type': 'application/json' }) });
    }
    // Place tiny market order (notional-based): /api/vibe/order/market?symbol=BTCUSDT&notional=10
    // Disabled public order endpoint to prevent external influence
    // Set leverage: /api/vibe/leverage?symbol=BTCUSDT&leverage=5
    // Disabled public leverage endpoint
    // Cancel all: /api/vibe/cancelAll?symbol=BTCUSDT
    // Disabled public cancel endpoint
    // /api/agents/:id/inbox
    const inboxMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/inbox$/);
    if (inboxMatch && req.method === 'GET') {
      const agentId = inboxMatch[1];
      const keyInbox = new URL(`/inbox_${agentId}.json`, url).toString();
      const messages = (await env.MEAP_KV.get(keyInbox, { type: 'json' })) || [];
      return new Response(JSON.stringify({ messages }), { headers: cors({ 'Content-Type': 'application/json' }) });
    }
    return new Response('Not Found', { status: 404, headers: cors() });
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const url = new URL('https://api.naemu.com'); // base for KV key scoping; actual host not used
    await vibeTick(env, url, true);
  }
};


