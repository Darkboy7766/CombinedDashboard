#!/usr/bin/env python3
"""
crypto_tools.py — self-contained crypto trading toolkit (no MCP, no LibreChat).

Pure standard library: indicator math + risk calculators run anywhere with no
pip installs. Live-data commands hit public APIs via urllib; in restricted
environments those calls return {"error": ...} and the agent must fall back to
a real OHLCV export (--csv mode) or mark the field unavailable — never an
estimated or web-sourced number, and never fabricated.

CHANGED 2026-06-21: rsi()/atr() now use Wilder/RMA smoothing (wilder_smooth)
instead of a flat rolling SMA — matches TradingView/Binance values, which the
old version did not. _indicators() also gained "ema200_reliable" and
"macd_reliable" flags (true only once enough candles exist) and no longer
collapses a legitimate 0.0 reading (e.g. macd_hist at a cross) into null.

All commands print one JSON object to stdout.

MATH (offline, always works):
  position-size  --capital --risk --entry --stop
  liquidation    --entry --leverage --direction [--mm 0.5]
  rr             --entry --stop --direction [--tp1 1.5 --tp2 2.5 --tp3 4]
  indicators     (--symbol SYM --interval 4h [--futures] | --csv FILE)
  sr             (--symbol SYM --interval 1d [--futures] | --csv FILE [--window 3])

LIVE DATA (needs open network; on region/network block use --csv or mark unavailable):
  ticker     --symbol
  klines     --symbol [--interval 4h --limit 200 --futures]
  funding    --symbol [--limit 10]
  oi         --symbol [--period 4h --limit 30]
  longshort  --symbol [--period 4h --limit 10]
  depth      --symbol [--depth 100]
  feargreed  [--days 7]
  dominance
  liqmap     --symbol [--period 5m --limit 288 --bucket-pct 0.0025 --mm 0.4]  # APPROXIMATION, see note below
  snapshot   --symbol [--interval 4h]            # tries everything; degrades gracefully

liqmap is a modeled estimate of where leveraged liquidations likely cluster
(delta-OI x assumed leverage distribution x long/short split). Binance never
reveals real positions, so the output always carries "approximation": true —
treat it as a secondary confluence signal, never a real S/R level.
"""
import argparse, csv, json, sys, urllib.request, urllib.error, urllib.parse
from collections import defaultdict
from datetime import datetime, timezone

SPOT = "https://api.binance.com"
FUT = "https://fapi.binance.com"
CG = "https://api.coingecko.com/api/v3"
ALT = "https://api.alternative.me"
UA = {"User-Agent": "crypto-tools/2.0"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def http_get(base_url, params=None, retries=2):
    # params is urlencoded rather than f-string interpolated so values like
    # "&"/"#"/unicode in symbol/interval can't corrupt the query string.
    url = f"{base_url}?{urllib.parse.urlencode(params)}" if params else base_url
    last = None
    for _ in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode())
        except Exception as e:  # noqa
            last = e
    raise RuntimeError(f"request failed: {url} ({last})")


# ---------- pure-python indicator math ----------
def ema(vals, period):
    k = 2 / (period + 1)
    out, prev = [], None
    for v in vals:
        prev = v if prev is None else v * k + prev * (1 - k)
        out.append(prev)
    return out


def sma(vals, period):
    out = []
    for i in range(len(vals)):
        if i + 1 < period:
            out.append(None)
        else:
            out.append(sum(vals[i + 1 - period:i + 1]) / period)
    return out


def rolling_std(vals, period):  # sample std, ddof=1 (matches pandas .std())
    out = []
    for i in range(len(vals)):
        if i + 1 < period:
            out.append(None)
        else:
            w = vals[i + 1 - period:i + 1]
            m = sum(w) / period
            out.append((sum((x - m) ** 2 for x in w) / (period - 1)) ** 0.5)
    return out


def wilder_smooth(vals, period):
    # RMA / Wilder smoothing: seed with simple average of the first `period`
    # values, then decay old values at alpha=1/period. Matches TradingView's
    # RSI/ATR; a flat rolling SMA (the previous implementation) does not.
    out = [None] * len(vals)
    if len(vals) < period:
        return out
    out[period - 1] = sum(vals[:period]) / period
    for i in range(period, len(vals)):
        out[i] = (out[i - 1] * (period - 1) + vals[i]) / period
    return out


