// Reconcile pasted Aster fills vs stored closed trades
// 1) Paste raw fills into reconcile/aster_paste.txt (as copied from Aster UI)
// 2) Run: node reconcile/reconcile.cjs

const fs = require('fs');
const path = require('path');

function splitBlocksByShare(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const blocks = [];
  let cur = [];
  for (const ln of lines) {
    if (ln.length) cur.push(ln);
    if (/^Share$/i.test(ln)) { // end of one fill
      blocks.push(cur.slice());
      cur.length = 0;
    }
  }
  if (cur.length) blocks.push(cur);
  return blocks;
}

function parsePaste(text) {
  const blocks = splitBlocksByShare(text);
  const fills = [];
  for (const lines of blocks) {
    // Find symbol line (ALLCAPS + USDT)
    const symLine = lines.find(s => /^[A-Z]{2,}USDT$/.test(s));
    if (!symLine) continue;
    const sym = symLine;
    const sideLine = lines.find(s => /^(Sell|Buy)$/i.test(s));
    if (!sideLine) continue;
    const isSell = /^Sell$/i.test(sideLine);
    // price: first pure number line with digits and optionally commas/decimals
    const priceLine = lines.find(s => /^(?:[+\-]?\d[\d,]*\.?\d*)$/.test(s));
    const price = priceLine ? Number(priceLine.replace(/,/g, '')) : 0;
    // qty: line like "0.743 ZEC"
    const qtyLine = lines.find(s => /^\d[\d,]*\.?\d*\s+[A-Z]{2,}$/.test(s));
    const qty = qtyLine ? Number(qtyLine.split(/\s+/)[0].replace(/,/g, '')) : 0;
    // realized pnl: take the last line ending with USDT (fee appears before realized pnl; realized is last)
    const usdtLines = lines.filter(s => /USDT$/i.test(s) && /\d/.test(s));
    const pnlStr = usdtLines.length ? usdtLines[usdtLines.length - 1] : null;
    const pnl = pnlStr ? Number(pnlStr.replace(/USDT/i, '').replace(/,/g, '')) : 0;
    fills.push({ symbol: sym, side: isSell ? 'SELL' : 'BUY', price, qty, pnlUsd: pnl });
  }
  return fills;
}

async function main() {
  const pastePath = path.join(__dirname, 'aster_paste.txt');
  let paste = '';
  try { paste = fs.readFileSync(pastePath, 'utf8'); } catch { paste = ''; }
  if (!paste.trim()) {
    console.log('Paste Aster fills into reconcile/aster_paste.txt and re-run.');
    process.exit(0);
  }
  const fills = parsePaste(paste);
  const totalPaste = fills.reduce((s, f) => s + (Number(f.pnlUsd) || 0), 0);
  const bySymPaste = fills.reduce((m, f) => { m[f.symbol] = (m[f.symbol] || 0) + (Number(f.pnlUsd)||0); return m; }, {});

  const res = await fetch('https://api.naemu.com/api/vibe/trades');
  const j = await res.json().catch(()=>({ trades: [] }));
  const trades = Array.isArray(j.trades) ? j.trades : [];
  const totalStored = trades.reduce((s,t)=> s + (Number(t.pnlUsd)||0), 0);
  const bySymStored = trades.reduce((m,t)=> { m[t.symbol] = (m[t.symbol]||0) + (Number(t.pnlUsd)||0); return m; }, {});

  const symbols = Array.from(new Set([...Object.keys(bySymPaste), ...Object.keys(bySymStored)])).sort();
  const perSym = symbols.map(sym => ({
    symbol: sym,
    paste: +(bySymPaste[sym] || 0),
    stored: +(bySymStored[sym] || 0),
    diff: +((bySymPaste[sym] || 0) - (bySymStored[sym] || 0))
  })).filter(x=> Math.abs(x.diff) > 1e-6);

  console.log(JSON.stringify({
    pasteFills: fills.length,
    totalPaste: +totalPaste.toFixed(2),
    totalStored: +totalStored.toFixed(2),
    totalDiff: +((totalPaste - totalStored).toFixed(2)),
    perSymbolDiffs: perSym
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });


