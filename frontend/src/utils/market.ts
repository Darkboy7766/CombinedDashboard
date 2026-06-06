const BINANCE_FAPI = 'https://fapi.binance.com';
const safe = (p: Promise<Response>) => p.then(r => r.json()).catch(() => null);

export async function fetchMarketSnapshot(symbol: string, apiBase: string) {
  const norm = symbol.replace(/[/\-\s]/g, '').toUpperCase();

  const [k1d, k4h, k1h, funding, oi, oiHist, ls, depth, fng, gecko] = await Promise.all([
    safe(fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${norm}&interval=1d&limit=200`)),
    safe(fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${norm}&interval=4h&limit=200`)),
    safe(fetch(`${BINANCE_FAPI}/fapi/v1/klines?symbol=${norm}&interval=1h&limit=200`)),
    safe(fetch(`${BINANCE_FAPI}/fapi/v1/premiumIndex?symbol=${norm}`)),
    safe(fetch(`${BINANCE_FAPI}/fapi/v1/openInterest?symbol=${norm}`)),
    safe(fetch(`${apiBase}/api/binance/openInterestHist?symbol=${norm}&period=1h&limit=2`)),
    safe(fetch(`${apiBase}/api/binance/globalLongShortAccountRatio?symbol=${norm}&period=1h&limit=1`)),
    safe(fetch(`${BINANCE_FAPI}/fapi/v1/depth?symbol=${norm}&limit=100`)),
    safe(fetch('https://api.alternative.me/fng/')),
    safe(fetch('https://api.coingecko.com/api/v3/global')),
  ]);

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
