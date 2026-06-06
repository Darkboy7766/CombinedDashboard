import React, { useState } from 'react';
import { Box, Snackbar, Alert, BottomNavigation, BottomNavigationAction, Tooltip, IconButton } from '@mui/material';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import DashboardIcon from '@mui/icons-material/Dashboard';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { API_BASE } from './config';
import { fetchMarketSnapshot } from './utils/market';
import { Navbar } from './components/Navbar';
import { TradingChart, PlanLevels } from './components/TradingChart';
import { Sidebar } from './components/Sidebar';

const App: React.FC = () => {
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => window.innerWidth >= 900);
  const [mobileTab, setMobileTab] = useState(0);
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [interval, setInterval] = useState('1h');
  const [activePlanLevels, setActivePlanLevels] = useState<PlanLevels | null>(null);
  const [snackbarOpen, setSnackbarOpen] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const [snackbarSeverity, setSnackbarSeverity] = useState<'success' | 'info' | 'error'>('success');

  const handleActivatePlan = (levels: PlanLevels) => {
    setActivePlanLevels(levels);
    setMobileTab(0); // switch to chart on mobile
  };

  const handleExport = async () => {
    setSnackbarSeverity('info');
    setSnackbarMessage('Събиране на пазарни данни...');
    setSnackbarOpen(true);

    try {
      const [snapshot, klRes] = await Promise.all([
        fetchMarketSnapshot(symbol, API_BASE),
        fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=300`)
          .then(r => r.json()).catch(() => null),
      ]);

      let analysis = null;
      if (Array.isArray(klRes) && klRes.length > 0) {
        const candles = klRes.map((d: any[]) => ({
          t: d[0], o: parseFloat(d[1]), h: parseFloat(d[2]),
          l: parseFloat(d[3]), c: parseFloat(d[4]), v: parseFloat(d[5]),
        }));
        const analysisRes = await fetch(`${API_BASE}/api/analysis/${symbol}/${interval}`, {
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
          current_active_positions: [],
        },
        market_snapshot: {
          symbol, interval,
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
      setSnackbarMessage(`Копиран JSON за ${symbol} (${interval})! Поставете го в Claude.`);
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
        height: '100dvh',
        width: '100vw',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <Box className="bg-glow-orb orb-primary" />
      <Box className="bg-glow-orb orb-secondary" />

      <Navbar
        onExport={handleExport}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
        sidebarOpen={sidebarOpen}
      />

      {/* Shared content area — single TradingChart + single Sidebar */}
      <Box
        sx={{
          display: 'flex',
          flexGrow: 1,
          overflow: 'hidden',
          flexDirection: 'row',
        }}
      >
        {/* Chart area */}
        <Box
          sx={{
            flexGrow: 1,
            overflow: 'hidden',
            p: { xs: 1, md: 2 },
            position: 'relative',
            // On mobile: hidden when panel tab is active
            display: { xs: mobileTab === 0 ? 'flex' : 'none', md: 'flex' },
            flexDirection: 'column',
          }}
        >
          <TradingChart
            defaultSymbol="BTCUSDT"
            defaultInterval="1h"
            planLevels={activePlanLevels}
            forcedSymbol={activePlanLevels?.symbol}
            onInfoChange={(sym, tf) => { setSymbol(sym); setInterval(tf); }}
          />

          {/* Desktop sidebar toggle button */}
          <Tooltip title={sidebarOpen ? 'Скрий панела' : 'Покажи панела'}>
            <IconButton
              onClick={() => setSidebarOpen(o => !o)}
              sx={{
                display: { xs: 'none', md: 'flex' },
                position: 'absolute',
                right: 0,
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 10,
                background: 'rgba(15,23,42,0.85)',
                color: '#fff',
                border: '1px solid var(--surface-border)',
                borderRight: 'none',
                borderRadius: '8px 0 0 8px',
                transition: 'background 0.2s',
                width: '22px',
                height: '44px',
                p: 0,
                '&:hover': { background: 'var(--primary-color)', borderColor: 'var(--primary-color)' },
              }}
            >
              {sidebarOpen ? <ChevronRightIcon sx={{ fontSize: '1rem' }} /> : <ChevronLeftIcon sx={{ fontSize: '1rem' }} />}
            </IconButton>
          </Tooltip>
        </Box>

        {/* Sidebar */}
        <Box
          sx={{
            // Desktop: slide in/out
            width: { xs: mobileTab === 1 ? '100%' : '0px', md: sidebarOpen ? '380px' : '0px' },
            minWidth: { md: sidebarOpen ? '380px' : '0px' },
            display: { xs: mobileTab === 1 ? 'block' : 'none', md: 'block' },
            overflow: 'hidden',
            height: '100%',
            transition: 'width 0.3s ease, min-width 0.3s ease',
          }}
        >
          <Sidebar
            activeSymbol={symbol}
            activeInterval={interval}
            onActivatePlan={handleActivatePlan}
          />
        </Box>
      </Box>

      {/* Mobile bottom navigation */}
      <BottomNavigation
        value={mobileTab}
        onChange={(_, val) => setMobileTab(val)}
        sx={{
          display: { xs: 'flex', md: 'none' },
          background: 'rgba(9,13,22,0.97)',
          borderTop: '1px solid var(--surface-border)',
          backdropFilter: 'blur(12px)',
          height: '54px',
          flexShrink: 0,
          '& .MuiBottomNavigationAction-root': {
            color: 'var(--text-secondary)',
            fontFamily: 'Outfit, sans-serif',
            fontSize: '0.72rem',
            minWidth: 0,
            '&.Mui-selected': {
              color: 'var(--primary-color)',
            },
          },
          '& .MuiBottomNavigationAction-label': {
            fontSize: '0.72rem',
            '&.Mui-selected': { fontSize: '0.72rem' },
          },
        }}
      >
        <BottomNavigationAction label="Графика" icon={<ShowChartIcon />} />
        <BottomNavigationAction label="Панел" icon={<DashboardIcon />} />
      </BottomNavigation>

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
            border: '1px solid rgba(255,255,255,0.05)',
            mb: { xs: '60px', md: 0 },
          }}
        >
          {snackbarMessage}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default App;
