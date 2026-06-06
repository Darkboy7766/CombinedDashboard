"""
analysis_engine.py — rule-based technical analysis engine.

Input : list of OHLCV dicts {t, o, h, l, c, v}
Output: structured analysis dict ready for the sidebar and JSON export.

Extend this file independently of app.py / data_source.py.
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))
from crypto_tools import ema, rsi, atr, sma

LONG  = "LONG"
SHORT = "SHORT"
WAIT  = "WAIT"

_SIGNAL_BG = {
    LONG:  "LONG (Купи)",
    SHORT: "SHORT (Продай)",
    WAIT:  "ИЗЧАКАЙ",
}
_TREND_BG = {
    "bullish": "Бичи (възходящ)",
    "bearish": "Мечи (низходящ)",
    "neutral": "Неутрален",
}
_RSI_BG = {
    "overbought": "Презакупен (>70)",
    "oversold":   "Презапродаден (<30)",
    "bullish":    "Бичи зона (55–70)",
    "bearish":    "Мечи зона (30–45)",
    "neutral":    "Неутрален (45–55)",
}


def analyse(candles: list[dict], symbol: str = "", interval: str = "") -> dict:
    """Run rule-based analysis. Returns display-ready dict with a Bulgarian signal label."""
    if len(candles) < 30:
        return {"error": "Недостатъчно свещи (минимум 30)"}

    closes = [c["c"] for c in candles]
    highs  = [c["h"] for c in candles]
    lows   = [c["l"] for c in candles]

    e21  = ema(closes, 21)
    e50  = ema(closes, 50)
    e200 = ema(closes, 200)
    r14  = rsi(closes, 14)
    a14  = atr(highs, lows, closes, 14)

    last_close = closes[-1]
    le21, le50, le200 = e21[-1], e50[-1], e200[-1]
    last_rsi = r14[-1]
    last_atr = a14[-1]

    # ── Trend / EMA stack ──
    if le21 is not None and le50 is not None and le200 is not None:
        if le21 > le50 > le200:
            trend, trend_score = "bullish", 2
        elif le21 < le50 < le200:
            trend, trend_score = "bearish", -2
        elif last_close > le200:
            trend, trend_score = "bullish", 1
        elif last_close < le200:
            trend, trend_score = "bearish", -1
        else:
            trend, trend_score = "neutral", 0
        above200 = last_close > le200
    else:
        trend, trend_score, above200 = "neutral", 0, None

    # ── RSI ──
    rsi_status, rsi_score = "neutral", 0.0
    if last_rsi is not None:
        if last_rsi > 70:
            rsi_status, rsi_score = "overbought", -1.0
        elif last_rsi < 30:
            rsi_status, rsi_score = "oversold",   1.0
        elif last_rsi > 55:
            rsi_status, rsi_score = "bullish",    0.5
        elif last_rsi < 45:
            rsi_status, rsi_score = "bearish",   -0.5

    # ── ATR volatility ──
    atr_pct = round(last_atr / last_close * 100, 2) if last_atr else None
    if atr_pct is not None:
        vol_level = "висока" if atr_pct > 3 else "умерена" if atr_pct > 1.5 else "ниска"
    else:
        vol_level = "неизвестна"

    # ── Support / Resistance (pivot-point method) ──
    window = 3
    h_vals = [c["h"] for c in candles]
    l_vals = [c["l"] for c in candles]
    ph, pl = [], []
    for i in range(window, len(candles) - window):
        if all(h_vals[i] >= h_vals[i - j] for j in range(1, window + 1)) and \
           all(h_vals[i] >= h_vals[i + j] for j in range(1, window + 1)):
            ph.append(round(h_vals[i], 8))
        if all(l_vals[i] <= l_vals[i - j] for j in range(1, window + 1)) and \
           all(l_vals[i] <= l_vals[i + j] for j in range(1, window + 1)):
            pl.append(round(l_vals[i], 8))

    resistance = sorted(set(p for p in ph if p > last_close))[:3]
    support    = sorted(set(p for p in pl if p < last_close), reverse=True)[:3]
    near_r = resistance[0] if resistance else None
    near_s = support[0]    if support    else None

    # ── Signal ──
    score = trend_score + rsi_score
    if score >= 1.5:
        signal = LONG
    elif score <= -1.5:
        signal = SHORT
    else:
        signal = WAIT

    # Near resistance with overbought → don't go long
    if near_r and last_close >= near_r * 0.98 and signal == LONG:
        signal = WAIT

    return {
        "symbol":   symbol,
        "interval": interval,
        "close":    round(last_close, 8),
        "trend": {
            "direction":    trend,
            "label":        _TREND_BG[trend],
            "ema21":        round(le21,  8) if le21  is not None else None,
            "ema50":        round(le50,  8) if le50  is not None else None,
            "ema200":       round(le200, 8) if le200 is not None else None,
            "above_ema200": above200,
            "full_stack":   le21 is not None and le50 is not None and le200 is not None and
                            (le21 > le50 > le200 or le21 < le50 < le200),
        },
        "rsi": {
            "value":  round(last_rsi, 2) if last_rsi is not None else None,
            "status": rsi_status,
            "label":  _RSI_BG.get(rsi_status, rsi_status),
        },
        "volatility": {
            "atr14":   round(last_atr, 8) if last_atr else None,
            "atr_pct": atr_pct,
            "level":   vol_level,
        },
        "levels": {
            "resistance":  resistance,
            "support":     support,
            "near_resist": near_r,
            "near_support": near_s,
        },
        "signal":       signal,
        "signal_label": _SIGNAL_BG[signal],
        "score":        round(score, 2),
    }


def get_ema_series(candles: list[dict]) -> dict:
    """Return EMA arrays aligned to candle timestamps for chart overlay."""
    closes = [c["c"] for c in candles]
    ts     = [c["t"] for c in candles]
    e21  = ema(closes, 21)
    e50  = ema(closes, 50)
    e200 = ema(closes, 200)
    return {
        "ema21":  [{"t": t, "v": round(v, 8)} for t, v in zip(ts, e21)  if v is not None],
        "ema50":  [{"t": t, "v": round(v, 8)} for t, v in zip(ts, e50)  if v is not None],
        "ema200": [{"t": t, "v": round(v, 8)} for t, v in zip(ts, e200) if v is not None],
    }
