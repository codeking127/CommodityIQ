// api/market.js — Vercel Serverless Function
// Fetches all market data via Alpha Vantage API server-side.
// Single endpoint — browser calls /api/market, gets everything back.
//
// Alpha Vantage free tier: 25 calls/day
// This function uses 5 calls per fetch:
//   1. NATURAL_GAS  — daily NG price series
//   2. CURRENCY_EXCHANGE_RATE — USD/INR live
//   3. RSI — RSI-14 on NG=F daily
//   4. SMA(50) — 50-day MA on NG=F
//   5. SMA(200) — 200-day MA on NG=F

const AV_KEY = process.env.AV_KEY || 'MQ2O61LI1N85F2YC';
const AV = 'https://www.alphavantage.co/query';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Fire all 5 calls in parallel ──────────────────────────
    const [ngRes, fxRes, rsiRes, sma50Res, sma200Res] = await Promise.all([
      av('NATURAL_GAS', { interval: 'daily' }),
      av('CURRENCY_EXCHANGE_RATE', { from_currency: 'USD', to_currency: 'INR' }),
      av('RSI', { symbol: 'NG=F', interval: 'daily', time_period: 14, series_type: 'close' }),
      av('SMA', { symbol: 'NG=F', interval: 'daily', time_period: 50, series_type: 'close' }),
      av('SMA', { symbol: 'NG=F', interval: 'daily', time_period: 200, series_type: 'close' }),
    ]);

    // ── 1. Parse Natural Gas price series ─────────────────────
    // Response: { "data": [ { "date": "2025-06-03", "value": "3.21" }, ... ] }
    const ngData  = ngRes?.data || [];
    if (!ngData.length) throw new Error('AV: No Natural Gas data returned. Check API key.');

    // Sort descending by date (usually already is)
    ngData.sort((a, b) => new Date(b.date) - new Date(a.date));

    const latestNG   = parseFloat(ngData[0].value);
    const prevNG     = parseFloat(ngData[1]?.value) || latestNG;
    const dayChange  = latestNG - prevNG;
    const dayChgPct  = prevNG > 0 ? (dayChange / prevNG) * 100 : 0;

    // 52-week high/low from data array (252 trading days)
    const year252    = ngData.slice(0, 252).map(d => parseFloat(d.value)).filter(v => !isNaN(v));
    const high52     = year252.length ? Math.max(...year252) : latestNG * 1.3;
    const low52      = year252.length ? Math.min(...year252) : latestNG * 0.7;

    // Support/resistance from last 10 days swing highs/lows
    const last10     = year252.slice(0, 10);
    const support    = last10.length ? Math.min(...last10).toFixed(3) : (latestNG * 0.97).toFixed(3);
    const resistance = last10.length ? Math.max(...last10).toFixed(3) : (latestNG * 1.03).toFixed(3);

    // ── 2. Parse USD/INR ──────────────────────────────────────
    // Response: { "Realtime Currency Exchange Rate": { "5. Exchange Rate": "95.79" } }
    const fxBlock = fxRes?.['Realtime Currency Exchange Rate'];
    const usdInr  = fxBlock ? parseFloat(fxBlock['5. Exchange Rate']) : null;
    const fxTime  = fxBlock?.['6. Last Refreshed'] || '';

    // ── 3. Parse RSI ──────────────────────────────────────────
    // Response: { "Technical Analysis: RSI": { "2025-06-03": { "RSI": "54.32" } } }
    const rsiSeries  = rsiRes?.['Technical Analysis: RSI'] || {};
    const rsiDates   = Object.keys(rsiSeries).sort((a, b) => new Date(b) - new Date(a));
    const rsiVal     = rsiDates.length ? parseFloat(rsiSeries[rsiDates[0]]['RSI']) : 50;

    // ── 4. Parse SMA 50 ───────────────────────────────────────
    const sma50Series = sma50Res?.['Technical Analysis: SMA'] || {};
    const sma50Dates  = Object.keys(sma50Series).sort((a, b) => new Date(b) - new Date(a));
    const sma50Val    = sma50Dates.length ? parseFloat(sma50Series[sma50Dates[0]]['SMA']) : latestNG * 0.985;

    // ── 5. Parse SMA 200 ──────────────────────────────────────
    const sma200Series = sma200Res?.['Technical Analysis: SMA'] || {};
    const sma200Dates  = Object.keys(sma200Series).sort((a, b) => new Date(b) - new Date(a));
    const sma200Val    = sma200Dates.length ? parseFloat(sma200Series[sma200Dates[0]]['SMA']) : latestNG * 0.930;

    // ── MACD signal (derived from price vs SMA) ───────────────
    const macdSignal = latestNG > sma50Val ? 'Positive' : 'Negative';

    // ── Bull score ─────────────────────────────────────────────
    let score = 5;
    if (dayChgPct > 1)  score++;
    if (dayChgPct > 2)  score++;
    if (dayChgPct < -1) score--;
    if (dayChgPct < -2) score--;
    const range52 = high52 - low52;
    if (range52 > 0) {
      const pos = (latestNG - low52) / range52;
      if (pos > 0.7) score++;
      if (pos < 0.3) score--;
    }
    if (rsiVal > 55) score++;
    if (rsiVal < 45) score--;
    score = Math.min(10, Math.max(1, score));

    // ── MCX estimate ──────────────────────────────────────────
    let mcx = null;
    if (usdInr) {
      const raw      = latestNG * usdInr * 0.98;
      const prevRaw  = prevNG   * usdInr * 0.98;
      const mcxChg   = raw - prevRaw;
      const mcxChgPc = prevRaw > 0 ? (mcxChg / prevRaw) * 100 : 0;
      mcx = {
        price:      raw.toFixed(0),
        prevPrice:  prevRaw.toFixed(0),
        dayChg:     mcxChg.toFixed(0),
        dayChgPct:  mcxChgPc.toFixed(2),
        buyZone:    (raw * 0.985).toFixed(0) + '–' + (raw * 0.995).toFixed(0),
        sellZone:   (raw * 1.005).toFixed(0) + '–' + (raw * 1.015).toFixed(0),
        support:    (raw * 0.97).toFixed(0),
        resistance: (raw * 1.03).toFixed(0),
      };
    }

    // ── Return clean payload ──────────────────────────────────
    return res.status(200).json({
      nymex: {
        price:      latestNG,
        prevClose:  prevNG,
        dayChange,
        dayChangePct: dayChgPct,
        high52,
        low52,
        support,
        resistance,
        rsi:        rsiVal.toFixed(1),
        macd:       macdSignal,
        ma50:       sma50Val.toFixed(3),
        ma200:      sma200Val.toFixed(3),
        bullScore:  score,
        latestDate: ngData[0].date,
        symbol:     'NATURAL_GAS (Alpha Vantage)',
      },
      fx: {
        rate:   usdInr,
        lastRefreshed: fxTime,
        note:   usdInr ? 'Live via Alpha Vantage' : 'FX unavailable',
      },
      mcx,
    });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Alpha Vantage fetch helper ────────────────────────────────
async function av(fn, params = {}) {
  const qs = new URLSearchParams({ function: fn, apikey: AV_KEY, ...params });
  const url = `${AV}?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`AV ${fn} HTTP ${res.status}`);
  const data = await res.json();

  // Alpha Vantage error responses
  if (data?.['Error Message'])
    throw new Error(`AV ${fn}: ${data['Error Message']}`);
  if (data?.['Note'])
    throw new Error(`AV rate limit hit: ${data['Note']}`);
  if (data?.['Information'])
    throw new Error(`AV limit: ${data['Information']}`);

  return data;
}
