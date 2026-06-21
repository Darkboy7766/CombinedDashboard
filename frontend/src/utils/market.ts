const BINANCE_FAPI = 'https://fapi.binance.com';
const BYBIT_API = 'https://api.bybit.com';
const safe = (p: Promise<Response>) => p.then(r => r.json()).catch(() => null);

// Binance-style "1h"/"4h"/"1d" -> Bybit-style "60"/"240"/"D"
const toBybitInterval = (interval: string) => {
  const unit = interval.slice(-1);
  const num = parseInt(interval.slice(0, -1), 10);
  if (unit === 'm') return String(num);
  if (unit === 'h') return String(num * 60);
  if (unit === 'd') return num === 1 ? 'D' : String(num * 1440);
  if (unit === 'w') return 'W';
  return interval;
};

// Fetches the Binance URL; on failure (network error, rate limit, region
// block — `safe()` swallows the status code so we re-check it here) falls
// back to the equivalent Bybit call via `bybitFallback`.
async function withBybitFallback<T>(binanceUrl: string, bybitFallback: () => Promise<T | null>): Promise<T | null> {
  try {
    const res = await fetch(binanceUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    return bybitFallback();
  }
}

async function bybitKlines(norm: string, interval: string): Promise<any[] | null> {
  const data = await safe(fetch(`${BYBIT_API}/v5/market/kline?category=linear&symbol=${norm}&interval=${toBybitInterval(interval)}&limit=200`));
  const list = data?.result?.list;
  return Array.isArray(list) ? list.slice().reverse() : null;
}

async function bybitTicker(norm: string) {
  const data = await safe(fetch(`${BYBIT_API}/v5/market/tickers?category=linear&symbol=${norm}`));
  return data?.result?.list?.[0] ?? null;
}

async function bybitDepth(norm: string) {
  const data = await safe(fetch(`${BYBIT_API}/v5/market/orderbook?category=linear&symbol=${norm}&limit=50`));
  return data?.result ? { bids: data.result.b, asks: data.result.a } : null;
}

export async function fetchMarketSnapshot(symbol: string, apiBase: string) {
  const norm = symbol.replace(/[/\-\s]/g, '').toUpperCase();

  const [k1d, k4h, k1h, fundingRaw, oiRaw, oiHist, ls, depth, fng, gecko] = await Promise.all([
    withBybitFallback(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${norm}&interval=1d&limit=200`, () => bybitKlines(norm, '1d')),
    withBybitFallback(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${norm}&interval=4h&limit=200`, () => bybitKlines(norm, '4h')),
    withBybitFallback(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${norm}&interval=1h&limit=200`, () => bybitKlines(norm, '1h')),
    withBybitFallback(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${norm}`, () => bybitTicker(norm)),
    withBybitFallback(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${norm}`, () => bybitTicker(norm)),
    safe(fetch(`${apiBase}/api/binance/openInterestHist?symbol=${norm}&period=1h&limit=2`)),
    safe(fetch(`${apiBase}/api/binance/globalLongShortAccountRatio?symbol=${norm}&period=1h&limit=1`)),
    withBybitFallback(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${norm}&limit=100`, () => bybitDepth(norm)),
    safe(fetch('https://api.alternative.me/fng/')),
    safe(fetch('https://api.coingecko.com/api/v3/global')),
  ]);

  // Normalize whichever exchange answered into the field names used below.
  const funding = fundingRaw && 'lastFundingRate' in fundingRaw
    ? fundingRaw
    : fundingRaw ? { lastFundingRate: fundingRaw.fundingRate, markPrice: fundingRaw.markPrice } : null;
  const oi = oiRaw && 'openInterest' in oiRaw && !('fundingRate' in oiRaw)
    ? oiRaw
    : oiRaw ? { openInterest: oiRaw.openInterest } : null;

  const toOHLCV = (raw: any[][] | null) => (raw ?? []).map((d: any[]) => ({
    timestamp: d[0], open: +d[1], high: +d[2], low: +d[3], close: +d[4], volume: +d[5],
  }));

  const fr = parseFloat(funding?.lastFundingRate ?? '0');
  const markPrice = parseFloat(funding?.markPrice ?? '0');
  const currentOI = parseFloat(oi?.openInterest ?? '0');
  let oiDelta = 0;
  if (Array.isArray(oiHist) && oiHist.length >= 2) {
    const prev = +oiHist[0].sumOpenInterest, curr = +oiHist[1].sumOpenInterest;
    if (prev > 0) oiDelta = ((curr - prev) / prev) * 100;
  }
  const lsRow = Array.isArray(ls) ? ls[0] : null;
  const lsRatio = +(lsRow?.longShortRatio ?? 1);
  const longPct = +(lsRow?.longAccount ?? 0.5) * 100;
  const shortPct = +(lsRow?.shortAccount ?? 0.5) * 100;
  const bids: string[][] = (depth?.bids ?? []).slice(0, 50);
  const asks: string[][] = (depth?.asks ?? []).slice(0, 50);
  const bidVol = bids.reduce((s, [, v]) => s + +v, 0);
  const askVol = asks.reduce((s, [, v]) => s + +v, 0);
  const imb = askVol > 0 ? bidVol / askVol : 1;
  const fngVal = fng?.data?.[0] ? +fng.data[0].value : 50;
  const fngClass = fng?.data?.[0]?.value_classification ?? 'Neutral';
  const md = gecko?.data ?? {} as any;
  const now = new Date();

  return {
    symbol: norm,
    formatted_symbol: norm.endsWith('USDT') ? `${norm.slice(0, -4)}/USDT` : norm,
    timestamp: now.getTime() / 1000,
    time_string: now.toISOString().replace('T', ' ').slice(0, 19),
    ohlcv_1d: toOHLCV(k1d),
    ohlcv_4h: toOHLCV(k4h),
    ohlcv_1h: toOHLCV(k1h),
    funding_rate: {
      current_funding_rate: fr, current_funding_rate_pct: fr * 100,
      avg_funding_rate_10p: fr, avg_funding_rate_10p_pct: fr * 100,
      payer: fr > 0 ? 'Longs pay Shorts' : 'Shorts pay Longs', mark_price: markPrice,
    },
    open_interest: {
      open_interest: currentOI, oi_delta_1h_pct: oiDelta,
      capital_flow: oiDelta > 0 ? 'Capital Entering (Bullish/Trend strengthening)' : 'Capital Leaving (Bearish/Trend weakening)',
    },
    long_short_ratio: {
      long_short_ratio: lsRatio, long_account_pct: longPct, short_account_pct: shortPct,
      contrarian_signal: lsRatio > 2 ? 'Extreme Long Dominance (Potential Contrarian Bearish Signal)'
        : lsRatio < 0.5 ? 'Extreme Short Dominance (Potential Contrarian Bullish Signal)' : 'Neutral',
    },
    order_book: {
      bid_volume_top50: bidVol, ask_volume_top50: askVol, imbalance_ratio: imb,
      order_book_pressure: imb > 1.5 ? 'Buyers Dominating Order Book (Bullish Pressure)'
        : imb < 0.67 ? 'Sellers Dominating Order Book (Bearish Pressure)' : 'Neutral / Balanced',
    },
    sentiment: {
      fear_and_greed_value: fngVal, fear_and_greed_classification: fngClass,
      sentiment_interpretation: fngVal < 25 ? 'Extreme Fear (Potential Buying Opportunity)'
        : fngVal > 75 ? 'Extreme Greed (Potential Market Top / Risk)'
        : fngVal < 45 ? 'Fear' : fngVal > 55 ? 'Greed' : 'Neutral',
    },
    macro: {
      btc_dominance: md.market_cap_percentage?.btc ?? 54.0,
      eth_dominance: md.market_cap_percentage?.eth ?? 17.0,
      total_market_cap_usd: md.total_market_cap?.usd ?? 2.2e12,
      market_cap_change_24h_pct: md.market_cap_change_percentage_24h_usd ?? 0,
    },
  };
}
