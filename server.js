const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const TD_KEY = '0bcdf4421d744302a25dbb6217743587';

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'TradeWise server is running' });
});

// Quote endpoint
app.get('/quote', async (req, res) => {
  try {
    const { symbol, exchange } = req.query;
    let url = `https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${TD_KEY}`;
    if (exchange) url += `&exchange=${exchange}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Time series endpoint
app.get('/time_series', async (req, res) => {
  try {
    const { symbol, exchange, interval, outputsize } = req.query;
    let url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=${interval || '1day'}&outputsize=${outputsize || 60}&apikey=${TD_KEY}`;
    if (exchange) url += `&exchange=${exchange}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scanner endpoint — scans watchlist and returns top 5 picks
app.get('/scan', async (req, res) => {
  const watchlist = [
    // US Shariah compliant
    { symbol: 'AAPL', exchange: '', market: 'US', name: 'Apple Inc' },
    { symbol: 'MSFT', exchange: '', market: 'US', name: 'Microsoft' },
    { symbol: 'GOOGL', exchange: '', market: 'US', name: 'Alphabet' },
    { symbol: 'AMZN', exchange: '', market: 'US', name: 'Amazon' },
    { symbol: 'TSLA', exchange: '', market: 'US', name: 'Tesla' },
    { symbol: 'NVDA', exchange: '', market: 'US', name: 'NVIDIA' },
    { symbol: 'META', exchange: '', market: 'US', name: 'Meta' },
    // Bursa Malaysia Shariah compliant
    { symbol: '1155', exchange: 'KLSE', market: 'MY', name: 'Maybank' },
    { symbol: '5347', exchange: 'KLSE', market: 'MY', name: 'Tenaga Nasional' },
    { symbol: '0166', exchange: 'KLSE', market: 'MY', name: 'Inari Amertron' },
    { symbol: '7277', exchange: 'KLSE', market: 'MY', name: 'Dialog Group' },
    { symbol: '5225', exchange: 'KLSE', market: 'MY', name: 'IHH Healthcare' },
    { symbol: '0215', exchange: 'KLSE', market: 'MY', name: 'Solarvest' },
    { symbol: '5398', exchange: 'KLSE', market: 'MY', name: 'Gamuda' },
    { symbol: '1295', exchange: 'KLSE', market: 'MY', name: 'Public Bank' },
    // Crypto
    { symbol: 'BTC/USD', exchange: '', market: 'CRYPTO', name: 'Bitcoin' },
    { symbol: 'ETH/USD', exchange: '', market: 'CRYPTO', name: 'Ethereum' },
  ];

  const results = [];

  for (const stock of watchlist) {
    try {
      let url = `https://api.twelvedata.com/time_series?symbol=${stock.symbol}&interval=1day&outputsize=60&apikey=${TD_KEY}`;
      if (stock.exchange) url += `&exchange=${stock.exchange}`;

      const response = await fetch(url);
      const data = await response.json();

      if (data.status === 'error' || !data.values) continue;

      const values = data.values.slice().reverse();
      const closes = values.map(v => parseFloat(v.close));
      const volumes = values.map(v => parseFloat(v.volume || 0));

      // RSI
      const rsi = calculateRSI(closes, 14);
      // MAs
      const ma20 = closes.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, closes.length);
      const ma50 = closes.slice(-50).reduce((a,b)=>a+b,0) / Math.min(50, closes.length);
      // Volume
      const avgVol = volumes.slice(-20).reduce((a,b)=>a+b,0) / Math.min(20, volumes.length);
      const lastVol = volumes[volumes.length-1];
      const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
      // Price
      const price = closes[closes.length-1];
      const prevPrice = closes[closes.length-2];
      const changePct = ((price - prevPrice) / prevPrice) * 100;

      // Score the stock for swing trade opportunity
      let score = 0;
      // RSI between 30-50 = oversold recovery = good swing entry
      if (rsi >= 30 && rsi <= 50) score += 30;
      else if (rsi >= 50 && rsi <= 65) score += 15;
      // Price above MA20 = uptrend
      if (price > ma20) score += 20;
      // MA20 above MA50 = bullish
      if (ma20 > ma50) score += 20;
      // Volume above average = momentum
      if (volRatio >= 1.2) score += 20;
      // Not too overbought
      if (rsi < 70) score += 10;

      results.push({
        ...stock,
        price: price.toFixed(4),
        changePct: changePct.toFixed(2),
        rsi: rsi.toFixed(1),
        ma20: ma20.toFixed(4),
        ma50: ma50.toFixed(4),
        volRatio: volRatio.toFixed(2),
        score,
        signal: score >= 60 ? 'BUY' : score >= 40 ? 'CAUTION' : 'AVOID'
      });

    } catch (e) { continue; }
  }

  // Sort by score, return top 5
  const top5 = results.sort((a,b) => b.score - a.score).slice(0, 5);
  res.json({ picks: top5, scannedAt: new Date().toISOString() });
});

function calculateRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

app.listen(PORT, () => {
  console.log(`TradeWise server running on port ${PORT}`);
});
