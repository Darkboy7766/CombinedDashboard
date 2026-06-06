import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, IChartApi, ISeriesApi, LineStyle, UTCTimestamp } from 'lightweight-charts';
import { getWsUrl } from '../config';
import { Box, Select, MenuItem, Typography, CircularProgress } from '@mui/material';

const BINANCE_FAPI = 'https://fapi.binance.com';

function calcEMA(closes: number[], timestamps: number[], period: number): { time: UTCTimestamp; value: number }[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  let prev = sum / period;
  const result: { time: UTCTimestamp; value: number }[] = [{ time: (timestamps[period - 1] / 1000) as UTCTimestamp, value: prev }];
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result.push({ time: (timestamps[i] / 1000) as UTCTimestamp, value: prev });
  }
  return result;
}

export interface PlanLevels {
  symbol: string;
  direction: string;
  entry_min: number;
  entry_max: number;
  targets: number[];
  stop_loss: number;
}

interface TradingChartProps {
  defaultSymbol?: string;
  defaultInterval?: string;
  planLevels?: PlanLevels | null;
  forcedSymbol?: string;
  onInfoChange?: (symbol: string, interval: string) => void;
}

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT',
  'DOGEUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','MATICUSDT','UNIUSDT',
  'ATOMUSDT','LTCUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT',
  'SUIUSDT','PEPEUSDT','ZECUSDT',
];