def rsi(closes, period=14):
    gains, losses = [0.0], [0.0]
    for i in range(1, len(closes)):
        d = closes[i] - closes[i - 1]
        gains.append(d if d > 0 else 0.0)
        losses.append(-d if d < 0 else 0.0)
    avg_g, avg_l = wilder_smooth(gains, period), wilder_smooth(losses, period)
    out = []
    for g, l in zip(avg_g, avg_l):
        if g is None or l is None:
            out.append(None)
        elif l == 0:
            out.append(100.0)
        else:
            out.append(100 - 100 / (1 + g / l))
    return out


def atr(highs, lows, closes, period=14):
    tr = [highs[0] - lows[0]]
    for i in range(1, len(closes)):
        tr.append(max(highs[i] - lows[i],
                      abs(highs[i] - closes[i - 1]),
                      abs(lows[i] - closes[i - 1])))
    return wilder_smooth(tr, period)


def macd(closes, fast=12, slow=26, signal=9):
    ef, es = ema(closes, fast), ema(closes, slow)
    line = [a - b for a, b in zip(ef, es)]
    sig = ema(line, signal)
    hist = [a - b for a, b in zip(line, sig)]
    return line, sig, hist


def read_ohlcv(path):
    rows = []
    with open(path, newline="") as f:
        sample = f.read(2048)
        f.seek(0)
        delim = "\t" if "\t" in sample and "," not in sample else ","
        reader = csv.DictReader(f, delimiter=delim)
        norm = {h.lower().strip(): h for h in (reader.fieldnames or [])}

        def col(*names):
            for n in names:
                if n in norm:
                    return norm[n]
            return None
        co, ch, cl, cc, cv = (col("o", "open"), col("h", "high"), col("l", "low"),
                              col("c", "close"), col("v", "volume", "vol"))
        if cc is None:
            raise SystemExit("CSV needs at least a close column (c/close).")
        for row in reader:
            def g(k):
                return float(row[k]) if k and row.get(k) not in (None, "") else None
            c = g(cc)
            rows.append({"o": g(co) or c, "h": g(ch) or c, "l": g(cl) or c,
                         "c": c, "v": g(cv) or 0.0})
    if len(rows) < 30:
        print(json.dumps({"warning": f"only {len(rows)} candles; indicators may be unreliable (need 200+ for EMA200)"}), file=sys.stderr)
    return rows


# ---------- commands: math ----------
def cmd_position_size(a):
    if a.entry <= 0 or a.stop <= 0 or a.capital <= 0:
        return {"error": "all inputs must be positive"}
    if a.entry == a.stop:
        return {"error": "entry and stop cannot be equal"}
    risk_amt = a.capital * (a.risk / 100)
    dist = abs(a.entry - a.stop) / a.entry
    pos = risk_amt / dist
    warn = None
    if pos > a.capital * 10:
        warn = "position > 10x capital — SL too tight or risk too high"
    elif pos > a.capital:
        warn = f"requires {round(pos / a.capital, 2)}x leverage"
    return {"capital_usd": a.capital, "risk_pct": a.risk, "risk_amount_usd": round(risk_amt, 2),
            "entry": a.entry, "stop_loss": a.stop, "sl_distance_pct": round(dist * 100, 2),
            "position_size_usd": round(pos, 2), "units": round(pos / a.entry, 6), "warning": warn}


def cmd_liquidation(a):
    if a.leverage < 1:
        return {"error": "leverage must be >= 1"}
    d = a.direction.lower()
    mm = a.mm / 100
    if d == "long":
        liq = a.entry * (1 - 1 / a.leverage + mm)
    elif d == "short":
        liq = a.entry * (1 + 1 / a.leverage - mm)
    else:
        return {"error": "direction must be long or short"}
    return {"entry": a.entry, "leverage": a.leverage, "direction": d,
            "liquidation_price": round(liq, 2), "distance_pct": round(abs(a.entry - liq) / a.entry * 100, 2),
            "note": "approximate isolated-margin; check the exchange calculator for exact value"}


def cmd_rr(a):
    d = a.direction.lower()
    if d == "long":
        risk = a.entry - a.stop
        side = 1
        if risk <= 0:
            return {"error": "for long, stop must be below entry"}
    elif d == "short":
        risk = a.stop - a.entry
        side = -1
        if risk <= 0:
            return {"error": "for short, stop must be above entry"}
    else:
        return {"error": "direction must be long or short"}
    return {"entry": a.entry, "stop_loss": a.stop, "direction": d, "risk_per_unit": round(risk, 4),
            "tp1": {"price": round(a.entry + side * risk * a.tp1, 2), "rr": a.tp1, "size_pct": 40},
            "tp2": {"price": round(a.entry + side * risk * a.tp2, 2), "rr": a.tp2, "size_pct": 35},
            "tp3": {"price": round(a.entry + side * risk * a.tp3, 2), "rr": a.tp3, "size_pct": 25}}


