import React, { useEffect, useRef, useState } from 'react';
import { createChart, IChartApi, ISeriesApi, LineStyle } from 'lightweight-charts';
import { API_BASE, getWsUrl } from '../config';
import { Box, Select, MenuItem, Typography, IconButton, CircularProgress } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';

export interface PlanLevels {
  symbol: string;
  direction: string;
  entry_min: number;
  entry_max: number;
  targets: number[];
  stop_loss: number;
}

interface TradingChartProps {
  id: string;
  isActive: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  defaultSymbol: string;
  defaultInterval: string;
  onActiveInfoChange: (symbol: string, interval: string) => void;
  forcedSymbol?: string;
  planLevels?: PlanLevels | null;
}

export const TradingChart: React.FC<TradingChartProps> = ({
  id,
  isActive,
  onSelect,
  onRemove,
  defaultSymbol,
  defaultInterval,
  onActiveInfoChange,
  forcedSymbol,
  planLevels
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema21Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const planLineRefs = useRef<any[]>([]);

  const [symbol, setSymbol] = useState(defaultSymbol);
  const [interval, setInterval] = useState(defaultInterval);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync active chart parameters to parent
  useEffect(() => {
    if (isActive) {
      onActiveInfoChange(symbol, interval);
    }
  }, [isActive, symbol, interval]);

  // Force symbol change when a plan is activated from Sidebar
  useEffect(() => {
    if (forcedSymbol && forcedSymbol !== symbol) {
      setSymbol(forcedSymbol);
    }
  }, [forcedSymbol]);

  // Draw/redraw plan level lines (Entry, TP, SL) on the chart
  useEffect(() => {
    const series = candSeriesRef.current;

    // Remove previous plan lines
    planLineRefs.current.forEach(line => {
      try { series?.removePriceLine(line); } catch {}
    });
    planLineRefs.current = [];

    if (!series || !planLevels || planLevels.symbol !== symbol) return;

    const lines: any[] = [];

    lines.push(series.createPriceLine({
      price: planLevels.entry_min,
      color: '#fbbf24',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Вход мин',
    }));

    lines.push(series.createPriceLine({
      price: planLevels.entry_max,
      color: '#fbbf24',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: 'Вход макс',
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
  }, [planLevels, symbol]);

  // Fetch initial klines and draw chart
  const fetchKlines = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/klines/${symbol}/${interval}?limit=300`);
      if (!response.ok) {
        throw new Error(`Failed to fetch klines: ${response.statusText}`);
      }
      const data = await response.json();
      
      if (!candSeriesRef.current) return;

      // Transform data for lightweight-charts
      const candles = data.candles.map((c: any) => ({
        time: c.t / 1000,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c
      }));

      candSeriesRef.current.setData(candles);

      // Set EMAs
      if (data.emas) {
        if (ema21Ref.current && data.emas.ema21) {
          ema21Ref.current.setData(data.emas.ema21.map((e: any) => ({ time: e.t / 1000, value: e.v })));
        }
        if (ema50Ref.current && data.emas.ema50) {
          ema50Ref.current.setData(data.emas.ema50.map((e: any) => ({ time: e.t / 1000, value: e.v })));
        }
        if (ema200Ref.current && data.emas.ema200) {
          ema200Ref.current.setData(data.emas.ema200.map((e: any) => ({ time: e.t / 1000, value: e.v })));
        }
      }

      // Fit chart to content
      chartRef.current?.timeScale().fitContent();

    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Init chart
  useEffect(() => {
    if (!containerRef.current) return;

    // Create chart API
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'rgba(17, 24, 39, 0.2)' },
        textColor: '#94a3b8',
        fontFamily: 'Outfit, sans-serif'
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' }
      },
      crosshair: {
        mode: 0,
        vertLine: { color: '#6366f1', labelBackgroundColor: '#6366f1' },
        horzLine: { color: '#6366f1', labelBackgroundColor: '#6366f1' }
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)'
      }
    });

    // Create candle series
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e'
    });

    // Create EMA line series
    const ema21 = chart.addLineSeries({ color: '#ffb703', lineWidth: 1.5, title: 'EMA 21' });
    const ema50 = chart.addLineSeries({ color: '#06b6d4', lineWidth: 1.5, title: 'EMA 50' });
    const ema200 = chart.addLineSeries({ color: '#d946ef', lineWidth: 1.5, title: 'EMA 200' });

    chartRef.current = chart;
    candSeriesRef.current = candleSeries;
    ema21Ref.current = ema21;
    ema50Ref.current = ema50;
    ema200Ref.current = ema200;

    // Handle resizing
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || !entries[0].contentRect) return;
      const { width, height } = entries[0].contentRect;
      chart.resize(width, height);
    });
    resizeObserver.observe(containerRef.current);

    fetchKlines();

    return () => {
      resizeObserver.disconnect();
      planLineRefs.current = [];
      chart.remove();
      chartRef.current = null;
    };
  }, [symbol, interval]);

  // Handle WebSockets (live price stream)
  useEffect(() => {
    const socket = new WebSocket(getWsUrl());
    socketRef.current = socket;

    socket.onopen = () => {
      console.log(`WebSocket client subscribed to ${symbol} @ ${interval}`);
      socket.send(JSON.stringify({ symbol, interval }));
    };

    socket.onmessage = (event) => {
      try {
        const tick = JSON.parse(event.data);
        if (tick.error) {
          console.error(tick.error);
          return;
        }

        if (candSeriesRef.current && tick.t) {
          candSeriesRef.current.update({
            time: tick.t / 1000,
            open: tick.o,
            high: tick.h,
            low: tick.l,
            close: tick.c
          });
        }
      } catch (err) {
        console.error('Failed to parse WebSocket tick', err);
      }
    };

    socket.onerror = (err) => {
      console.error('WebSocket connection error', err);
    };

    socket.onclose = () => {
      console.log(`WebSocket closed for ${symbol}`);
    };

    return () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      socketRef.current = null;
    };
  }, [symbol, interval]);

  const handleIntervalChange = (val: string) => {
    setInterval(val);
  };

  return (
    <Box
      onClick={onSelect}
      className={`glass-panel ${isActive ? 'active-chart-border' : ''}`}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'relative',
        cursor: 'pointer',
        overflow: 'hidden',
        borderWidth: '1.5px'
      }}
    >
      {/* Chart Toolbar */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          p: 1.5,
          borderBottom: '1px solid var(--surface-border)',
          background: 'rgba(15, 23, 42, 0.4)'
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
              background: 'rgba(255, 255, 255, 0.05)',
              fontFamily: 'Outfit, sans-serif',
              fontWeight: 600,
              fontSize: '0.85rem',
              '.MuiOutlinedInput-notchedOutline': { borderColor: 'var(--surface-border)' },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--primary-color)' },
              '.MuiSelect-icon': { color: 'var(--text-secondary)' }
            }}
          >
            {[
              'BTCUSDT','ZECUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
              'ADAUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','DOTUSDT',
              'MATICUSDT','UNIUSDT','ATOMUSDT','LTCUSDT','NEARUSDT',
              'APTUSDT','ARBUSDT','OPUSDT','SUIUSDT','PEPEUSDT'
            ].map(s => (
              <MenuItem key={s} value={s} sx={{ fontFamily: 'Outfit, sans-serif', fontSize: '0.85rem' }}>
                {s.replace('USDT', '/USDT')}
              </MenuItem>
            ))}
          </Select>
          
          <Select
            value={interval}
            onChange={(e) => handleIntervalChange(e.target.value)}
            size="small"
            sx={{
              height: '32px',
              color: '#fff',
              background: 'rgba(255, 255, 255, 0.05)',
              '.MuiOutlinedInput-notchedOutline': { borderColor: 'var(--surface-border)' },
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: 'var(--primary-color)' },
              fontFamily: 'Outfit, sans-serif',
              fontSize: '0.85rem'
            }}
          >
            <MenuItem value="1m">1m</MenuItem>
            <MenuItem value="5m">5m</MenuItem>
            <MenuItem value="15m">15m</MenuItem>
            <MenuItem value="1h">1h</MenuItem>
            <MenuItem value="4h">4h</MenuItem>
            <MenuItem value="1d">1d</MenuItem>
          </Select>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {isActive && (
            <Box
              sx={{
                background: 'var(--primary-color)',
                color: '#fff',
                fontSize: '0.7rem',
                fontWeight: 600,
                px: 1,
                py: 0.5,
                borderRadius: '4px',
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                boxShadow: '0 0 8px var(--primary-glow)'
              }}
            >
              <VisibilityIcon sx={{ fontSize: '0.9rem' }} />
              АКТИВНА
            </Box>
          )}

          {onRemove && (
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              sx={{ color: '#ef4444', '&:hover': { background: 'rgba(239, 68, 68, 0.1)' } }}
            >
              <DeleteIcon sx={{ fontSize: '1.2rem' }} />
            </IconButton>
          )}
        </Box>
      </Box>

      {/* Chart Canvas Area */}
      <Box
        ref={containerRef}
        sx={{
          flexGrow: 1,
          width: '100%',
          position: 'relative',
          minHeight: '200px'
        }}
      >
        {loading && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              background: 'rgba(11, 15, 25, 0.6)',
              zIndex: 2,
              backdropFilter: 'blur(2px)'
            }}
          >
            <CircularProgress size={30} sx={{ color: 'var(--primary-color)' }} />
          </Box>
        )}
        
        {error && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              p: 2,
              textAlign: 'center',
              color: '#ef4444',
              background: 'rgba(11, 15, 25, 0.8)',
              zIndex: 2
            }}
          >
            <Typography variant="body2">{error}</Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
};
