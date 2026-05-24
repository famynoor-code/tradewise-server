const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const TD_KEY = '0bcdf4421d744302a25dbb6217743587';
const TD_BASE = 'https://api.twelvedata.com';

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.options('*', cors());
app.use(express.json());

// ── Shariah compliance list ──────────────────────────────────────────────────
const SHARIAH_PASS = new Set([
  'AAPL','MSFT','GOOGL','AMZN','TSLA','NVDA','META','INTC','AMD','QCOM',
  'ADBE','CRM','PYPL','SHOP','SQ','SNOW','PLTR','UBER','LYFT','ABNB',
  'NFLX','BABA','JD','PDD','TCEHY','SONY','TSM','ASML','SAP','ERIC',
  // Bursa Malaysia (stock codes)
  '1155','5347','0166','7277','5225','0215','5398','1295','6888','5819',
  '5285','2291','5246','1818','7084','7052','5296','0097','5301','4863',
  '6033','5184','0240','1961','2003','3816','5014','4197','5398','3336',
  '5211','5249','8664','9679','5258','1066','5185','0241','5005','3026',
  '4707','5878','7081','6742','4677','2194','5099','1163','8621',
  // Crypto - with notes
  'BTC','ETH','BNB','XRP','ADA','DOT','LINK','UNI','AAVE','ALGO'
]);

const SHARIAH_FAIL = new Set([
  'JPM','BAC','WFC','GS','MS','C','USB','PNC', // Conventional banks
  'BRK.A','BRK.B', // Insurance heavy
  'PM','MO','BTI', // Tobacco
  'MGM','WYNN','LVS','PENN', // Gambling
  'DEO','BUD','STZ', // Alcohol
  'LMT','RTX','NOC','GD','BA' // Weapons
]);

const SHARIAH_WARN = new Set(['AMGN','GILD','BIIB','REGN','VRTX']); // Biotech - needs screening

function shariahCheck(symbol) {
  const s = symbol.toUpperCase().replace('/USD','').replace('.KL','').replace(/[^A-Z0-9]/g,'');
  if (SHARIAH_FAIL.has(s)) return { status: 'fail', label: 'NOT HALAL', detail: 'This stock is involved in prohibited activities (interest-based banking, alcohol, tobacco, or gambling). Avoid.' };
  if (SHARIAH_WARN.has(s)) return { status: 'warn', label: 'NEEDS SCREENING', detail: 'This sector requires additional Shariah screening. Consult a Shariah advisor before trading.' };
  if (SHARIAH_PASS.has(s)) return { status: 'pass', label: 'HALAL', detail: 'This stock passes basic Shariah screening criteria. Not involved in prohibited activities.' };
  // Default for unknown — warn
  return { status: 'warn', label: 'UNVERIFIED', detail: 'Shariah status unverified. Please check with SC Malaysia list or DJIM index before trading.' };
}

// ── Technical calculations ───────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = (gains / period) / ((losses / period) || 0.001);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function calcMA(closes, period) {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function rsiSignal(rsi) {
  if (rsi < 30) return { label: 'OVERSOLD', note: 'Potential buy opportunity — price may bounce', score: 30 };
  if (rsi < 50) return { label: 'RECOVERING', note: 'RSI recovering from oversold — good swing entry zone', score: 25 };
  if (rsi < 65) return { label: 'NEUTRAL', note: 'RSI in neutral zone — trend is healthy', score: 15 };
  if (rsi < 75) return { label: 'STRONG', note: 'RSI elevated — momentum strong but watch for pullback', score: 5 };
  return { label: 'OVERBOUGHT', note: 'RSI overbought — avoid buying now, wait for pullback', score: -10 };
}

function maSignal(price, ma20, ma50) {
  if (price > ma20 && ma20 > ma50) return { label: 'BULLISH', note: 'Price above both MAs — strong uptrend', score: 25 };
  if (price > ma20 && ma20 < ma50) return { label: 'RECOVERING', note: 'Price above MA20 but below MA50 — early recovery', score: 15 };
  if (price < ma20 && ma20 > ma50) return { label: 'PULLBACK', note: 'Short-term pullback in uptrend — watch for entry', score: 10 };
  return { label: 'BEARISH', note: 'Price below both MAs — downtrend, avoid entry', score: -10 };
}

function volSignal(volRatio) {
  if (volRatio >= 2.0) return { label: 'VERY HIGH', note: 'Strong volume surge — high conviction move', score: 20 };
  if (volRatio >= 1.3) return { label: 'HIGH', note: 'Above average volume — good momentum confirmation', score: 15 };
  if (volRatio >= 0.7) return { label: 'NORMAL', note: 'Normal volume — no strong signal', score: 5 };
  return { label: 'LOW', note: 'Low volume — weak conviction, be cautious', score: 0 };
}

function calcRisk(price, rsi) {
  // Stop loss: 3% below entry, take profit: 6% above (1:2 risk reward)
  const stopLoss = parseFloat((price * 0.97).toFixed(4));
  const takeProfit = parseFloat((price * 1.06).toFixed(4));
  const riskReward = '1:2';
  const maxShares = Math.floor(20 / (price * 0.03)); // Max shares to risk $20 (2% of $1000)
  return { stopLoss, takeProfit, riskReward, maxShares: maxShares > 0 ? maxShares : 1 };
}