def _indicators(rows, interval="?"):
    c = [r["c"] for r in rows]
    h = [r["h"] for r in rows]
    lo = [r["l"] for r in rows]
    e20, e50, e200 = ema(c, 20), ema(c, 50), ema(c, 200)
    r14 = rsi(c, 14)
    a14 = atr(h, lo, c, 14)
    ml, msig, mh = macd(c)
    bb_mid = sma(c, 20)
    bb_sd = rolling_std(c, 20)
    i = -1
    bb_u = bb_mid[i] + 2 * bb_sd[i] if bb_mid[i] is not None else None
    bb_l = bb_mid[i] - 2 * bb_sd[i] if bb_mid[i] is not None else None
    last = c[i]
    return {
        "interval": interval, "close": last,
        "ema20": e20[i], "ema50": e50[i], "ema200": e200[i],
        "rsi14": r14[i], "atr14": a14[i],
        "atr_pct_of_price": round(a14[i] / last * 100, 2) if a14[i] is not None else None,
        "macd": ml[i], "macd_signal": msig[i], "macd_hist": mh[i],
        "bb_upper": bb_u, "bb_mid": bb_mid[i], "bb_lower": bb_l,
        "trend_above_ema200": (last > e200[i]) if e200[i] is not None else None,
        "ema_alignment_bullish": bool(e20[i] > e50[i] > e200[i]) if e200[i] is not None else None,
        "ema_alignment_bearish": bool(e20[i] < e50[i] < e200[i]) if e200[i] is not None else None,
        "rsi_overbought": (r14[i] > 70) if r14[i] is not None else None,
        "rsi_oversold": (r14[i] < 30) if r14[i] is not None else None,
        "macd_bullish_cross": bool(mh[i] > 0 and mh[i - 1] <= 0),
        "macd_bearish_cross": bool(mh[i] < 0 and mh[i - 1] >= 0),
        "candles_used": len(rows),
        "ema200_reliable": len(rows) >= 200,
        "macd_reliable": len(rows) >= 35,
        "fetched_at": now_iso(),
    }


def _sr(rows, window=3):
    highs = [r["h"] for r in rows]
    lows = [r["l"] for r in rows]
    ph, pl = [], []
    for i in range(window, len(rows) - window):
        if all(highs[i] >= highs[i - j] for j in range(1, window + 1)) and \
           all(highs[i] >= highs[i + j] for j in range(1, window + 1)):
            ph.append(round(highs[i], 2))
        if all(lows[i] <= lows[i - j] for j in range(1, window + 1)) and \
           all(lows[i] <= lows[i + j] for j in range(1, window + 1)):
            pl.append(round(lows[i], 2))
    cur = rows[-1]["c"]
    above = sorted(set(p for p in ph if p > cur))[:5]
    below = sorted(set(p for p in pl if p < cur), reverse=True)[:5]
    return {"current_price": cur, "resistance_levels": above, "support_levels": below,
            "nearest_resistance": above[0] if above else None,
            "nearest_support": below[0] if below else None, "fetched_at": now_iso()}


def cmd_indicators(a):
    if a.csv:
        return _indicators(read_ohlcv(a.csv), a.interval)
    if a.symbol:
        def f():
            return _indicators(_klines_rows(a.symbol, a.interval, max(a.limit, 250), a.futures), a.interval)
        return _safe(f)
    return {"error": "provide --csv FILE or --symbol SYM"}


def cmd_sr(a):
    if a.csv:
        return _sr(read_ohlcv(a.csv), a.window)
    if a.symbol:
        def f():
            return _sr(_klines_rows(a.symbol, a.interval, a.lookback, a.futures), a.window)
        return _safe(f)
    return {"error": "provide --csv FILE or --symbol SYM"}


# ---------- commands: live data ----------
def _klines_rows(symbol, interval, limit, futures):
    base, path = (FUT, "/fapi/v1/klines") if futures else (SPOT, "/api/v3/klines")
    data = http_get(f"{base}{path}", {"symbol": symbol, "interval": interval, "limit": limit})
    return [{"t": d[0], "o": float(d[1]), "h": float(d[2]), "l": float(d[3]),
             "c": float(d[4]), "v": float(d[5])} for d in data]


