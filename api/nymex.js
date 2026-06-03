// api/nymex.js — Vercel Serverless Function
// Fetches NYMEX Natural Gas (NG=F) price using a 3-source waterfall.
// All requests are server-side so no CORS issues.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const errors = [];

  // ── Source 1: Yahoo Finance with crumb (proper auth flow) ──
  try {
    const data = await fetchYahooCrumb();
    return res.status(200).json(data);
  } catch(e) {
    errors.push('Yahoo crumb: ' + e.message);
  }

  // ── Source 2: Yahoo Finance v7 quote (simpler endpoint) ──
  try {
    const data = await fetchYahooV7();
    return res.status(200).json(data);
  } catch(e) {
    errors.push('Yahoo v7: ' + e.message);
  }

  // ── Source 3: Nasdaq API (no auth, no cookies needed) ──
  try {
    const data = await fetchNasdaq();
    return res.status(200).json(data);
  } catch(e) {
    errors.push('Nasdaq: ' + e.message);
  }

  // All failed
  return res.status(502).json({
    error: 'All sources failed: ' + errors.join(' | ')
  });
}

// ── Yahoo Finance with crumb auth ──
async function fetchYahooCrumb() {
  // Step 1: get cookie from Yahoo finance page
  const pageRes = await fetchWithTimeout(
    'https://finance.yahoo.com/quote/NG%3DF/',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }
    },
    8000
  );

  // Extract cookie from response headers
  const setCookie = pageRes.headers.get('set-cookie') || '';
  const cookieMatch = setCookie.match(/A1=([^;]+)/);
  const cookie = cookieMatch ? 'A1=' + cookieMatch[1] : '';

  // Step 2: get crumb
  const crumbRes = await fetchWithTimeout(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie,
      }
    },
    6000
  );
  const crumb = await crumbRes.text();
  if (!crumb || crumb.includes('<') || crumb.length > 20) {
    throw new Error('Invalid crumb: ' + crumb.substring(0, 30));
  }

  // Step 3: fetch quote with crumb
  const quoteRes = await fetchWithTimeout(
    `https://query1.finance.yahoo.com/v8/finance/chart/NG%3DF?interval=1d&range=5d&includePrePost=false&crumb=${encodeURIComponent(crumb)}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': cookie,
        'Accept': 'application/json',
      }
    },
    10000
  );

  const text = await quoteRes.text();
  if (text.startsWith('<') || text.startsWith('The')) {
    throw new Error('Got HTML instead of JSON: ' + text.substring(0, 50));
  }

  const data = JSON.parse(text);
  return parseYahooV8(data);
}

// ── Yahoo Finance v7 quote (no crumb needed sometimes) ──
async function fetchYahooV7() {
  const res = await fetchWithTimeout(
    'https://query1.finance.yahoo.com/v7/finance/quote?symbols=NG%3DF&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketVolume,fiftyTwoWeekHigh,fiftyTwoWeekLow,regularMarketDayHigh,regularMarketDayLow',
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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
  const q = data?.quoteResponse?.result?.[0];
  if (!q) throw new Error('No result in v7 response');

  const price     = q.regularMarketPrice;
  const prevClose = q.regularMarketPreviousClose || price;
  if (!price) throw new Error('No price in v7 response');

  return buildResult(
    price, prevClose,
    q.fiftyTwoWeekHigh, q.fiftyTwoWeekLow,
    q.regularMarketVolume,
    q.regularMarketDayHigh, q.regularMarketDayLow,
    [], [], []
  );
}

// ── Nasdaq API (final fallback, no auth) ──
async function fetchNasdaq() {
  // Nasdaq uses month codes: F=Jan G=Feb H=Mar J=Apr K=May M=Jun
  // N=Jul Q=Aug U=Sep V=Oct X=Nov Z=Dec
  // Get current front month
  const now = new Date();
  const months = ['F','G','H','J','K','M','N','Q','U','V','X','Z'];
  const year = now.getFullYear().toString().slice(-2);
  const symbol = 'NG' + months[now.getMonth()] + year;

  const res = await fetchWithTimeout(
    `https://api.nasdaq.com/api/quote/${symbol}/info?assetclass=futures`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.nasdaq.com/',
        'Origin': 'https://www.nasdaq.com',
      }
    },
    10000
  );

  const text = await res.text();
  const data = JSON.parse(text);

  const info = data?.data?.primaryData;
  if (!info) throw new Error('No primaryData in Nasdaq response');

  const price     = parseFloat(info.lastSalePrice?.replace(/[^0-9.]/g, ''));
  const prevClose = parseFloat(info.previousClose?.replace(/[^0-9.]/g, '')) || price;
  const netChg    = parseFloat(info.netChange?.replace(/[^0-9.-]/g, '')) || 0;

  if (!price || isNaN(price)) throw new Error('Invalid price from Nasdaq: ' + info.lastSalePrice);

  const high52    = parseFloat(data?.data?.keyStats?.['52WeekHighLow']?.value?.split('/')[0]?.trim()) || price * 1.3;
  const low52     = parseFloat(data?.data?.keyStats?.['52WeekHighLow']?.value?.split('/')[1]?.trim()) || price * 0.7;

  return buildResult(price, prevClose, high52, low52, 0, price + 0.05, price - 0.05, [], [], []);
}

// ── Parse Yahoo v8 chart response ──
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

// ── Shared result builder ──
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

// ── Fetch with timeout ──
function fetchWithTimeout(url, options, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out after ' + ms + 'ms')), ms);
    fetch(url, options)
      .then(r => { clearTimeout(timer); resolve(r); })
      .catch(e => { clearTimeout(timer); reject(e); });
  });
}
