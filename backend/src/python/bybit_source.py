"""
bybit_source.py — Bybit v5 fallback market data source.

Used when Binance returns an error (rate limit, region block, timeout).
Mirrors the shapes data_source.py / data_fetcher.py already expect so callers
only need a try/except around the Binance call, not a rewrite.
"""
import json
import urllib.request
import urllib.parse

BYBIT = "https://api.bybit.com"
_UA = {"User-Agent": "trading-dashboard/1.0"}


def _get(path: str, params: dict, timeout: int = 15) -> dict:
    url = f"{BYBIT}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=_UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = json.loads(r.read().decode())
    if body.get("retCode") != 0:
        raise RuntimeError(f"bybit error {body.get('retCode')}: {body.get('retMsg')}")
    return body["result"]


def to_bybit_interval(interval: str) -> str:
    """Binance-style "1h"/"4h"/"1d" -> Bybit-style "60"/"240"/"D"."""
    unit, num = interval[-1], int(interval[:-1])
    if unit == "m":
        return str(num)
    if unit == "h":
        return str(num * 60)
    if unit == "d":
        return "D" if num == 1 else str(num * 1440)
    if unit == "w":
        return "W"
    return interval


def get_klines(symbol: str, interval: str, limit: int = 250, futures: bool = True) -> list[dict]:
    category = "linear" if futures else "spot"
    result = _get("/v5/market/kline", {
        "category": category, "symbol": symbol,
        "interval": to_bybit_interval(interval), "limit": limit,
    })
    # Bybit returns newest-first; normalize to oldest-first like Binance.
    rows = result.get("list", [])[::-1]
    return [
        {"t": int(d[0]), "o": float(d[1]), "h": float(d[2]),
         "l": float(d[3]), "c": float(d[4]), "v": float(d[5])}
        for d in rows
    ]


def get_ticker(symbol: str) -> dict:
    result = _get("/v5/market/tickers", {"category": "linear", "symbol": symbol})
    rows = result.get("list", [])
    if not rows:
        raise RuntimeError(f"bybit: no ticker for {symbol}")
    d = rows[0]
    return {
        "funding_rate": float(d.get("fundingRate") or 0.0),
        "mark_price": float(d.get("markPrice") or 0.0),
        "open_interest": float(d.get("openInterest") or 0.0),
        "last_price": float(d.get("lastPrice") or 0.0),
        "price_change_pct": float(d.get("price24hPcnt") or 0.0) * 100,
        "high_24h": float(d.get("highPrice24h") or 0.0),
        "low_24h": float(d.get("lowPrice24h") or 0.0),
        "volume_24h": float(d.get("volume24h") or 0.0),
    }


def get_open_interest_hist(symbol: str, period: str = "1h", limit: int = 2) -> list[dict]:
    result = _get("/v5/market/open-interest", {
        "category": "linear", "symbol": symbol, "intervalTime": period, "limit": limit,
    })
    rows = result.get("list", [])[::-1]
    return [{"timestamp": int(d["timestamp"]), "sumOpenInterest": float(d["openInterest"])} for d in rows]


def get_long_short_ratio(symbol: str, period: str = "1h", limit: int = 1) -> list[dict]:
    result = _get("/v5/market/account-ratio", {
        "category": "linear", "symbol": symbol, "period": period, "limit": limit,
    })
    rows = result.get("list", [])[::-1]
    out = []
    for d in rows:
        buy, sell = float(d["buyRatio"]), float(d["sellRatio"])
        out.append({
            "longShortRatio": buy / sell if sell else None,
            "longAccount": buy, "shortAccount": sell,
        })
    return out


def get_orderbook(symbol: str, limit: int = 100) -> dict:
    result = _get("/v5/market/orderbook", {"category": "linear", "symbol": symbol, "limit": min(limit, 200)})
    return {"bids": result.get("b", []), "asks": result.get("a", [])}
