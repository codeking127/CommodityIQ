// api/nymex.js — Vercel Serverless Function
// Fetches NYMEX Natural Gas (NG=F) + USD/INR live rate
// Both via Yahoo Finance server-side — same source as Google

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Fetch NYMEX and USD/INR in parallel
  const [nymexResult, fxResult] = await Promise.allSettled([
    fetchNYMEX(),
    fetchUSDINR()
  ]);

  const nymexData = nymexResult.status === 'fulfilled' ? nymexResult.value : null;
  const fxData    = fxResult.status    === 'fulfilled' ? fxResult.value    : null;

  if (!nymexData && !fxData) {
    const err = [nymexResult.reason?.message, fxResult.reason?.message].filter(Boolean).join(' | ');
    return res.status(502).json({ error: 'All sources failed: ' + err });
  }

  return res.status(200).json({
    // NYMEX data
    ...(nymexData || { nymexError: nymexResult.reason?.message }),
    // USD/INR live rate
    usdInr:       fxData?.rate     || null,
    usdInrNote:   fxData?.note     || (fxResult.reason?.message || 'unavailable'),
    usdInrSource: fxData?.source   || null,
  });
}

// ── Fetch NYMEX Natural Gas ───────────────────────────────────
async function fetchNYMEX() {
  const errors = [];

  try { return await fetchYahooCrumb('NG%3DF'); }
  catch(e) { errors.push('crumb: ' + e.message); }

  try { return await fetchYahooV7('NG%3DF'); }
  catch(e) { errors.push('v7: ' + e.message); }

  try { return await fetchNasdaq(); }
  catch(e) { errors.push('nasdaq: ' + e.message); }

  throw new Error('NYMEX all sources failed — ' + errors.join(' | '));
}

// ── Fetch USD/INR via Yahoo Finance ──────────────────────────
// Yahoo symbol for USD/INR spot rate is USDINR=X
async function fetchUSDINR() {
  const errors = [];

  // Try Yahoo crumb approach first
  try {
    const d = await fetchYahooCrumb('USDINR%3DX');
    return {
      rate:   d.price,
      note:   'Live · Yahoo Finance',
      source: 'Yahoo Finance USDINR=X'
    };
  } catch(e) { errors.push('crumb: ' + e.message); }

  // Try Yahoo v7
  try {
    const d = await fetchYahooV7('USDINR%3DX');
    return {
      rate:   d.price,
      note:   'Live · Yahoo Finance',
      source: 'Yahoo Finance USDINR=X'
    };
  } catch(e) { errors.push('v7: ' + e.message); }

  // Fallback: Frankfurter ECB rate
  try {
    const r = await fetchWithTimeout(
      'https://api.frankfurter.app/latest?from=USD&to=INR', {}, 8000
    );
    const d = await r.json();
    const rate = d?.rates?.INR;
    if (!rate) throw new Error('no INR in response');
    return {
      rate:   parseFloat(rate),
      note:   'ECB rate · Frankfurter',
      source: 'Frankfurter/ECB'
    };
  } catch(e) { errors.push('frankfurter: ' + e.message); }

  throw new Error('USD/INR all sources failed — ' + errors.join(' | '));
}

// ── Yahoo Finance with crumb auth (works for any symbol) ─────
async function fetchYahooCrumb(symbol) {
  const pageRes = await fetchWithTimeout(
    `https://finance.yahoo.com/quote/${symbol}/`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    },
    8000
  );

  const setCookie   = pageRes.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/A1=([^;]+)/);
  const cookie      = cookieMatch ? 'A1=' + cookieMatch[1] : '';

  const crumbRes = await fetchWithTimeout(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': cookie } },
    6000
  );
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes('<') || crumb.length > 20) {
    throw new Error('Invalid crumb: ' + crumb.substring(0, 30));
  }

  const quoteRes = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=5d&includePrePost=false&crumb=${encodeURIComponent(crumb)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Cookie': cookie,
        'Accept': 'application/json',
      }
    },
    10000
  );

  const text = await quoteRes.text();
  if (text.startsWith('<') || text.startsWith('The')) {
    throw new Error('Got HTML: ' + text.substring(0, 50));
  }

  return parseYahooV8(JSON.parse(text));
}

