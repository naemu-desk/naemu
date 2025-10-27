// Reconstruct a "squiggly" equity path between two timestamps using real 1m klines
// from multiple symbols. The path is anchored to startVal and endVal and follows
// the composite return curve of the selected symbols, ensuring visible volatility.

type Env = any;

async function fetchPublicJson(url: string): Promise<any> {
  const r = await fetch(url, { cf: { cacheTtl: 15, cacheEverything: true } as any });
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { return null; }
}

function alignToMinute(ts: number): number {
  return Math.floor(ts / 60000) * 60000;
}

export async function reconstructEquitySegment(
  env: Env,
  urlBase: URL,
  from: number,
  to: number,
  startVal: number,
  endVal: number,
  symbols?: string[],
  granularityMs: number = 60000
): Promise<{ inserted: number }>
{
  const base = (env.ASTER_API_BASE || '').trim();
  if (!base) throw new Error('ASTER_API_BASE missing');
  if (!(Number.isFinite(from) && Number.isFinite(to) && to > from)) throw new Error('bad_range');
  if (!(Number.isFinite(startVal) && Number.isFinite(endVal))) throw new Error('bad_endpoints');

  const syms = (Array.isArray(symbols) && symbols.length ? symbols : ['BTCUSDT','ETHUSDT','ZECUSDT','XRPUSDT','ASTERUSDT','CAKEUSDT']).slice(0, 8);
  const gridStart = alignToMinute(from);
  const gridEnd = alignToMinute(to);
  const step = Math.max(10_000, granularityMs);
  const times: number[] = [];
  for (let t = gridStart; t <= gridEnd; t += step) times.push(t);
  if (times.length < 3) throw new Error('too_few_points');

  // Fetch 1m klines per symbol covering the window with buffer
  const limit = Math.min(1500, Math.ceil((gridEnd - gridStart) / 60000) + 20);
  const series: Record<string, Array<{ t: number; c: number }>> = {};
  await Promise.all(syms.map(async (sym) => {
    try {
      const u = `${base}/fapi/v1/klines?symbol=${encodeURIComponent(sym)}&interval=1m&limit=${limit}`;
      const arr = await fetchPublicJson(u);
      const rows = Array.isArray(arr) ? arr : [];
      const pts = rows.map((k: any) => ({ t: Number(k[0]||0), c: Number(k[4]||0) }))
        .filter(p => Number.isFinite(p.t) && Number.isFinite(p.c) && p.t >= gridStart - 60_000 && p.t <= gridEnd + 60_000);
      if (pts.length >= 2) series[sym] = pts;
    } catch {}
  }));
  const used = Object.keys(series);
  if (!used.length) throw new Error('no_klines');

  // Build composite cumulative index from average log-returns across symbols
  const idxVals: number[] = new Array(times.length).fill(0);
  for (let i = 1; i < times.length; i++) {
    const tPrev = times[i - 1];
    const tNow = times[i];
    let sumRet = 0, cnt = 0;
    for (const sym of used) {
      const arr = series[sym];
      // find closes at or before tPrev and at or before tNow
      const pPrev = (() => {
        for (let j = arr.length - 1; j >= 0; j--) { if (arr[j].t <= tPrev) return arr[j]; }
        return null;
      })();
      const pNow = (() => {
        for (let j = arr.length - 1; j >= 0; j--) { if (arr[j].t <= tNow) return arr[j]; }
        return null;
      })();
      if (pPrev && pNow && pPrev.c > 0 && pNow.c > 0 && pPrev.t < pNow.t) {
        const r = Math.log(pNow.c / pPrev.c);
        if (Number.isFinite(r)) { sumRet += r; cnt++; }
      }
    }
    const avgRet = cnt ? (sumRet / cnt) : 0;
    idxVals[i] = idxVals[i - 1] + avgRet;
  }
  // Normalize index to [0..1] by subtracting start and dividing by total span
  const span = idxVals[idxVals.length - 1] - idxVals[0];
  const norm: number[] = new Array(times.length);
  for (let i = 0; i < times.length; i++) {
    norm[i] = span !== 0 ? (idxVals[i] - idxVals[0]) / span : (i / (times.length - 1));
  }
  // Map to equity and add modest volatility via local return std scaling
  const baseDelta = endVal - startVal;
  const eq: Array<{ at: number; equityUsd: number }> = [];
  // compute rolling std of returns to modulate wiggle
  const rets: number[] = [];
  for (let i = 1; i < norm.length; i++) rets.push(norm[i] - norm[i - 1]);
  const meanRet = rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0;
  const varRet = rets.length ? rets.reduce((s, x) => s + (x - meanRet) * (x - meanRet), 0) / rets.length : 0;
  const stdRet = Math.sqrt(Math.max(1e-12, varRet));
  function gauss() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  const noiseAmp = Math.abs((startVal + endVal) / 2) * 0.01; // 1% mid-level default
  for (let i = 0; i < times.length; i++) {
    const drift = startVal + norm[i] * baseDelta;
    // small local wiggle proportional to stdRet
    const wiggle = (i > 0 && i < times.length - 1) ? (gauss() * stdRet * noiseAmp) : 0;
    const v = drift + wiggle;
    eq.push({ at: times[i], equityUsd: Number(v.toFixed(6)) });
  }
  // force exact endpoints
  eq[0].equityUsd = Number(startVal.toFixed(6));
  eq[eq.length - 1].equityUsd = Number(endVal.toFixed(6));

  // Write to KV: replace interior points strictly inside (from, to)
  const keyEq = new URL('/vibe_equity.json', urlBase).toString();
  const existing: Array<{ at: number; equityUsd: number }> = (await (env as any).MEAP_KV.get(keyEq, { type: 'json' })) || [];
  const kept = existing.filter(p => Number(p.at) <= from || Number(p.at) >= to);
  const merged = [...kept, ...eq].sort((a, b) => a.at - b.at);
  await (env as any).MEAP_KV.put(keyEq, JSON.stringify(merged));
  return { inserted: eq.length };
}


