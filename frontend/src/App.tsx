import React, { useState, useEffect } from 'react';
import { Box, IconButton, Tooltip, Snackbar, Alert } from '@mui/material';
import { API_BASE } from './config';
import { fetchMarketSnapshot } from './utils/market';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Navbar } from './components/Navbar';
import { ChartsGrid } from './components/ChartsGrid';
import { Sidebar } from './components/Sidebar';
import { PlanLevels } from './components/TradingChart';

interface ChartInfo {
  id: string;
  symbol: string;
  interval: string;
}

const App: React.FC = () => {
  const [gridCount, setGridCount] = useState<number>(4);
  const [activeChartId, setActiveChartId] = useState<string>('c1');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => window.innerWidth >= 900);

  // Initialize a grid of up to 8 potential charts
  const [charts, setCharts] = useState<ChartInfo[]>([
    { id: 'c1', symbol: 'BTCUSDT', interval: '1h' },
    { id: 'c2', symbol: 'ETHUSDT', interval: '4h' },
    { id: 'c3', symbol: 'SOLUSDT', interval: '15m' },
    { id: 'c4', symbol: 'XRPUSDT', interval: '1h' },
    { id: 'c5', symbol: 'ADAUSDT', interval: '4h' },
    { id: 'c6', symbol: 'LINKUSDT', interval: '1d' },
    { id: 'c7', symbol: 'DOTUSDT', interval: '15m' },
    { id: 'c8', symbol: 'LTCUSDT', interval: '1h' },
  ]);

  const [activeSymbol, setActiveSymbol] = useState<string>('BTCUSDT');
  const [activeInterval, setActiveInterval] = useState<string>('1h');
  const [activePlanLevels, setActivePlanLevels] = useState<PlanLevels | null>(null);

  // Snackbar alerts
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'info' | 'error'>('success');

  // Load saved layouts from local storage if available
  useEffect(() => {
    const savedGridCount = localStorage.getItem('gridCount');
    const savedCharts = localStorage.getItem('charts');
    const savedActiveChartId = localStorage.getItem('activeChartId');

    if (savedGridCount) setGridCount(parseInt(savedGridCount));
    if (savedActiveChartId) setActiveChartId(savedActiveChartId);
    if (savedCharts) {
      try {
        setCharts(JSON.parse(savedCharts));
      } catch (e) {
        console.error('Failed to parse saved charts', e);
      }
    }
  }, []);

  // Save changes to local storage
  const saveLayout = (updatedGridCount: number, updatedCharts: ChartInfo[], updatedActiveId: string) => {
    localStorage.setItem('gridCount', updatedGridCount.toString());
    localStorage.setItem('charts', JSON.stringify(updatedCharts));
    localStorage.setItem('activeChartId', updatedActiveId);
  };

  const handleGridCountChange = (count: number) => {
    setGridCount(count);
    
    // Ensure activeChartId remains valid within the visible range
    const visibleCharts = charts.slice(0, count);
    const isValidActiveId = visibleCharts.some(c => c.id === activeChartId);
    let newActiveId = activeChartId;
    if (!isValidActiveId && visibleCharts.length > 0) {
      newActiveId = visibleCharts[0].id;
      setActiveChartId(newActiveId);
    }
    
    saveLayout(count, charts, newActiveId);
  };

  const handleSelectChart = (id: string) => {
    setActiveChartId(id);
    const selected = charts.find(c => c.id === id);
    if (selected) {
      setActiveSymbol(selected.symbol);
      setActiveInterval(selected.interval);
    }
    saveLayout(gridCount, charts, id);
  };

  const handleRemoveChart = (id: string) => {
    // When removing, we don't delete the chart cell definition, we just reset it to default
    // or we swap it with a cell from further down the list.
    // For simplicity, we just reset the removed cell to default BTCUSDT 1h
    const updated = charts.map(c => 
      c.id === id ? { ...c, symbol: 'BTCUSDT', interval: '1h' } : c
    );
    setCharts(updated);
    saveLayout(gridCount, updated, activeChartId);
  };

  const handleActiveChartInfoChange = (symbol: string, interval: string) => {
    // Check if this actually changes the values of the active chart cell
    let changed = false;
    const updated = charts.map(c => {
      if (c.id === activeChartId) {
        if (c.symbol !== symbol || c.interval !== interval) {
          changed = true;
          return { ...c, symbol, interval };
        }
      }
      return c;
    });

    if (changed) {
      setCharts(updated);
      setActiveSymbol(symbol);
      setActiveInterval(interval);
      saveLayout(gridCount, updated, activeChartId);
    }
  };

  const handleActivatePlan = (levels: PlanLevels) => {
    setActivePlanLevels(levels);
    setActiveSymbol(levels.symbol);
  };

  const handleExport = async () => {
    setSnackbarSeverity('info');
    setSnackbarMessage('Събиране на пазарни данни...');
    setSnackbarOpen(true);

    try {
      // Fetch snapshot and klines for analysis in parallel
      const [snapshot, klRes] = await Promise.all([
        fetchMarketSnapshot(activeSymbol, API_BASE),
        fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${activeSymbol}&interval=${activeInterval}&limit=300`)
          .then(r => r.json()).catch(() => null),
      ]);

      // Run rule-based analysis via backend (POST with candles)
      let analysis = null;
      if (Array.isArray(klRes) && klRes.length > 0) {
        const candles = klRes.map((d: any[]) => ({
          t: d[0], o: parseFloat(d[1]), h: parseFloat(d[2]),
          l: parseFloat(d[3]), c: parseFloat(d[4]), v: parseFloat(d[5]),
        }));
        const analysisRes = await fetch(`${API_BASE}/api/analysis/${activeSymbol}/${activeInterval}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candles }),
        });
        if (analysisRes.ok) analysis = await analysisRes.json();
      }

      const payload = {
        user_trading_profile: {
          account_capital_usd: 1000,
          max_risk_per_trade_percent: 2.0,
          max_total_portfolio_risk_percent: 6.0,
          selected_leverage: 3,
          current_active_positions: []
        },
        market_snapshot: {
          symbol: activeSymbol,
          interval: activeInterval,
          fetched_at: new Date().toISOString(),
          funding_rate: snapshot.funding_rate,
          open_interest: snapshot.open_interest,
          long_short_ratio: snapshot.long_short_ratio,
          order_book: snapshot.order_book,
          sentiment: snapshot.sentiment,
          macro: snapshot.macro,
        },
        historical_ohlcv_data: {
          timeframe_1h_candles_count: snapshot.ohlcv_1h.length,
          timeframe_4h_candles_count: snapshot.ohlcv_4h.length,
          timeframe_1d_candles_count: snapshot.ohlcv_1d.length,
          candles_1h: snapshot.ohlcv_1h,
          candles_4h: snapshot.ohlcv_4h,
          candles_1d: snapshot.ohlcv_1d,
        },
        technical_analysis: analysis ?? {},
      };

      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setSnackbarSeverity('success');
      setSnackbarMessage(`Копиран JSON за ${activeSymbol} (${activeInterval})! Поставете го в Claude.`);
    } catch (err: any) {
      setSnackbarSeverity('error');
      setSnackbarMessage(`Грешка при експорт: ${err.message}`);
    }
  };

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        position: 'relative'
      }}
    >
      {/* Background glowing particles */}
      <Box className="bg-glow-orb orb-primary" />
      <Box className="bg-glow-orb orb-secondary" />

      {/* Top Navbar */}
      <Navbar
        gridCount={gridCount}
        onGridCountChange={handleGridCountChange}
        activeSymbol={activeSymbol}
        activeInterval={activeInterval}
        onExport={handleExport}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
      />

      {/* Main Workspace (Charts Grid + Sidebar Pane) */}
      <Box sx={{ display: 'flex', flexGrow: 1, overflow: 'hidden', position: 'relative' }}>
        {/* Left Side: Charts Grid */}
        <Box sx={{ flexGrow: 1, height: '100%', overflowY: 'auto', position: 'relative' }}>
          <ChartsGrid
            charts={charts}
            activeChartId={activeChartId}
            gridCount={gridCount}
            onSelectChart={handleSelectChart}
            onRemoveChart={handleRemoveChart}
            onActiveChartInfoChange={handleActiveChartInfoChange}
            planLevels={activePlanLevels}
          />

          {/* Floating Sidebar Toggle Button — desktop only */}
          <Tooltip title={sidebarOpen ? 'Скрий страничния панел' : 'Покажи страничния панел'}>
            <IconButton
              onClick={() => setSidebarOpen(!sidebarOpen)}
              sx={{
                display: { xs: 'none', md: 'flex' },
                position: 'absolute',
                right: sidebarOpen ? '380px' : '0px',
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                background: 'rgba(15, 23, 42, 0.8)',
                color: '#fff',
                border: '1px solid var(--surface-border)',
                borderRight: sidebarOpen ? 'none' : '1px solid var(--surface-border)',
                borderRadius: '8px 0 0 8px',
                transition: 'right 0.3s ease, background 0.2s',
                width: '24px',
                height: '48px',
                p: 0,
                '&:hover': {
                  background: 'var(--primary-color)',
                  borderColor: 'var(--primary-color)'
                }
              }}
            >
              {sidebarOpen ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            </IconButton>
          </Tooltip>
        </Box>

        {/* Mobile backdrop — затваря sidebar при натискане извън него */}
        {sidebarOpen && (
          <Box
            onClick={() => setSidebarOpen(false)}
            sx={{
              display: { xs: 'block', md: 'none' },
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.55)',
              zIndex: 19,
            }}
          />
        )}

        {/* Right Side: Collapsible Sidebar
            Desktop — в flex потока; Mobile — абсолютен overlay */}
        <Box
          sx={{
            position: { xs: 'absolute', md: 'relative' },
            right: 0,
            top: 0,
            bottom: 0,
            height: '100%',
            width: sidebarOpen
              ? { xs: '85%', sm: '360px', md: '380px' }
              : '0px',
            minWidth: { md: sidebarOpen ? '380px' : '0px' },
            transition: 'width 0.3s ease, min-width 0.3s ease',
            zIndex: { xs: 20, md: 5 },
            overflow: 'hidden'
          }}
        >
          <Sidebar
            activeSymbol={activeSymbol}
            activeInterval={activeInterval}
            onActivatePlan={handleActivatePlan}
          />
        </Box>
      </Box>

      {/* Clipboard / Export Status Notification */}
      <Snackbar
        open={snackbarOpen}
        autoHideDuration={4000}
        onClose={() => setSnackbarOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Alert
          onClose={() => setSnackbarOpen(false)}
          severity={snackbarSeverity}
          variant="filled"
          sx={{
            fontFamily: 'Outfit, sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            border: '1px solid rgba(255,255,255,0.05)'
          }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default App;
