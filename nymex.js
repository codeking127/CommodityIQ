// api/nymex.js — Vercel Serverless Function
// Proxies Yahoo Finance on the server side.
// Browser calls /api/nymex → this function calls Yahoo → returns clean JSON.
// No CORS issues because server-to-server has no origin restrictions.

export default async function handler(req, res) {
  // Allow your Vercel domain to call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const url =
    'https://query1.finance.yahoo.com/v8/finance/chart/NG%3DF' +
    '?interval=1d&range=5d&includePrePost=false';

  try {
    const upstream = await fetch(url, {
      headers: {
        // Mimic a real browser so Yahoo doesn't reject the request
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://finance.yahoo.com/',
        'Origin': 'https://finance.yahoo.com',
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: 'Yahoo Finance returned ' + upstream.status,
      });
    }

    const data = await upstream.json();

    // Validate structure before sending to client
    const result = data?.chart?.result?.[0];
    if (!result) {
      return res.status(502).json({ error: 'No chart data in Yahoo response' });
    }

    const meta      = result.meta;
    const price     = meta.regularMarketPrice;
    const prevClose = meta.previousClose
                   || meta.chartPreviousClose
                   || meta.regularMarketPreviousClose;

    if (!price) {
      return res.status(502).json({ error: 'Price missing from Yahoo response' });
    }

    const quotes    = result.indicators?.quote?.[0] || {};
    const closes    = (quotes.close  || []).filter(v => v != null);
    const highs     = (quotes.high   || []).filter(v => v != null);
    const lows      = (quotes.low    || []).filter(v => v != null);
    const volumes   = (quotes.volume || []).filter(v => v != null);

    // Return only what the app needs — keeps payload tiny
    return res.status(200).json({
      price,
      prevClose,
      high52:  meta.fiftyTwoWeekHigh  || null,
      low52:   meta.fiftyTwoWeekLow   || null,
      volume:  volumes.length ? volumes[volumes.length - 1] : 0,
      dayHigh: highs.length  ? Math.max(...highs)  : price,
      dayLow:  lows.length   ? Math.min(...lows)   : price,
      closes,   // array newest-last, used for MA/RSI in client
      highs,
      lows,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