def _safe(fn):
    try:
        return fn()
    except Exception as e:  # noqa
        return {"error": str(e), "hint": "network/region blocked? compute from a real OHLCV export via --csv, or mark unavailable — never estimate"}


def cmd_ticker(a):
    def f():
        d = http_get(f"{SPOT}/api/v3/ticker/24hr", {"symbol": a.symbol})
        return {"symbol": d["symbol"], "last_price": float(d["lastPrice"]),
                "price_change_pct": float(d["priceChangePercent"]), "high_24h": float(d["highPrice"]),
                "low_24h": float(d["lowPrice"]), "volume_24h": float(d["volume"]),
                "quote_volume_24h": float(d["quoteVolume"]), "fetched_at": now_iso()}
    return _safe(f)


def cmd_klines(a):
    def f():
        rows = _klines_rows(a.symbol, a.interval, a.limit, a.futures)
        vols = [r["v"] for r in rows]
        avg20 = sum(vols[-20:]) / min(20, len(vols))
        return {"symbol": a.symbol, "interval": a.interval, "market": "futures" if a.futures else "spot",
                "latest_close": rows[-1]["c"], "high_period": max(r["h"] for r in rows),
                "low_period": min(r["l"] for r in rows), "volume_last": vols[-1],
                "volume_avg_20": round(avg20, 4), "volume_ratio": round(vols[-1] / avg20, 2),
                "candles": rows[-50:], "fetched_at": now_iso()}
    return _safe(f)


def cmd_funding(a):
    def f():
        data = http_get(f"{FUT}/fapi/v1/fundingRate", {"symbol": a.symbol, "limit": a.limit})
        hist = [{"time": datetime.fromtimestamp(int(d["fundingTime"]) / 1000, tz=timezone.utc).isoformat(),
                 "rate_pct": round(float(d["fundingRate"]) * 100, 6)} for d in data]
        return {"symbol": a.symbol, "current_rate_pct": hist[-1]["rate_pct"] if hist else None,
                "avg_rate_pct": round(sum(h["rate_pct"] for h in hist) / len(hist), 6) if hist else None,
                "history": hist, "fetched_at": now_iso()}
    return _safe(f)


def cmd_oi(a):
    def f():
        data = http_get(f"{FUT}/futures/data/openInterestHist", {"symbol": a.symbol, "period": a.period, "limit": a.limit})
        hist = [{"time": datetime.fromtimestamp(int(d["timestamp"]) / 1000, tz=timezone.utc).isoformat(),
                 "oi_usd": float(d["sumOpenInterestValue"])} for d in data]
        delta = round((hist[-1]["oi_usd"] / hist[-2]["oi_usd"] - 1) * 100, 2) if len(hist) >= 2 and hist[-2]["oi_usd"] else None
        return {"symbol": a.symbol, "period": a.period, "latest_oi_usd": hist[-1]["oi_usd"] if hist else None,
                "period_delta_pct": delta, "history": hist, "fetched_at": now_iso()}
    return _safe(f)


def cmd_longshort(a):
    def f():
        data = http_get(f"{FUT}/futures/data/globalLongShortAccountRatio", {"symbol": a.symbol, "period": a.period, "limit": a.limit})
        d = data[-1]
        return {"symbol": a.symbol, "period": a.period, "current_ratio": float(d["longShortRatio"]),
                "long_pct": round(float(d["longAccount"]) * 100, 2),
                "short_pct": round(float(d["shortAccount"]) * 100, 2), "fetched_at": now_iso()}
    return _safe(f)


def cmd_depth(a):
    def f():
        d = http_get(f"{SPOT}/api/v3/depth", {"symbol": a.symbol, "limit": a.depth})
        bids = sum(float(p) * float(q) for p, q in d["bids"])
        asks = sum(float(p) * float(q) for p, q in d["asks"])
        return {"symbol": a.symbol, "bid_total_usd": round(bids, 2), "ask_total_usd": round(asks, 2),
                "imbalance_ratio": round(bids / asks, 3) if asks else None,
                "depth_levels": a.depth, "fetched_at": now_iso()}
    return _safe(f)


def cmd_feargreed(a):
    def f():
        d = http_get(f"{ALT}/fng/", {"limit": a.days})["data"]
        hist = [{"date": datetime.fromtimestamp(int(x["timestamp"]), tz=timezone.utc).date().isoformat(),
                 "value": int(x["value"]), "classification": x["value_classification"]} for x in d]
        return {"current": hist[0] if hist else None, "history": hist, "fetched_at": now_iso()}
    return _safe(f)