function gutCheck(symbol, signal, rsi) {
  if (signal === 'BUY') return `You're about to paper trade ${symbol}. Before you proceed — is this decision based on the data above, or did you see someone recommend it online? What is your exit plan if it drops 3%?`;
  if (signal === 'CAUTION') return `The bot flagged ${symbol} as CAUTION. Are you still considering it because you feel you're "missing out"? FOMO is how losses happen. What specific data is making you want to enter?`;
  return `The bot says AVOID for ${symbol}. If you're still thinking about trading it, ask yourself: are you trying to prove the bot wrong? What do you know that the data doesn't show?`;
}

// ── Fetch + analyse one stock ────────────────────────────────────────────────
async function analyseStock(symbol, exchange, market, name) {
  // Time series
  let url = `${TD_BASE}/time_series?symbol=${symbol}&interval=1day&outputsize=60&apikey=${TD_KEY}`;
  if (exchange) url += `&exchange=${exchange}`;
  const tsRes = await fetch(url);
  const tsData = await tsRes.json();
  if (tsData.status === 'error' || !tsData.values) return null;

  const sorted = tsData.values.slice().reverse();
  const closes = sorted.map(v => parseFloat(v.close));
  const volumes = sorted.map(v => parseFloat(v.volume || 0));
  const price = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2] || price;

  const rsi = calcRSI(closes);
  const ma20 = calcMA(closes, Math.min(20, closes.length));
  const ma50 = calcMA(closes, Math.min(50, closes.length));
  const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length);
  const lastVol = volumes[volumes.length - 1] || avgVol;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const changePct = ((price - prevPrice) / prevPrice * 100).toFixed(2);

  const shariah = shariahCheck(symbol);
  const rsiSig = rsiSignal(rsi);
  const maSig = maSignal(price, ma20, ma50);
  const volSig = volSignal(volRatio);
  const risk = calcRisk(price, rsi);

  // Score (max 100)
  let score = 0;
  if (shariah.status === 'pass') score += rsiSig.score + maSig.score + volSig.score;
  else if (shariah.status === 'warn') score += (rsiSig.score + maSig.score + volSig.score) * 0.5;
  // Shariah fail = score stays 0

  const signal = shariah.status === 'fail' ? 'AVOID' : score >= 55 ? 'BUY' : score >= 30 ? 'CAUTION' : 'AVOID';

  return {
    symbol, name, market, price: parseFloat(price.toFixed(4)),
    changePct: parseFloat(changePct),
    rsi, ma20: parseFloat(ma20.toFixed(4)), ma50: parseFloat(ma50.toFixed(4)),
    volRatio: parseFloat(volRatio.toFixed(2)),
    score, signal,
    shariah,
    technical: {
      rsi: { value: rsi, ...rsiSig },
      ma: { value: { ma20: ma20.toFixed(4), ma50: ma50.toFixed(4) }, ...maSig },
      volume: { value: volRatio.toFixed(2), ...volSig }
    },
    risk,
    gutCheck: gutCheck(symbol, signal, rsi)
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'TradeWise server is running' }));

app.get('/analyse', async (req, res) => {
  try {
    const { symbol, exchange, market, name } = req.query;
    if (!symbol) return res.status(400).json({ error: 'Symbol required' });
    const result = await analyseStock(symbol, exchange || '', market || 'US', name || symbol);
    if (!result) return res.status(404).json({ error: `No data found for ${symbol}` });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/scan', async (req, res) => {
  const watchlist = [
    { symbol: 'AAPL',  exchange: '', market: 'US', name: 'Apple' },
    { symbol: 'MSFT',  exchange: '', market: 'US', name: 'Microsoft' },
    { symbol: 'GOOGL', exchange: '', market: 'US', name: 'Alphabet' },
    { symbol: 'AMZN',  exchange: '', market: 'US', name: 'Amazon' },
    { symbol: 'TSLA',  exchange: '', market: 'US', name: 'Tesla' },
    { symbol: 'NVDA',  exchange: '', market: 'US', name: 'NVIDIA' },
    { symbol: 'META',  exchange: '', market: 'US', name: 'Meta' },
    { symbol: '1155',  exchange: 'KLSE', market: 'MY', name: 'Maybank' },
    { symbol: '5347',  exchange: 'KLSE', market: 'MY', name: 'Tenaga Nasional' },
    { symbol: '0166',  exchange: 'KLSE', market: 'MY', name: 'Inari Amertron' },
    { symbol: '7277',  exchange: 'KLSE', market: 'MY', name: 'Dialog Group' },
    { symbol: '5225',  exchange: 'KLSE', market: 'MY', name: 'IHH Healthcare' },
    { symbol: '0215',  exchange: 'KLSE', market: 'MY', name: 'Solarvest' },
    { symbol: '5398',  exchange: 'KLSE', market: 'MY', name: 'Gamuda' },
    { symbol: '1295',  exchange: 'KLSE', market: 'MY', name: 'Public Bank' },
    { symbol: 'BTC/USD', exchange: '', market: 'CRYPTO', name: 'Bitcoin' },
    { symbol: 'ETH/USD', exchange: '', market: 'CRYPTO', name: 'Ethereum' },
  ];

  const results = [];
  for (const stock of watchlist) {
    try {
      const r = await analyseStock(stock.symbol, stock.exchange, stock.market, stock.name);
      if (r) results.push(r);
    } catch (_) { continue; }
  }

  const top5 = results.sort((a, b) => b.score - a.score).slice(0, 5);
  res.json({ picks: top5, scannedAt: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`TradeWise server running on port ${PORT}`));