// ── Yahoo Finance v7 quote ────────────────────────────────────
async function fetchYahooV7(symbol) {
  const res = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow,regularMarketDayHigh,regularMarketDayLow`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com',
      }
    },
    10000
  );

  const text = await res.text();
  if (text.startsWith('<') || text.startsWith('The')) {
    throw new Error('Got HTML: ' + text.substring(0, 50));
  }

  const data = JSON.parse(text);
  const q    = data?.quoteResponse?.result?.[0];
  if (!q) throw new Error('No result in v7 response');

  const price     = q.regularMarketPrice;
  const prevClose = q.regularMarketPreviousClose || price;
  if (!price) throw new Error('No price in v7 response');

  return buildResult(price, prevClose,
    q.fiftyTwoWeekHigh, q.fiftyTwoWeekLow,
    q.regularMarketVolume,
    q.regularMarketDayHigh, q.regularMarketDayLow,
    [], [], []);
}

// ── Nasdaq API (NYMEX fallback only) ─────────────────────────
async function fetchNasdaq() {
  const now    = new Date();
  const months = ['F','G','H','J','K','M','N','Q','U','V','X','Z'];
  const year   = now.getFullYear().toString().slice(-2);
  const symbol = 'NG' + months[now.getMonth()] + year;

  const res = await fetchWithTimeout(
    `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=futures`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.nasdaq.com/',
        'Origin': 'https://www.nasdaq.com',
      }
    },
    10000
  );

  const data = JSON.parse(await res.text());
  const info = data?.data?.primaryData;
  if (!info) throw new Error('No primaryData in Nasdaq response');

  const price     = parseFloat(info.lastSalePrice?.replace(/[^0-9.]/g, ''));
  const prevClose = parseFloat(info.previousClose?.replace(/[^0-9.]/g, '')) || price;
  if (!price || isNaN(price)) throw new Error('Invalid price: ' + info.lastSalePrice);

  const high52 = parseFloat(data?.data?.keyStats?.['52WeekHighLow']?.value?.split('/')[0]?.trim()) || price * 1.3;
  const low52  = parseFloat(data?.data?.keyStats?.['52WeekHighLow']?.value?.split('/')[1]?.trim()) || price * 0.7;

  return buildResult(price, prevClose, high52, low52, 0, price + 0.05, price - 0.05, [], [], []);
}

// ── Parse Yahoo v8 chart response ────────────────────────────
function parseYahooV8(data) {
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No chart.result in Yahoo v8 response');

  const meta      = result.meta;
  const price     = meta.regularMarketPrice;
  const prevClose = meta.previousClose || meta.chartPreviousClose;
  if (!price) throw new Error('No price in Yahoo v8 meta');

  const q      = result.indicators?.quote?.[0] || {};
  const closes = (q.close  || []).filter(v => v != null);
  const highs  = (q.high   || []).filter(v => v != null);
  const lows   = (q.low    || []).filter(v => v != null);
  const vols   = (q.volume || []).filter(v => v != null);

  return buildResult(
    price, prevClose,
    meta.fiftyTwoWeekHigh, meta.fiftyTwoWeekLow,
    vols.length ? vols[vols.length - 1] : 0,
    highs.length ? Math.max(...highs) : price,
    lows.length  ? Math.min(...lows)  : price,
    closes, highs, lows
  );
}

// ── Shared result builder ────────────────────────────────────
function buildResult(price, prevClose, high52, low52, volume, dayHigh, dayLow, closes, highs, lows) {
  return {
    price:     parseFloat(price),
    prevClose: parseFloat(prevClose) || parseFloat(price),
    high52:    parseFloat(high52)    || parseFloat(price) * 1.3,
    low52:     parseFloat(low52)     || parseFloat(price) * 0.7,
    volume:    parseInt(volume)      || 0,
    dayHigh:   parseFloat(dayHigh)   || parseFloat(price),
    dayLow:    parseFloat(dayLow)    || parseFloat(price),
    closes,
    highs,
    lows,
  };
}

// ── Fetch with timeout ───────────────────────────────────────
function fetchWithTimeout(url, options, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out after ' + ms + 'ms')), ms);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}