# ---------- liquidation cluster estimate (APPROXIMATION — not real positions) ----------
# Models where leveraged liquidations likely cluster: ΔOI (new positions) x an
# assumed leverage-tier distribution x long/short split, bucketed around the
# current price. Binance never reveals real positions — treat this as a
# secondary confluence signal (stop-hunt / cascade risk), never as a real S/R
# level, and always surface the "approximation" flag in the plan.
_LIQMAP_LEVERAGE_DIST = [(5, 0.10), (10, 0.20), (25, 0.30), (50, 0.25), (100, 0.15)]


def _liqmap_round_bucket(price, ref_price, bucket_pct):
    # bucket width is fixed relative to ref_price, NOT to `price` itself —
    # otherwise price/step is the constant 1/bucket_pct and rounding is a no-op.
    step = ref_price * bucket_pct
    return round(price / step) * step if step > 0 else price


def _liqmap_liq_price(entry, leverage, side, mmr):
    imr = 1.0 / leverage
    return entry * (1 - imr + mmr) if side == "long" else entry * (1 + imr - mmr)


def _liqmap(symbol, period, limit, bucket_pct, mmr):
    oi_hist = http_get(f"{FUT}/futures/data/openInterestHist", {"symbol": symbol, "period": period, "limit": limit})
    kl = _klines_rows(symbol, period, limit, True)
    if not kl:
        return {"error": "no kline data"}
    try:
        ls_hist = http_get(f"{FUT}/futures/data/globalLongShortAccountRatio", {"symbol": symbol, "period": period, "limit": limit})
        ls_by_ts = {int(x["timestamp"]): float(x["longAccount"]) for x in ls_hist}
    except Exception:  # noqa
        ls_by_ts = {}

    price_by_ts = {r["t"]: (r["h"] + r["l"] + r["c"]) / 3.0 for r in kl}
    ref_price = kl[-1]["c"]

    buckets = defaultdict(lambda: {"total": 0.0, "long": 0.0, "short": 0.0})
    prev = None
    for row in oi_hist:
        ts = int(row["timestamp"])
        oi_val = float(row["sumOpenInterestValue"])
        if prev is not None:
            d = oi_val - prev
            entry = price_by_ts.get(ts)
            if d > 0 and entry:  # only growth = new positions opened
                lf = ls_by_ts.get(ts, 0.5)
                n_long, n_short = d * lf, d * (1 - lf)
                for lev, w in _LIQMAP_LEVERAGE_DIST:
                    b = _liqmap_round_bucket(_liqmap_liq_price(entry, lev, "long", mmr), ref_price, bucket_pct)
                    buckets[b]["total"] += n_long * w
                    buckets[b]["long"] += n_long * w
                    b2 = _liqmap_round_bucket(_liqmap_liq_price(entry, lev, "short", mmr), ref_price, bucket_pct)
                    buckets[b2]["total"] += n_short * w
                    buckets[b2]["short"] += n_short * w
        prev = oi_val

    if not buckets:
        return {"error": "insufficient OI history to estimate clusters"}
    mx = max(v["total"] for v in buckets.values())
    levels = [
        {"price": round(p, 2), "intensity": round(buckets[p]["total"] / mx, 4),
         "notional_usd": round(buckets[p]["total"], 2),
         "long_notional_usd": round(buckets[p]["long"], 2),
         "short_notional_usd": round(buckets[p]["short"], 2)}
        for p in sorted(buckets)
    ]
    top = sorted(levels, key=lambda x: -x["intensity"])[:8]
    return {"symbol": symbol, "period": period, "ref_price": ref_price,
            "approximation": True,
            "note": "estimated from delta-OI x assumed leverage distribution x long/short split — NOT real exchange positions; secondary confluence only",
            "top_clusters": top, "levels": levels, "fetched_at": now_iso()}


def cmd_liqmap(a):
    return _safe(lambda: _liqmap(a.symbol, a.period, a.limit, a.bucket_pct, a.mm / 100))


def cmd_dominance(a):
    def f():
        d = http_get(f"{CG}/global")["data"]
        return {"btc_dominance_pct": round(d["market_cap_percentage"]["btc"], 2),
                "eth_dominance_pct": round(d["market_cap_percentage"]["eth"], 2),
                "total_mcap_usd": d["total_market_cap"]["usd"],
                "total_volume_24h_usd": d["total_volume"]["usd"],
                "mcap_change_24h_pct": round(d["market_cap_change_percentage_24h_usd"], 2),
                "fetched_at": now_iso()}
    return _safe(f)


