// api/market.js — Vercel Serverless Function
// Alpha Vantage free tier: 25 calls/day, 1 call/second max burst
// We make 5 calls sequentially with 1.2s delay between each
// Total time: ~6 seconds — acceptable for a daily intelligence report

const AV_KEY = process.env.AV_KEY || 'MQ2O61LI1N85F2YC';
const AV_BASE = 'https://www.alphavantage.co/query';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── Sequential calls with 1.2s gap to respect 1 req/sec limit ──

    // Call 1: Natural Gas daily series
    const ngRes = await av('NATURAL_GAS', { interval: 'daily' });
    await sleep(1200);

    // Call 2: USD/INR exchange rate
    const fxRes = await av('CURRENCY_EXCHANGE_RATE', {
      from_currency: 'USD',
      to_currency: 'INR'
    });
    await sleep(1200);

    // Call 3: RSI-14
    const rsiRes = await av('RSI', {
      symbol: 'NG=F',
      interval: 'daily',
      time_period: 14,
      series_type: 'close'
    });
    await sleep(1200);

    // Call 4: SMA-50
    const sma50Res = await av('SMA', {
      symbol: 'NG=F',
      interval: 'daily',
      time_period: 50,
      series_type: 'close'
    });
    await sleep(1200);

    // Call 5: SMA-200
    const sma200Res = await av('SMA', {
      symbol: 'NG=F',
      interval: 'daily',
      time_period: 200,
      series_type: 'close'
    });

    // ── Parse Natural Gas price series ──────────────────────────
    const ngData = ngRes?.data || [];
    if (!ngData.length) throw new Error('No Natural Gas data returned');

    ngData.sort((a, b) => new Date(b.date) - new Date(a.date));

    const latestNG  = parseFloat(ngData[0].value);
    const prevNG    = parseFloat(ngData[1]?.value) || latestNG;
    const dayChange = latestNG - prevNG;
    const dayChgPct = prevNG > 0 ? (dayChange / prevNG) * 100 : 0;

    // 52-week high/low
    const year252   = ngData.slice(0, 252).map(d => parseFloat(d.value)).filter(v => !isNaN(v));
    const high52    = year252.length ? Math.max(...year252) : latestNG * 1.3;
    const low52     = year252.length ? Math.min(...year252) : latestNG * 0.7;

    // Support/resistance from last 10 days
    const last10     = year252.slice(0, 10);
    const support    = last10.length ? Math.min(...last10).toFixed(3) : (latestNG * 0.97).toFixed(3);
    const resistance = last10.length ? Math.max(...last10).toFixed(3) : (latestNG * 1.03).toFixed(3);

    // ── Parse USD/INR ────────────────────────────────────────────
    const fxBlock = fxRes?.['Realtime Currency Exchange Rate'];
    const usdInr  = fxBlock ? parseFloat(fxBlock['5. Exchange Rate']) : null;
    const fxTime  = fxBlock?.['6. Last Refreshed'] || '';

    // ── Parse RSI ────────────────────────────────────────────────
    const rsiSeries = rsiRes?.['Technical Analysis: RSI'] || {};
    const rsiDates  = Object.keys(rsiSeries).sort((a, b) => new Date(b) - new Date(a));
    const rsiVal    = rsiDates.length ? parseFloat(rsiSeries[rsiDates[0]]['RSI']) : 50;

    // ── Parse SMA-50 ─────────────────────────────────────────────
    const sma50Series = sma50Res?.['Technical Analysis: SMA'] || {};
    const sma50Dates  = Object.keys(sma50Series).sort((a, b) => new Date(b) - new Date(a));
    const sma50Val    = sma50Dates.length
      ? parseFloat(sma50Series[sma50Dates[0]]['SMA'])
      : latestNG * 0.985;

    // ── Parse SMA-200 ────────────────────────────────────────────
    const sma200Series = sma200Res?.['Technical Analysis: SMA'] || {};
    const sma200Dates  = Object.keys(sma200Series).sort((a, b) => new Date(b) - new Date(a));
    const sma200Val    = sma200Dates.length
      ? parseFloat(sma200Series[sma200Dates[0]]['SMA'])
      : latestNG * 0.930;

    // ── MACD proxy ───────────────────────────────────────────────
    const macdSignal = latestNG > sma50Val ? 'Positive' : 'Negative';

    // ── Bull score ───────────────────────────────────────────────
    let score = 5;
    if (dayChgPct >  1) score++;
    if (dayChgPct >  2) score++;
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

    // ── MCX estimate ─────────────────────────────────────────────
    let mcx = null;
    if (usdInr) {
      const raw      = latestNG  * usdInr * 0.98;
      const prevRaw  = prevNG    * usdInr * 0.98;
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

    return res.status(200).json({
      nymex: {
        price:        latestNG,
        prevClose:    prevNG,
        dayChange,
        dayChangePct: dayChgPct,
        high52,
        low52,
        support,
        resistance,
        rsi:          rsiVal.toFixed(1),
        macd:         macdSignal,
        ma50:         sma50Val.toFixed(3),
        ma200:        sma200Val.toFixed(3),
        bullScore:    score,
        latestDate:   ngData[0].date,
        symbol:       'NATURAL_GAS · Alpha Vantage',
      },
      fx: {
        rate:          usdInr,
        lastRefreshed: fxTime,
        note:          usdInr ? 'Live · Alpha Vantage' : 'FX unavailable',
      },
      mcx,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Sequential-safe Alpha Vantage fetch ──────────────────────
async function av(fn, params = {}) {
  const qs  = new URLSearchParams({ function: fn, apikey: AV_KEY, ...params });
  const url = `${AV_BASE}?${qs}`;
  const r   = await fetch(url);
  if (!r.ok) throw new Error(`AV ${fn} HTTP ${r.status}`);

  const data = await r.json();

  if (data?.['Error Message'])
    throw new Error(`AV ${fn}: ${data['Error Message']}`);

  // Rate limit messages — surface clearly
  if (data?.['Note'])
    throw new Error(`AV rate limit: ${data['Note']}`);

  if (data?.['Information'])
    throw new Error(`AV limit: ${data['Information']}`);

  return data;
}

// ── Simple sleep helper ───────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
