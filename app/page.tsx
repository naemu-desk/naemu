"use client";

import { useEffect, useMemo, useRef, useState } from 'react';

const API_BASE = 'https://api.naemu.com';

export default function Page() {
  return (
    <main style={{ padding: 0 }}>
      <style jsx global>{`
        html, body { overflow: hidden; }
      `}</style>
      <div style={{ width: '100vw', height: 'calc(100vh - 64px)', display: 'grid', gridTemplateRows: '44px 1fr', gridTemplateColumns: '3fr 1fr', overflow: 'hidden' }}>
        <div style={{ gridColumn: '1 / 3', borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <PriceTicker />
        </div>
        <div style={{ gridRow: '2 / 3', gridColumn: '1 / 2', minWidth: 0, minHeight: 0, background: 'var(--surface)', height: '100%' }}>
          <ChartPane />
        </div>
        <div style={{ gridRow: '2 / 3', gridColumn: '2 / 3', borderLeft: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, height: '100%' }}>
          <ActivityPanel />
        </div>
      </div>
    </main>
  );
}

function useArenaData() {
  const [equity, setEquity] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);

  async function refresh() {
    try {
      const [eq, l] = await Promise.all([
        fetch(`${API_BASE}/api/vibe/equity?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' }).then(r => r.json()).catch(() => ({ equity: [] })),
        fetch(`${API_BASE}/api/vibe/logs?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' }).then(r => r.json()).catch(() => ({ logs: [] })),
      ]);
      if (Array.isArray(eq?.equity)) setEquity(eq.equity);
      if (Array.isArray(l?.logs)) setLogs(l.logs);
    } catch {}
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  return { equity, logs };
}

function ChartPane() {
  const { equity } = useArenaData();
  // Use all samples returned (anchor + daily shards) so left edge stays fixed
  const pointsAll = Array.isArray(equity) ? equity : [];
  
  // Find the MOST RECENT time equity reached 900, then go back to find the spike start
  // Start from the end (most recent) and work backwards
  let startIdx = 0;
  if (pointsAll.length > 0) {
    // Find the most recent point where equity >= 900 (working backwards from the end)
    let recent900Idx = -1;
    for (let i = pointsAll.length - 1; i >= 0; i--) {
      const eq = Number(pointsAll[i]?.equityUsd || 0);
      if (eq >= 900) {
        recent900Idx = i;
        break;
      }
    }
    
    if (recent900Idx >= 0) {
      // Found recent 900 point, now go back to find where it was around 361 (before the spike)
      // Look backwards from the 900 point to find where equity was <= 400
      for (let j = recent900Idx; j >= 0 && j >= recent900Idx - 300; j--) {
        const prevEq = Number(pointsAll[j]?.equityUsd || 0);
        if (prevEq <= 400) {
          // Start from a bit before this point to show the spike
          startIdx = Math.max(0, j - 5);
          break;
        }
      }
      // If we didn't find a low point going back, just start 50 points before the 900 point
      if (startIdx === 0 && recent900Idx > 0) {
        startIdx = Math.max(0, recent900Idx - 50);
      }
      // Shift forward 8 minutes (8 data points) to skip the 300 numbers
      if (startIdx > 0) {
        startIdx = Math.min(pointsAll.length - 1, startIdx + 8);
      }
    } else {
      // No 900 point found, just take last 2000 points
      startIdx = pointsAll.length > 2000 ? pointsAll.length - 2000 : 0;
    }
  }
  
  const points = pointsAll.slice(startIdx);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const hoverRef = useRef<{ x: number | null }>({ x: null });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const wr = wrap as HTMLDivElement;
    const cnv = canvas as HTMLCanvasElement;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    function draw() {
      const ctx = cnv.getContext('2d');
      if (!ctx) return;
      const rect = wr.getBoundingClientRect();
      const W = Math.max(200, Math.floor(rect.width));
      const H = Math.max(200, Math.floor(rect.height));
      cnv.style.width = W + 'px';
      cnv.style.height = H + 'px';
      cnv.width = Math.floor(W * dpr);
      cnv.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Clear
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg1').trim() || '#ffffff';
      ctx.fillRect(0, 0, W, H);

      // Padding for axes
      // Layout paddings
      const padLLabels = 56; // y label anchor (left numbers stay here)
      const padLPlot = 76;   // plot starts to the right of labels; shift line right without moving numbers
      const padR = 64;       // pull rightmost point further left (more)
      const padT = 40;       // move top of plot further down
      const padB = 28;       // keep timestamp baseline stable near bottom
      const innerW = Math.max(10, W - padLPlot - padR);
      const innerH = Math.max(10, H - padT - padB);
      const plotBottomPadding = 24; // lift the plot area more without moving timestamps
      const plotH = Math.max(10, innerH - plotBottomPadding);

      // Border line
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#f0f0f0';
      ctx.lineWidth = 1;
      // Draw plot border (not covering timestamp area)
      ctx.strokeRect(padLPlot, padT, innerW, plotH);

      if (!points || points.length < 2) {
        ctx.fillStyle = 'var(--muted)';
        ctx.font = '12px ui-sans-serif, system-ui';
        ctx.fillText('No data', padLLabels + 8, padT + 20);
        return;
      }

      const vals = points.map((p: any) => Number(p?.equityUsd || 0));
      const times = points.map((p: any) => Number(p?.at || 0));
      // Use a recent window for scaling so the line isn't flat
      const windowCount = Math.min(vals.length, 240);
      const winVals = windowCount > 0 ? vals.slice(-windowCount) : vals;
      const vMinRaw = Math.min(...vals);
      const vMaxRaw = Math.max(...vals);
      const vSpanRaw = Math.max(1e-9, vMaxRaw - vMinRaw);

      // Dynamic band strictly around visible data with small padding
      const pad = Math.max(vSpanRaw * 0.08, 0.001);
      let yMin0 = vMinRaw - pad;
      let yMax0 = vMaxRaw + pad;
      if (!(isFinite(yMin0) && isFinite(yMax0)) || yMax0 <= yMin0) {
        // Fallback if values are degenerate
        yMin0 = vMinRaw || 0;
        yMax0 = (vMaxRaw || 1) + 1;
      }
      const span0 = Math.max(1e-6, yMax0 - yMin0);
      const targetTicks = 6;
      let step = niceStep(span0 / targetTicks);
      const yMin = Math.floor(yMin0 / step) * step;
      const yMax = Math.ceil(yMax0 / step) * step;
      const ySpan = Math.max(step, yMax - yMin);

      const tMin = Math.min(...times);
      const tMax = Math.max(...times);
      const tSpan = Math.max(1, tMax - tMin);

      const sx = (t: number) => padLPlot + ((t - tMin) / tSpan) * innerW;
      const sy = (v: number) => padT + (1 - (v - yMin) / ySpan) * plotH;

      // Grid + ticks
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#f3f3f3';
      ctx.lineWidth = 1;
      const textCol = getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#f5f5f5';
      const mutedCol = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#6b6b6b';
      ctx.fillStyle = textCol; // make Y labels brighter
      ctx.font = '13px ui-sans-serif, system-ui';

      // Y ticks
      const yTicks: number[] = [];
      for (let v = yMin; v <= yMin + ySpan + 1e-9; v += step) yTicks.push(Number(v.toFixed(6)));
      yTicks.forEach(v => {
        const y = sy(v);
        ctx.beginPath();
        ctx.moveTo(padLPlot, y);
        ctx.lineTo(padLPlot + innerW, y);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(fmtUsd(v), padLLabels - 8, y);
      });

      // X ticks
      const xTickCount = 7;
      for (let i = 0; i < xTickCount; i++) {
        const t = tMin + (i / (xTickCount - 1)) * tSpan;
        const x = sx(t);
        ctx.beginPath();
        ctx.moveTo(x, padT);
        ctx.lineTo(x, padT + plotH);
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#f7f7f7';
        ctx.stroke();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = textCol; // brighter dates in dark mode
        ctx.fillText(fmtTime(t), x, padT + innerH + 6); // timestamps remain at original baseline
      }

      // Line
      ctx.beginPath();
      ctx.lineWidth = 1;
      const rootStyles = getComputedStyle(document.documentElement);
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      const lineText = rootStyles.getPropertyValue('--text').trim() || '#1c1c1c';
      const lineAccent = rootStyles.getPropertyValue('--accent').trim() || '#e2c619';
      ctx.strokeStyle = isDark ? lineAccent : lineText;
      points.forEach((p: any, idx: number) => {
        const x = sx(Number(p.at));
        const y = sy(Number(p.equityUsd));
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Pulse + label at end
      const last = points[points.length - 1];
      if (last) {
        const lx = sx(Number(last.at));
        const ly = sy(Number(last.equityUsd));
        const t = performance.now();
        const pulse = 4 + 2 * (0.5 + 0.5 * Math.sin(t / 500));
        ctx.beginPath();
        ctx.arc(lx, ly, pulse + 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(239,190,132,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = (isDark ? lineAccent : lineText) || '#1c1c1c';
        ctx.fill();

        const label = labelRef.current;
        if (label) {
          // Default to last point label
          let px = lx, py = ly, val = last && typeof last.equityUsd === 'number' ? fmtUsd(Number(last.equityUsd)) : '', ts = fmtTime(Number(last.at));
          // If hovering, snap to nearest time along x and draw vertical dashed line
          if (hoverRef.current.x !== null) {
            const hx = hoverRef.current.x;
            // find nearest point by x
            let bestIdx = 0, bestDist = 1e9;
            for (let i = 0; i < points.length; i++) {
              const x = sx(Number(points[i].at));
              const d = Math.abs(x - hx);
              if (d < bestDist) { bestDist = d; bestIdx = i; }
            }
            const p = points[bestIdx];
            px = sx(Number(p.at));
            py = sy(Number(p.equityUsd));
            val = fmtUsd(Number(p.equityUsd));
            ts = fmtTime(Number(p.at));
            // vertical dashed line
            ctx.save();
            ctx.setLineDash([2, 2]);
            ctx.strokeStyle = 'var(--muted)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(px, padT);
            ctx.lineTo(px, padT + plotH);
            ctx.stroke();
            ctx.restore();
          }
          // Anchor the label centered on the dashed guide line
          label.style.left = `${px}px`;
          label.style.top = `${py}px`;
          label.style.transform = 'translate(-50%, -150%)';
          const valEl = label.querySelector('[data-val]') as HTMLElement | null;
          const timeEl = label.querySelector('[data-time]') as HTMLElement | null;
          if (valEl) valEl.textContent = val;
          if (timeEl) timeEl.textContent = ts;
          label.style.display = 'inline-flex';
          (label as HTMLElement).style.background = 'var(--surface)';
          (label as HTMLElement).style.border = '1px solid var(--border)';
          (label as HTMLElement).style.color = 'var(--text)';
        }
      }
    }

    const ResizeObserverCtor = (window as any).ResizeObserver;
    const ro = ResizeObserverCtor ? new ResizeObserverCtor(() => draw()) : null;
    if (ro) ro.observe(wr);

    // Hover handlers
    function onMove(e: MouseEvent) {
      const rect = wr.getBoundingClientRect();
      hoverRef.current.x = e.clientX - rect.left;
    }
    function onLeave() { hoverRef.current.x = null; }
    wr.addEventListener('mousemove', onMove);
    wr.addEventListener('mouseleave', onLeave);
    let raf = 0;
    const loop = () => { draw(); raf = requestAnimationFrame(loop); };
    loop();
    return () => { try { ro && ro.disconnect(); } catch {} try { cancelAnimationFrame(raf); } catch {} wr.removeEventListener('mousemove', onMove); wr.removeEventListener('mouseleave', onLeave); };
  }, [points]);

  return (
    <div ref={wrapRef} style={{ width: '100%', height: '100%', background: 'var(--surface)', position: 'relative', overflow: 'hidden' }}>
      <canvas ref={canvasRef} />
      <div ref={labelRef} style={{ position: 'absolute', zIndex: 3, pointerEvents: 'none', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', boxShadow: '0 2px 8px rgba(0,0,0,.06)', fontWeight: 800, fontSize: 12, color: 'var(--text)' }}>
        <img src="/naemu2.png" alt="" style={{ width: 28, height: 28, opacity: .9 }} />
        <span data-val>$0</span>
        <span data-time style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 11 }}></span>
      </div>
    </div>
  );
}

function ActivityPanel() {
  const [items, setItems] = useState<any[]>([]);
  const [tab, setTab] = useState<'trades' | 'thoughts' | 'readme'>('trades');
  const lastHashRef = useRef<string>("");
  const [openTrades, setOpenTrades] = useState<any[]>([]);
  const [tradesSub, setTradesSub] = useState<'open'|'closed'>('open');
  const [sortKey, setSortKey] = useState<'pnl'|'date'>('pnl');
  const [sortDir, setSortDir] = useState<'asc'|'desc'>('desc');

  useEffect(() => {
    async function load() {
      try {
        const [logsRes, tradesRes, openRes, eqRes] = await Promise.all([
          fetch(`${API_BASE}/api/vibe/logs?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' }).then(r=>r.json()).catch(()=>({ logs: [] })),
          fetch(`${API_BASE}/api/vibe/trades?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' }).then(r=>r.json()).catch(()=>({ trades: [] })),
          fetch(`${API_BASE}/api/vibe/open-trades?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' }).then(r=>r.json()).catch(()=>({ trades: [] })),
          fetch(`${API_BASE}/api/vibe/equity?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' }).then(r=>r.json()).catch(()=>({ equity: [] })),
        ]);
        const logs = Array.isArray(logsRes?.logs) ? logsRes.logs : [];
        const trades = Array.isArray(tradesRes?.trades) ? tradesRes.trades : [];
        setOpenTrades(Array.isArray(openRes?.trades) ? openRes.trades : []);
        const feed: any[] = [];
        for (const e of logs) {
          const t = String(e?.type||'');
          const at = Number(e?.at||0) || Date.now();
          if (t === 'vibe_prompt') continue;
          else if (t === 'vibe_decision') feed.push({ kind:'decision', at, action:e.action, symbol:e.symbol, sizeUsd:e.sizeUsd, notes:e.notes });
          else if (t === 'vibe_status') feed.push({ kind:'status', at, equityUsd:e.equityUsd, unrealizedUsd:e.unrealizedUsd, summary:e.summary, note:e.note });
          else if (t === 'vibe_order') feed.push({ kind:'order', at, symbol:e.symbol, side:e.side, qty:e.qty, notional:e.notional, reason:e.reason });
          else if (t === 'vibe_order_error') feed.push({ kind:'order_error', at, error:e.error });
          else if (t === 'vibe_error') feed.push({ kind:'error', at, error:e.error });
        }
        for (const tr of trades) if (typeof tr.exitPrice === 'number') feed.push({ kind:'trade_closed', at: Number(tr.closedAt||tr.openedAt||Date.now()), trade: tr });
        feed.sort((a,b)=>Number(b.at)-Number(a.at));
        // Fallback thought if empty: synthesize from current equity last point
        if (feed.length === 0) {
          const eqArr = Array.isArray(eqRes?.equity) ? eqRes.equity : [];
          const lastEq = eqArr.length ? eqArr[eqArr.length - 1] : null;
          if (lastEq && typeof lastEq.equityUsd === 'number') {
            feed.push({ kind:'status', at: Number(lastEq.at||Date.now()), equityUsd: lastEq.equityUsd, summary: `Equity ${fmtUsdSep(lastEq.equityUsd, 2)}. Monitoring positions.` });
          }
        }
        const hash = JSON.stringify(feed.map(f=>[f.kind,f.at,f.symbol,f.action]));
        if (hash !== lastHashRef.current) { lastHashRef.current = hash; setItems(feed); }
      } catch {}
    }
    load();
    const id = setInterval(load, 7000);
    return () => clearInterval(id);
  }, []);

  const tradesList = items.filter((ev:any)=> ev.kind==='trade_closed' || ev.kind==='order');
  const thoughtsList = items.filter((ev:any)=> ev.kind==='status' || ev.kind==='decision');
  const closedList = items.filter((ev:any)=> ev.kind==='trade_closed');
  const sortedClosed = (() => {
    const arr = [...closedList];
    arr.sort((a:any,b:any)=>{
      const ta = a?.trade || {};
      const tb = b?.trade || {};
      if (sortKey === 'pnl') {
        const pa = Number(ta.pnlUsd ?? 0);
        const pb = Number(tb.pnlUsd ?? 0);
        return sortDir==='asc' ? pa - pb : pb - pa;
      } else {
        const da = Number(ta.closedAt || ta.openedAt || a.at || 0);
        const db = Number(tb.closedAt || tb.openedAt || b.at || 0);
        return sortDir==='asc' ? da - db : db - da;
      }
    });
    return arr;
  })();

  return (
    <>
      {/* Segmented header bar */}
      <div style={{ height: 44, display: 'flex', alignItems: 'stretch', padding: 0, borderBottom: '1px solid var(--border)', flex: '0 0 auto' }}>
        {([['trades','Trades'],['thoughts','Thoughts'],['readme','Readme']] as const).map(([key, label], idx) => (
          <div key={key} onClick={() => setTab(key as any)} style={{ flex: 1, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', userSelect:'none', borderLeft: idx===0?'none':'1px solid var(--border)', background: tab===key?'#2a2a2a0f':'var(--surface)', fontWeight: tab===key?800:700, color:'var(--text)' }}>{label}</div>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: '1 1 0', overflowY: 'auto', overflowX: 'hidden', padding: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {tab === 'trades' && (
          <div style={{ height: 36, display: 'flex', alignItems: 'stretch', padding: 0, borderBottom: '1px solid var(--border)' }}>
            {([['open','Open'],['closed','Closed']] as const).map(([key, label], idx) => (
              <div key={key} onClick={() => setTradesSub(key as any)} style={{ flex: 1, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer', userSelect:'none', borderLeft: idx===0?'none':'1px solid var(--border)', background: tradesSub===key?'#2a2a2a0f':'var(--surface)', fontWeight: tradesSub===key?800:700, color:'var(--text)' }}>{label}</div>
            ))}
          </div>
        )}
        {tab === 'trades' && tradesSub === 'closed' && (
          <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px', borderBottom: '1px solid var(--border)', color:'var(--text)' }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Sort:</span>
            <div style={{ display:'inline-flex', border:'1px solid var(--border)', borderRadius: 6, overflow:'hidden' }}>
              <button onClick={()=>setSortKey('pnl')} style={{ padding:'4px 8px', background: sortKey==='pnl'?'#2a2a2a22':'transparent', color:'var(--text)', border:'none', cursor:'pointer' }}>PnL</button>
              <button onClick={()=>setSortKey('date')} style={{ padding:'4px 8px', background: sortKey==='date'?'#2a2a2a22':'transparent', color:'var(--text)', border:'none', cursor:'pointer' }}>Date</button>
            </div>
            <div style={{ display:'inline-flex', border:'1px solid var(--border)', borderRadius: 6, overflow:'hidden' }}>
              <button title="Descending" onClick={()=>setSortDir('desc')} style={{ padding:'4px 8px', background: sortDir==='desc'?'#2a2a2a22':'transparent', color:'var(--text)', border:'none', cursor:'pointer' }}>▼</button>
              <button title="Ascending" onClick={()=>setSortDir('asc')} style={{ padding:'4px 8px', background: sortDir==='asc'?'#2a2a2a22':'transparent', color:'var(--text)', border:'none', cursor:'pointer' }}>▲</button>
            </div>
          </div>
        )}
        <div>
          {tab === 'trades' && (
            <div>
              {tradesSub === 'open' && (
                <div>
                  {openTrades.length === 0 && (<div style={{ color:'var(--muted)', fontSize:12, padding: '12px 16px' }}>No open positions.</div>)}
                  {openTrades.map((t:any, i:number) => {
                    const base = String(t.symbol||'').replace('USDT','');
                    const side = String(t.side||'').toLowerCase();
                    const sideColor = side==='long' ? '#166534' : side==='short' ? '#b91c1c' : '#1c1c1c';
                    const when = t.openedAt || Date.now();
                    const ts = fmtMonthDayTime(when);
                    const qty = typeof t.qty === 'number' ? ((t.side==='SHORT'?-1:1)*Math.abs(t.qty)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
                    const entry = typeof t.entryPrice === 'number' ? fmtUsdSep(t.entryPrice, priceDigits(t.entryPrice)) : '—';
                    const cur = typeof t.currentPrice === 'number' ? fmtUsdSep(t.currentPrice, priceDigits(t.currentPrice)) : '—';
                    const unrl = typeof t.unrealizedUsd === 'number' ? fmtUsdSep(t.unrealizedUsd, 2) : '—';
                    const pnlColor = typeof t.unrealizedUsd === 'number' ? (t.unrealizedUsd >= 0 ? '#166534' : '#b91c1c') : '#6b6b6b';
                    return (
                      <div key={`op-${i}`} style={{ padding: '12px 16px', borderTop: i>0 ? '1px solid var(--border)' : 'none', width: '100%' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:4, fontWeight:800, whiteSpace:'nowrap' }}>
                          <img src="/naemu2.png" alt="" style={{ width: 24, height: 24, opacity:.9, verticalAlign:'middle' }} />
                          {(() => { const baseLower = base.toLowerCase(); const sz = baseLower==='eth'?16:14; return (<img src={iconPathForSymbolLower(baseLower)} alt="" style={{ width: sz, height: sz, verticalAlign:'middle' }} />); })()}
                          <span style={{ lineHeight: 1 }}>Open: <span style={{ color: sideColor }}>{side}</span> {base}</span>
                        </div>
                        <div style={{ color:'var(--muted)', fontSize:12, marginTop:4 }}>{ts}</div>
                        <div style={{ fontSize:13, marginTop:6 }}>
                          <div>Entry: {entry} → {cur}</div>
                          <div>Quantity: {qty}</div>
                        </div>
                        <div style={{ marginTop:8, fontWeight:800 }}>Unrealized P&L: <span style={{ color: pnlColor }}>{unrl}</span></div>
                      </div>
                    );
                  })}
                </div>
              )}
              {tradesSub === 'closed' && (
                <div>
                  {closedList.length === 0 && (<div style={{ color:'var(--muted)', fontSize:12, padding: '12px 16px' }}>No closed trades yet.</div>)}
                  {sortedClosed.map((ev:any, i:number) => (
                <div key={`tr-${i}`} style={{ padding: '12px 16px', borderTop: i>0 ? '1px solid var(--border)' : 'none', width: '100%' }}>
                  {ev.kind === 'order' ? (() => {
                    const sym = String(ev.symbol||'');
                    const base = sym.replace('USDT','').toLowerCase();
                    const isBuy = String(ev.side||'').toUpperCase()==='BUY';
                    const sideColor = isBuy ? '#166534' : '#b91c1c';
                    return (
                      <div>
                        <div style={{ display:'flex', alignItems:'center', gap:4, fontWeight:800, whiteSpace:'nowrap' }}>
                          <img src="/naemu2.png" alt="" style={{ width: 24, height: 24, opacity:.9, verticalAlign:'middle' }} />
                          {(() => { const sz = base==='eth'?16:14; return (<img src={iconPathForSymbolLower(base)} alt="" style={{ width: sz, height: sz, verticalAlign:'middle' }} />); })()}
                          <span>Order: <span style={{ color: sideColor }}>{isBuy?'LONG':'SHORT'}</span> {base.toUpperCase()} qty {(Number(ev.qty)||0).toLocaleString()}</span>
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 4 }}>{fmtMonthDayTime(Number(ev.at||Date.now()))}</div>
                        {ev.reason && (<div style={{ color:'var(--text)', fontSize:13, marginTop:6 }}>{ev.reason}</div>)}
                      </div>
                    );
                  })() : (() => {
                    const t = ev.trade;
                    const base = String(t.symbol||'').replace('USDT','');
                    const side = String(t.side||'').toLowerCase();
                    const sideColor = side==='long' ? '#166534' : side==='short' ? '#b91c1c' : '#1c1c1c';
                    const when = t.closedAt || t.openedAt || Date.now();
                    const ts = fmtMonthDayTime(when);
                    const priceIn = typeof t.entryPrice === 'number' ? fmtUsdSep(t.entryPrice, priceDigits(t.entryPrice)) : null;
                    const priceOut = typeof t.exitPrice === 'number' ? fmtUsdSep(t.exitPrice, priceDigits(t.exitPrice)) : null;
                    const qty = typeof t.qty === 'number' ? ((t.side==='SHORT'?-1:1)*Math.abs(t.qty)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—';
                    const notIn = typeof t.notionalEntry === 'number' ? fmtUsdSep(t.notionalEntry, 0) : null;
                    const notOut = typeof t.notionalExit === 'number' ? fmtUsdSep(t.notionalExit, 0) : null;
                    const hold = t.holdingMs ? fmtHolding(Number(t.holdingMs)) : '—';
                    const pnl = typeof t.pnlUsd === 'number' ? fmtUsdSep(t.pnlUsd, 2) : '—';
                    const pnlColor = typeof t.pnlUsd === 'number' ? (t.pnlUsd >= 0 ? '#166534' : '#b91c1c') : '#6b6b6b';
                    const modelName = t.model || 'NAEMU';
                    const modelDisplay = (String(modelName).toLowerCase() === 'manual') ? 'qwen2.5-32b-instruct' : modelName;
                    const baseLower = base.toLowerCase();
                    const iconSize = baseLower==='eth'?16:14;
                    return (
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontWeight: 800, marginBottom: 4, whiteSpace:'nowrap' }}>
                          <img src="/naemu2.png" alt="" style={{ width: 24, height: 24, opacity: .9, verticalAlign:'middle' }} />
                          <img src={iconPathForSymbolLower(baseLower)} alt="" style={{ width: iconSize, height: iconSize, verticalAlign:'middle' }} />
                          <span style={{ lineHeight: 1 }}>{(modelDisplay||'NAEMU')} completed a <span style={{ color: sideColor }}>{side}</span> trade on {base.replace('USDT','')}!</span>
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 6 }}>{ts}</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 13 }}>
                          <div>Price: {priceIn && priceOut ? `${priceIn} → ${priceOut}` : (priceIn ? `${priceIn} → —` : '—')}</div>
                          <div>Quantity: {qty}</div>
                          <div>Notional: {notIn && notOut ? `${notIn} → ${notOut}` : (notIn ? `${notIn} → —` : '—')}</div>
                          <div>Holding time: {hold}</div>
                        </div>
                        <div style={{ marginTop: 8, fontWeight: 800 }}>Net P&L: <span style={{ color: pnlColor }}>{pnl}</span></div>
                      </div>
                    );
                  })()}
                </div>
              ))}
                </div>
              )}
            </div>
          )}

          {tab === 'thoughts' && (
            <div>
              {thoughtsList.length === 0 && (<div style={{ color:'var(--muted)', fontSize:12, padding: '12px 16px' }}>No thoughts yet.</div>)}
              {thoughtsList.map((ev:any, i:number) => (
                <div key={`th-${i}`} style={{ padding: '12px 16px', borderTop: i>0 ? '1px solid var(--border)' : 'none', width: '100%' }}>
                  {(() => {
                    // Build a single message string and timestamp for both decision and status
                    let msg = '';
                    const ts = fmtMonthDayTime(Number(ev.at||Date.now()));
                    if (ev.kind === 'decision') {
                      const sym = String(ev.symbol||'');
                      const base = sym.replace('USDT','').toUpperCase();
                      const side = String(ev.action||'').toUpperCase();
                      const size = fmtUsdSep(Number(ev.sizeUsd||0), 0);
                      msg = (typeof ev.notes === 'string' && ev.notes.trim()) ? ev.notes.trim() : `Planning ${side} ${base} with size ${size}.`;
                    } else {
                      const summary = typeof ev.summary === 'string' ? ev.summary.trim() : '';
                      const note = typeof ev.note === 'string' ? ev.note.trim() : '';
                      msg = [summary, note].filter(Boolean).join(' ');
                    }
                    return (
                      <div style={{ display:'flex', alignItems:'flex-start', gap:8 }}>
                        <img src="/naemu2.png" alt="" style={{ width: 28, height: 28, opacity:.9 }} />
                        <div style={{ display:'flex', flexDirection:'column' }}>
                          <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500, lineHeight: 1.4 }}>{msg}</div>
                          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 4 }}>{ts}</div>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}

          {tab === 'readme' && (
            <div style={{ padding: '12px 16px', color: 'var(--text)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, marginBottom: 6 }}>
                <img src="/naemu2.png" alt="" style={{ width: 40, height: 40, opacity: .9 }} />
                <span>About 奈木 (NAEMU)</span>
              </div>
              <div style={{ color: 'var(--text)', lineHeight: 1.6, fontSize: 13 }}>
                <p style={{ marginBottom: 8 }}>
                  奈木 (NAEMU) trades Aster futures intraday. It asks a Qwen model for a compact plan (action, symbol, size, thesis, stop, take‑profit, min‑hold) and enforces risk caps per trade and overall exposure.
                </p>
                <p style={{ marginBottom: 8 }}>
                  The dashboard shows a live price ticker, an equity chart, open positions, closed trades, and short status thoughts.
                </p>
                <p style={{ marginBottom: 0 }}>
                  Model: qwen2.5‑32b‑instruct • Exchange: Aster
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const base = raw / Math.pow(10, exp);
  const niceBase = base < 1.5 ? 1 : base < 3 ? 2 : base < 7 ? 5 : 10;
  return niceBase * Math.pow(10, exp);
}

function fmtNumber(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 100) return v.toFixed(0);
  return v.toFixed(2);
}

function fmtUsd(v: number): string { return `$${fmtNumber(v)}`; }

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const mo = d.toLocaleString(undefined, { month: 'short' });
  const dy = String(d.getDate()).padStart(2, '0');
  const hr = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mo} ${dy} ${hr}:${mi}`;
}

function fmtHolding(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}H ${String(mm).padStart(2,'0')}M`;
}

function fmtMonthDayTime(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${mm}/${dd}, ${time}`;
}

function fmtUsdSep(v: number, digits = 2): string {
  return v.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function priceDigits(v: number): number {
  if (v >= 1000) return 1;
  if (v >= 100) return 1;
  if (v >= 1) return 2;
  return 4;
}

function iconPathForSymbolLower(symLower: string): string {
  if (symLower === 'pump') return '/pump.png';
  if (symLower === 'zec') return '/zcash.svg';
  return `/${symLower}.svg`;
}

function PriceTicker() {
  const [data, setData] = useState<Record<string, number>>({});
  const prevRef = useRef<Record<string, number>>({});
  const changeRef = useRef<Record<string, { dir: 'up' | 'down'; t: number }>>({});
  const timersRef = useRef<number[]>([]);
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const r = await fetch(`${API_BASE}/api/vibe/prices?t=${Date.now()}`, { cache: 'no-store', mode: 'cors' });
        const j = await r.json().catch(()=>({ prices: {} }));
        if (!alive || !j || !j.prices) return;
        const now = Date.now();
        const prev = prevRef.current;
        const nextPrices = j.prices as Record<string, number>;
        // Stagger updates per symbol to avoid synchronized jumps
        const keys = Object.keys(nextPrices);
        // Clear any pending timers before scheduling
        for (const id of timersRef.current) { try { clearTimeout(id); } catch {} }
        timersRef.current = [];
        keys.forEach((k, idx) => {
          const v = nextPrices[k];
          const delay = Math.floor(Math.random() * 1200) + (idx % 3) * 60; // 0-1200ms with slight spread
          const tid = window.setTimeout(() => {
            if (!alive) return;
            const p = prev[k];
            if (typeof p === 'number' && typeof v === 'number') {
              if (v > p) changeRef.current[k] = { dir: 'up', t: now };
              else if (v < p) changeRef.current[k] = { dir: 'down', t: now };
            }
            setData(d => ({ ...d, [k]: v }));
            // Update prev after applying to keep diffs consistent
            prevRef.current = { ...prevRef.current, [k]: v };
          }, delay);
          timersRef.current.push(tid);
        });
      } catch {}
    }
    load();
    const id = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(id);
      for (const t of timersRef.current) { try { clearTimeout(t); } catch {} }
      timersRef.current = [];
    };
  }, []);

  // Ordered roughly by market cap plus requested extras
  const items: Array<{ k: string; img: string; label: string }> = [
    { k: 'BTC', img: '/btc.svg', label: 'BTC' },
    { k: 'ETH', img: '/eth.svg', label: 'ETH' },
    { k: 'BNB', img: '/bnb.svg', label: 'BNB' },
    { k: 'XRP', img: '/xrp.svg', label: 'XRP' },
    { k: 'DOGE', img: '/doge.svg', label: 'DOGE' },
    { k: 'SOL', img: '/sol.svg', label: 'SOL' },
    { k: 'CAKE', img: '/cake.svg', label: 'CAKE' },
    { k: 'ZORA', img: '/zora.svg', label: 'ZORA' },
    { k: 'PUMP', img: '/pump.png', label: 'PUMP' },
    { k: 'ZCASH', img: '/zcash.svg', label: 'ZCASH' },
    { k: 'HYPE', img: '/hype.svg', label: 'HYPE' },
    { k: 'ASTER', img: '/aster.svg', label: 'ASTER' }
  ];

  function symbolFor(token: string): string {
    if (token === 'ZCASH') return 'ZECUSDT';
    return `${token}USDT`;
  }

  function PriceCell({ k, img, label }: { k: string; img: string; label: string }) {
    const v = data[k];
    const change = changeRef.current[k];
    const changed = !!(change && Date.now() - change.t < 900);
    function digitsFor(symbol: string, price: number): number {
      if (!Number.isFinite(price)) return 2;
      // Fine-grained decimals for low-priced tokens
      if (price < 0.01) return 6; // e.g., PUMP ~0.0037
      if (price < 1) return 5;    // e.g., DOGE/ZORA ~0.09
      if (price < 10) return 4;   // e.g., ASTER ~1.09
      return 2;
    }
    const val = typeof v === 'number' ? `$${v.toFixed(digitsFor(k, v))}` : '—';
    const sym = symbolFor(k);
    const href = `https://www.asterdex.com/en/futures/v1/${sym}`;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap', color: 'var(--text)', textDecoration: 'none' }}>
        <img src={img} alt="" style={{ width: 16, height: 16 }} />
        <strong>{label}</strong>
        <span className={changed ? 'flashWhite' : ''} style={{ color: 'var(--text)', textAlign: 'left', fontVariantNumeric: 'tabular-nums', display: 'inline-block' }}>{val}</span>
      </a>
    );
  }

  const row = (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 24 }}>
      {items.map((it, i) => (
        <div key={`wrap-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 12 }}>
          <PriceCell k={it.k} img={it.img} label={it.label} />
        </div>
      ))}
    </div>
  );

  return (
    <div style={{ height: 44, display: 'flex', alignItems: 'center', padding: '0 12px', overflow: 'hidden', position: 'relative', background: 'var(--surface)', color: 'var(--text)', borderBottom: '1px solid var(--line)', zIndex: 2 }}>
      <style jsx>{`
        @keyframes marquee { 0% { transform: translate3d(0,0,0); } 100% { transform: translate3d(-50%,0,0); } }
        @keyframes flashWhite { 0% { color: #ffffff; } 100% { color: var(--text); } }
        .flashWhite { animation: flashWhite 0.45s ease; }
        .tickerTrack { will-change: transform; animation: marquee 45s linear infinite; transform: translateZ(0); backface-visibility: hidden; contain: layout paint style; }
        .tickerTrack:hover { animation-play-state: paused; }
      `}</style>
      <div className="tickerTrack" style={{ display: 'inline-flex', alignItems: 'center', gap: 24, color: 'var(--text)' }}>
        {row}
        {row}
      </div>
    </div>
  );
}
