"""
data_source.py — pluggable market data adapter (currently: Binance Spot/Futures,
falling back to Bybit on Binance errors — e.g. rate limits, region blocks).

To add a broker, implement get_klines() and make_stream_url() for it and
swap the active functions at the bottom of this file.  One function each —
that is the entire contract.

Candle dict schema: {t: int (ms), o: float, h: float, l: float, c: float, v: float}
"""
import json
import urllib.request

import bybit_source

BINANCE_SPOT = "https://api.binance.com"
BINANCE_FUT  = "https://fapi.binance.com"
BINANCE_WS   = "wss://stream.binance.com:9443/ws"

_UA = {"User-Agent": "trading-dashboard/1.0"}


# ---------- Binance implementation ----------

def _binance_klines(symbol: str, interval: str, limit: int = 250, futures: bool = True) -> list[dict]:
    base = BINANCE_FUT if futures else BINANCE_SPOT
    path = "/fapi/v1/klines" if futures else "/api/v3/klines"
    url  = f"{base}{path}?symbol={symbol}&interval={interval}&limit={limit}"
    req  = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode())
    return [
        {"t": int(d[0]), "o": float(d[1]), "h": float(d[2]),
         "l": float(d[3]), "c": float(d[4]), "v": float(d[5])}
        for d in data
    ]


def _binance_stream_url(symbol: str, interval: str) -> str:
    return f"{BINANCE_WS}/{symbol.lower()}@kline_{interval}"


# ---------- Future brokers — add here ----------
#
# Hyperliquid:
#   def _hyperliquid_klines(symbol, interval, limit, futures): ...
#   def _hyperliquid_stream_url(symbol, interval): ...
#
# Alpaca (stocks):
#   def _alpaca_klines(symbol, interval, limit, futures): ...
#   def _alpaca_stream_url(symbol, interval): ...
#
# Polygon.io:
#   def _polygon_klines(symbol, interval, limit, futures): ...
#   def _polygon_stream_url(symbol, interval): ...


# ---------- Active adapter (swap to change broker) ----------

def get_klines(symbol: str, interval: str, limit: int = 250, futures: bool = False) -> list[dict]:
    """Fetch historical OHLCV candles. Returns list of candle dicts.

    Falls back to Bybit if Binance errors (rate limit, region block, timeout).
    """
    try:
        return _binance_klines(symbol, interval, limit, futures)
    except Exception:
        return bybit_source.get_klines(symbol, interval, limit, futures)


def make_stream_url(symbol: str, interval: str) -> str:
    """Return the WebSocket URL for a live kline stream."""
    return _binance_stream_url(symbol, interval)