def cmd_snapshot(a):
    snap = {"symbol": a.symbol, "interval": a.interval, "fetched_at": now_iso()}

    def ind():
        rows = _klines_rows(a.symbol, a.interval, 250, False)
        return _indicators(rows, a.interval)

    def sr():
        return _sr(_klines_rows(a.symbol, "1d", 200, False))
    for key, fn in [("ticker", lambda: cmd_ticker(a)), ("indicators", ind), ("levels", sr),
                    ("funding", lambda: cmd_funding(argparse.Namespace(symbol=a.symbol, limit=5))),
                    ("open_interest", lambda: cmd_oi(argparse.Namespace(symbol=a.symbol, period="4h", limit=10))),
                    ("long_short", lambda: cmd_longshort(argparse.Namespace(symbol=a.symbol, period="4h", limit=5))),
                    ("sentiment", lambda: cmd_feargreed(argparse.Namespace(days=1))),
                    ("liquidation_map", lambda: cmd_liqmap(argparse.Namespace(
                        symbol=a.symbol, period="5m", limit=288, bucket_pct=0.0025, mm=0.4)))]:
        snap[key] = _safe(fn)
    return snap


def main():
    p = argparse.ArgumentParser(description="self-contained crypto trading toolkit")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, args):
        sp = sub.add_parser(name)
        for flag, kw in args:
            sp.add_argument(flag, **kw)
        sp.set_defaults(func=fn)

    f = float
    add("position-size", cmd_position_size, [("--capital", dict(type=f, required=True)), ("--risk", dict(type=f, default=2)), ("--entry", dict(type=f, required=True)), ("--stop", dict(type=f, required=True))])
    add("liquidation", cmd_liquidation, [("--entry", dict(type=f, required=True)), ("--leverage", dict(type=f, required=True)), ("--direction", dict(required=True)), ("--mm", dict(type=f, default=0.5))])
    add("rr", cmd_rr, [("--entry", dict(type=f, required=True)), ("--stop", dict(type=f, required=True)), ("--direction", dict(required=True)), ("--tp1", dict(type=f, default=1.5)), ("--tp2", dict(type=f, default=2.5)), ("--tp3", dict(type=f, default=4.0))])
    add("indicators", cmd_indicators, [("--csv", dict(default=None)), ("--symbol", dict(default=None)), ("--interval", dict(default="4h")), ("--limit", dict(type=int, default=250)), ("--futures", dict(action="store_true"))])
    add("sr", cmd_sr, [("--csv", dict(default=None)), ("--symbol", dict(default=None)), ("--interval", dict(default="1d")), ("--lookback", dict(type=int, default=200)), ("--window", dict(type=int, default=3)), ("--futures", dict(action="store_true"))])
    add("ticker", cmd_ticker, [("--symbol", dict(required=True))])
    add("klines", cmd_klines, [("--symbol", dict(required=True)), ("--interval", dict(default="4h")), ("--limit", dict(type=int, default=200)), ("--futures", dict(action="store_true"))])
    add("funding", cmd_funding, [("--symbol", dict(required=True)), ("--limit", dict(type=int, default=10))])
    add("oi", cmd_oi, [("--symbol", dict(required=True)), ("--period", dict(default="4h")), ("--limit", dict(type=int, default=30))])
    add("longshort", cmd_longshort, [("--symbol", dict(required=True)), ("--period", dict(default="4h")), ("--limit", dict(type=int, default=10))])
    add("depth", cmd_depth, [("--symbol", dict(required=True)), ("--depth", dict(type=int, default=100))])
    add("feargreed", cmd_feargreed, [("--days", dict(type=int, default=7))])
    add("dominance", cmd_dominance, [])
    add("liqmap", cmd_liqmap, [("--symbol", dict(required=True)), ("--period", dict(default="5m")), ("--limit", dict(type=int, default=288)), ("--bucket-pct", dict(type=f, default=0.0025, dest="bucket_pct")), ("--mm", dict(type=f, default=0.4))])
    add("snapshot", cmd_snapshot, [("--symbol", dict(default="BTCUSDT")), ("--interval", dict(default="4h"))])

    a = p.parse_args()
    print(json.dumps(a.func(a), indent=2, default=str))


if __name__ == "__main__":
    main()