export const TradingChart: React.FC<TradingChartProps> = ({
  defaultSymbol = 'BTCUSDT',
  defaultInterval = '1h',
  planLevels,
  forcedSymbol,
  onInfoChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const planLineRefs = useRef<any[]>([]);
  const lastBarTimeRef = useRef<number>(0);
  const planLevelsRef = useRef<PlanLevels | null>(null);
  const symbolRef = useRef<string>(defaultSymbol);

  const [symbol, setSymbol] = useState(defaultSymbol);
  const [interval, setInterval] = useState(defaultInterval);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep refs in sync
  useEffect(() => {
    planLevelsRef.current = planLevels ?? null;
  });
  useEffect(() => {
    symbolRef.current = symbol;
  }, [symbol]);

  useEffect(() => {
    onInfoChange?.(symbol, interval);
  }, [symbol, interval]);

  useEffect(() => {
    if (forcedSymbol && forcedSymbol !== symbol) {
      setSymbol(forcedSymbol);
    }
  }, [forcedSymbol]);

  // Draw colored zones on the canvas overlay (TradingView long/short setup style)
  const drawPlanZones = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    const container = containerRef.current;
    const chart = chartRef.current;
    const series = candSeriesRef.current;
    if (!canvas || !container || !chart || !series) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = container.clientWidth;
    const h = container.clientHeight;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    const plan = planLevelsRef.current;
    if (!plan || plan.symbol !== symbolRef.current) return;

    // Right price scale width — plot area ends here
    const priceScaleWidth = chart.priceScale('right').width();
    const plotRight = w - priceScaleWidth;

    // Start rectangles 5 bars to the right of the last candle
    let rectX = 0;
    if (lastBarTimeRef.current > 0) {
      const coord = chart.timeScale().timeToCoordinate(lastBarTimeRef.current as UTCTimestamp);
      if (coord !== null && coord > 0) {
        const barSpacing = chart.timeScale().options().barSpacing;
        rectX = coord + 5 * barSpacing;
      }
    }

    const rectW = plotRight - rectX;
    if (rectW <= 2) return;

    // Y coordinates for each price level
    const yEntryMin = series.priceToCoordinate(plan.entry_min);
    const yEntryMax = series.priceToCoordinate(plan.entry_max);
    const ySL = series.priceToCoordinate(plan.stop_loss);
    const yTP1 = plan.targets[0] != null ? series.priceToCoordinate(plan.targets[0]) : null;

    if (yEntryMin === null || yEntryMax === null || ySL === null) return;

    const isLong = plan.direction.toUpperCase() === 'LONG';

    // Entry zone midpoint for zone boundary
    const yEntry = (yEntryMin + yEntryMax) / 2;

    // ── Risk zone: entry → SL ──────────────────────────────────────────────
    const riskTop = Math.min(yEntry, ySL);
    const riskBottom = Math.max(yEntry, ySL);
    ctx.fillStyle = isLong
      ? 'rgba(244, 63, 94, 0.14)'   // red for LONG risk (below entry)
      : 'rgba(244, 63, 94, 0.14)';  // red for SHORT risk (above entry)
    ctx.fillRect(rectX, riskTop, rectW, riskBottom - riskTop);

    // ── Reward zone: entry → TP1 ───────────────────────────────────────────
    if (yTP1 !== null) {
      const rewardTop = Math.min(yEntry, yTP1);
      const rewardBottom = Math.max(yEntry, yTP1);
      ctx.fillStyle = isLong
        ? 'rgba(16, 185, 129, 0.12)'   // green for LONG reward (above entry)
        : 'rgba(16, 185, 129, 0.12)';  // green for SHORT reward (below entry)
      ctx.fillRect(rectX, rewardTop, rectW, rewardBottom - rewardTop);
    }

    // ── Entry zone band (entry_min ↔ entry_max) ────────────────────────────
    const entryZoneTop = Math.min(yEntryMin, yEntryMax);
    const entryZoneH = Math.abs(yEntryMax - yEntryMin);
    if (entryZoneH > 1) {
      ctx.fillStyle = 'rgba(251, 191, 36, 0.18)';
      ctx.fillRect(rectX, entryZoneTop, rectW, entryZoneH);
    }

    // ── Boundary line at entry midpoint ────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(251, 191, 36, 0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(rectX, yEntry);
    ctx.lineTo(plotRight, yEntry);
    ctx.stroke();
    ctx.restore();

    // ── Left edge accent line ──────────────────────────────────────────────
    const accentColor = isLong ? 'rgba(16, 185, 129, 0.7)' : 'rgba(244, 63, 94, 0.7)';
    const zoneTop = yTP1 !== null ? Math.min(yEntry, yTP1, ySL) : Math.min(yEntry, ySL);
    const zoneBottom = yTP1 !== null ? Math.max(yEntry, yTP1, ySL) : Math.max(yEntry, ySL);
    ctx.save();
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(rectX, zoneTop);
    ctx.lineTo(rectX, zoneBottom);
    ctx.stroke();
    ctx.restore();
  }, []);

  const applyPlanMarkers = (plan: PlanLevels, sym: string) => {
    if (!candSeriesRef.current || plan.symbol !== sym || lastBarTimeRef.current === 0) return;
    const isLong = plan.direction.toUpperCase() === 'LONG';
    candSeriesRef.current.setMarkers([{
      time: lastBarTimeRef.current as UTCTimestamp,
      position: isLong ? 'belowBar' : 'aboveBar',
      color: isLong ? '#10b981' : '#f43f5e',
      shape: isLong ? 'arrowUp' : 'arrowDown',
      text: isLong ? 'LONG' : 'SHORT',
    }]);
  };

  // Draw plan price lines, entry marker, and canvas zones
  useEffect(() => {
    const series = candSeriesRef.current;

    planLineRefs.current.forEach(line => {
      try { series?.removePriceLine(line); } catch {}
    });
    planLineRefs.current = [];
    series?.setMarkers([]);
    drawPlanZones(); // clears canvas if no plan

    if (!series || !planLevels || planLevels.symbol !== symbol) return;

    const lines: any[] = [];

    lines.push(series.createPriceLine({
      price: planLevels.entry_min,
      color: '#fbbf24',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Вход ↓',
    }));

    lines.push(series.createPriceLine({
      price: planLevels.entry_max,
      color: '#fbbf24',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Вход ↑',
    }));

    lines.push(series.createPriceLine({
      price: planLevels.stop_loss,
      color: '#f43f5e',
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: 'SL',
    }));

    planLevels.targets.forEach((tp, i) => {
      lines.push(series.createPriceLine({
        price: tp,
        color: '#10b981',
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: `TP${i + 1}`,
      }));
    });

    planLineRefs.current = lines;
    applyPlanMarkers(planLevels, symbol);
    drawPlanZones();
  }, [planLevels, symbol]);

  const fetchKlines = async (sym: string, tf: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${BINANCE_FAPI}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=300`
      );
      if (!response.ok) throw new Error(`Binance error: ${response.status}`);
      const raw: any[][] = await response.json();

      const candles = raw.map(d => ({
        t: d[0] as number,
        o: parseFloat(d[1]),
        h: parseFloat(d[2]),
        l: parseFloat(d[3]),
        c: parseFloat(d[4]),
      }));

      if (!candSeriesRef.current) return;

      candSeriesRef.current.setData(candles.map(c => ({
        time: (c.t / 1000) as UTCTimestamp,
        open: c.o, high: c.h, low: c.l, close: c.c,
      })));

      if (candles.length > 0) {
        lastBarTimeRef.current = candles[candles.length - 1].t / 1000;
      }

      const closes = candles.map(c => c.c);
      const timestamps = candles.map(c => c.t);

      if (ema21Ref.current) ema21Ref.current.setData(calcEMA(closes, timestamps, 21));
      if (ema50Ref.current) ema50Ref.current.setData(calcEMA(closes, timestamps, 50));
      if (ema200Ref.current) ema200Ref.current.setData(calcEMA(closes, timestamps, 200));

      chartRef.current?.timeScale().fitContent();
      chartRef.current?.timeScale().applyOptions({ rightOffset: 20 });

      const plan = planLevelsRef.current;
      if (plan) {
        applyPlanMarkers(plan, sym);
        // Small delay so the chart has rendered before we read coordinates
        requestAnimationFrame(drawPlanZones);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Init / re-init chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'rgba(17, 24, 39, 0.2)' },
        textColor: '#94a3b8',
        fontFamily: 'Outfit, sans-serif',
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#6366f1', labelBackgroundColor: '#6366f1' },
        horzLine: { color: '#6366f1', labelBackgroundColor: '#6366f1' },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 20,
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });

    const ema21 = chart.addLineSeries({ color: '#ffb703', lineWidth: 1, title: 'EMA 21' });
    const ema50 = chart.addLineSeries({ color: '#06b6d4', lineWidth: 1, title: 'EMA 50' });
    const ema200 = chart.addLineSeries({ color: '#d946ef', lineWidth: 2, title: 'EMA 200' });

    chartRef.current = chart;
    candSeriesRef.current = candleSeries;
    ema21Ref.current = ema21;
    ema50Ref.current = ema50;
    ema200Ref.current = ema200;

    // Redraw zones when chart scrolls or zooms
    chart.timeScale().subscribeVisibleLogicalRangeChange(drawPlanZones);

    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries[0]?.contentRect) return;
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) {
        chart.resize(width, height);
        requestAnimationFrame(drawPlanZones);
      }
    });
    resizeObserver.observe(containerRef.current);

    fetchKlines(symbol, interval);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(drawPlanZones);
      resizeObserver.disconnect();
      planLineRefs.current = [];
      chart.remove();
      chartRef.current = null;
    };
  }, [symbol, interval]);

  // WebSocket live price stream
  useEffect(() => {
    const socket = new WebSocket(getWsUrl());
    socketRef.current = socket;

    socket.onopen = () => socket.send(JSON.stringify({ symbol, interval }));

    socket.onmessage = (event) => {
      try {
        const tick = JSON.parse(event.data);
        if (tick.error || !tick.t) return;
        if (candSeriesRef.current) {
          candSeriesRef.current.update({
            time: (tick.t / 1000) as UTCTimestamp,
            open: tick.o, high: tick.h, low: tick.l, close: tick.c,
          });
          lastBarTimeRef.current = tick.t / 1000;
        }
      } catch {}
    };

    socket.onerror = () => {};
    socket.onclose = () => {};

    return () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [symbol, interval]);

  // Summary card data
  const planCard = (() => {
    if (!planLevels || planLevels.symbol !== symbol) return null;
    const isLong = planLevels.direction.toUpperCase() === 'LONG';
    const entryMid = (planLevels.entry_min + planLevels.entry_max) / 2;
    const risk = Math.abs(entryMid - planLevels.stop_loss);
    const firstTarget = planLevels.targets[0];
    const reward = firstTarget ? Math.abs(firstTarget - entryMid) : 0;
    const rr = risk > 0 && reward > 0 ? (reward / risk).toFixed(1) : '-';
    const rrNum = parseFloat(rr);
    const rrColor = rrNum >= 2 ? '#10b981' : rrNum >= 1.5 ? '#fbbf24' : '#f43f5e';
    return { isLong, rr, rrColor };
  })();

  return (
    <Box
      className="glass-panel"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        borderWidth: '1.5px',
      }}
    >
      {/* Toolbar */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          px: { xs: 1, md: 1.5 },
          py: 1,
          borderBottom: '1px solid var(--surface-border)',
          background: 'rgba(15, 23, 42, 0.4)',
          flexWrap: 'wrap',
          gap: 0.5,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            size="small"
            sx={{
              height: '32px',
              color: '#fff',
              background: 'rgba(255,255,255,0.05)',
              fontFamily: 'Outfit, sans-serif',
              fontWeight: 600,
              fontSize: '0.85rem',
              '.MuiOutlinedInput-notchedOutline': { borderColor: 'var(--surface-border)' },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--primary-color)' },
              '.MuiSelect-icon': { color: 'var(--text-secondary)' },
            }}
          >
            {SYMBOLS.map(s => (
              <MenuItem key={s} value={s} sx={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem' }}>
                {s.replace('USDT', '/USDT')}
              </MenuItem>
            ))}
          </Select>

          <Select
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            size="small"
            sx={{
              height: '32px',
              color: '#fff',
              background: 'rgba(255,255,255,0.05)',
              '.MuiOutlinedInput-notchedOutline': { borderColor: 'var(--surface-border)' },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--primary-color)' },
              fontFamily: 'Outfit, sans-serif',
              fontSize: '0.85rem',
            }}
          >
            {['1m','5m','15m','1h','4h','1d'].map(tf => (
              <MenuItem key={tf} value={tf}>{tf}</MenuItem>
            ))}
          </Select>
        </Box>

        {/* EMA legend */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, md: 1.5 }, opacity: 0.75 }}>
          {[
            { label: 'EMA 21', color: '#ffb703' },
            { label: 'EMA 50', color: '#06b6d4' },
            { label: 'EMA 200', color: '#d946ef' },
          ].map(({ label, color }) => (
            <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Box sx={{ width: 14, height: 2, background: color, borderRadius: 1, flexShrink: 0 }} />
              <Typography sx={{ fontSize: '0.68rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                {label}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Chart canvas area */}
      <Box sx={{ flexGrow: 1, position: 'relative', minHeight: 0 }}>
        {/* lightweight-charts renders into this div */}
        <Box ref={containerRef} sx={{ width: '100%', height: '100%' }} />

        {/* Canvas overlay for colored zones — sits on top, no pointer events */}
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: 1,
          }}
        />

        {loading && (
          <Box sx={{
            position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
            background: 'rgba(11,15,25,0.6)', zIndex: 3, backdropFilter: 'blur(2px)',
          }}>
            <CircularProgress size={28} sx={{ color: 'var(--primary-color)' }} />
          </Box>
        )}

        {error && (
          <Box sx={{
            position: 'absolute', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
            p: 2, textAlign: 'center', color: '#ef4444', background: 'rgba(11,15,25,0.8)', zIndex: 3,
          }}>
            <Typography variant="body2">{error}</Typography>
          </Box>
        )}

        {/* Summary card (top-left) */}
        {planCard && planLevels && (
          <Box
            sx={{
              position: 'absolute',
              top: 10,
              left: 10,
              zIndex: 4,
              background: 'rgba(9,13,22,0.88)',
              backdropFilter: 'blur(10px)',
              border: `1px solid ${planCard.isLong ? 'rgba(16,185,129,0.4)' : 'rgba(244,63,94,0.4)'}`,
              borderLeft: `3px solid ${planCard.isLong ? '#10b981' : '#f43f5e'}`,
              borderRadius: '0 8px 8px 0',
              p: 1.25,
              minWidth: '168px',
              boxShadow: `0 4px 20px rgba(0,0,0,0.3)`,
            }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.25 }}>
              <Box sx={{
                background: planCard.isLong ? '#10b981' : '#f43f5e',
                color: '#fff', px: 1.25, py: '2px',
                borderRadius: '4px', fontSize: '0.76rem', fontWeight: 800,
                fontFamily: 'Outfit, sans-serif', letterSpacing: '0.5px',
              }}>
                {planCard.isLong ? '▲ LONG' : '▼ SHORT'}
              </Box>
              <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.8)', fontWeight: 600 }}>
                {planLevels.symbol.replace('USDT', '/USDT')}
              </Typography>
            </Box>

            <Box sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5 }}>
                <Typography sx={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>Вход</Typography>
                <Typography sx={{ fontSize: '0.69rem', color: '#fbbf24', fontFamily: 'monospace', fontWeight: 600 }}>
                  {planLevels.entry_min} – {planLevels.entry_max}
                </Typography>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5 }}>
                <Typography sx={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>SL</Typography>
                <Typography sx={{ fontSize: '0.69rem', color: '#f43f5e', fontFamily: 'monospace', fontWeight: 700 }}>
                  {planLevels.stop_loss}
                </Typography>
              </Box>
              {planLevels.targets.map((tp, i) => (
                <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1.5 }}>
                  <Typography sx={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>TP{i + 1}</Typography>
                  <Typography sx={{ fontSize: '0.69rem', color: '#10b981', fontFamily: 'monospace' }}>{tp}</Typography>
                </Box>
              ))}
            </Box>

            <Box sx={{
              mt: 1.25, pt: 1, borderTop: '1px solid rgba(255,255,255,0.07)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <Typography sx={{ fontSize: '0.67rem', color: 'var(--text-secondary)' }}>R/R</Typography>
              <Typography sx={{ fontSize: '0.8rem', fontWeight: 800, fontFamily: 'Outfit, sans-serif', color: planCard.rrColor }}>
                1:{planCard.rr}
              </Typography>
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
};
