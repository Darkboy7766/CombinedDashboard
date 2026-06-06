import React, { useEffect, useState } from 'react';
import { Box, Typography, Button, ButtonGroup, CircularProgress, Tooltip, IconButton } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import PublicIcon from '@mui/icons-material/Public';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';

interface NavbarProps {
  gridCount: number;
  onGridCountChange: (count: number) => void;
  activeSymbol: string;
  activeInterval: string;
  onExport: () => void;
  onToggleSidebar: () => void;
}

interface MacroStats {
  fearGreed: number;
  fearGreedClass: string;
  btcDominance: number;
  totalMcap: string;
  mcapChange: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  gridCount,
  onGridCountChange,
  activeSymbol,
  activeInterval,
  onExport,
  onToggleSidebar
}) => {
  const [macroStats, setMacroStats] = useState<MacroStats | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchMacroStats = async () => {
    setLoading(true);
    const safe = (p: Promise<Response>) => p.then(r => r.json()).catch(() => null);
    try {
      const [fng, gecko] = await Promise.all([
        safe(fetch('https://api.alternative.me/fng/')),
        safe(fetch('https://api.coingecko.com/api/v3/global')),
      ]);

      const fearGreed = fng?.data?.[0] ? +fng.data[0].value : null;
      const fearGreedClass = fng?.data?.[0]?.value_classification ?? null;
      const md = gecko?.data ?? null;
      const btcDominance = md?.market_cap_percentage?.btc ?? null;
      const totalMcapVal = md?.total_market_cap?.usd ?? null;
      const mcapChange = md?.market_cap_change_percentage_24h_usd ?? null;

      if (fearGreed === null && btcDominance === null) throw new Error('No data');

      setMacroStats({
        fearGreed: fearGreed ?? 50,
        fearGreedClass: fearGreedClass ?? 'Neutral',
        btcDominance: btcDominance != null ? +btcDominance.toFixed(1) : 0,
        totalMcap: totalMcapVal != null ? (totalMcapVal / 1e12).toFixed(2) + 'T' : 'N/A',
        mcapChange: mcapChange != null ? +mcapChange.toFixed(2) : 0,
      });
    } catch (err) {
      console.error('Failed to load macro stats in navbar', err);
      setMacroStats(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMacroStats();
  }, []);

  const getFearGreedColor = (val: number) => {
    if (val < 30) return '#ef4444'; // Red (Fear)
    if (val > 70) return '#10b981'; // Green (Greed)
    return '#f59e0b'; // Amber (Neutral)
  };

  return (
    <Box
      className="glass-panel"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'space-between',
        alignItems: 'center',
        p: 2,
        borderRadius: 0,
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        background: 'rgba(15, 23, 42, 0.45)',
        gap: 2
      }}
    >
      {/* Brand Logo & Title */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="h6"
          sx={{
            fontWeight: 800,
            background: 'linear-gradient(135deg, #fff 0%, #a5b4fc 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            letterSpacing: '0.5px',
            fontFamily: 'Outfit, sans-serif'
          }}
        >
          📈 ТРЕЙДИНГ ТАБЛО
        </Typography>
      </Box>

      {/* Market Statistics Bar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexGrow: { xs: 1, md: 0 }, justifyContent: 'center' }}>
        {loading ? (
          <CircularProgress size={16} sx={{ color: 'var(--primary-color)' }} />
        ) : macroStats ? (
          <>
            {/* Fear & Greed */}
            <Tooltip title="Fear & Greed Index">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <PublicIcon sx={{ color: 'var(--text-secondary)', fontSize: '1rem' }} />
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  Fear & Greed:
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.8rem',
                    color: getFearGreedColor(macroStats.fearGreed)
                  }}
                >
                  {macroStats.fearGreed} ({macroStats.fearGreedClass})
                </Typography>
              </Box>
            </Tooltip>

            {/* BTC Dominance */}
            <Tooltip title="Bitcoin Market Dominance">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  BTC Dominance:
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.8rem', color: '#fff' }}>
                  {macroStats.btcDominance}%
                </Typography>
              </Box>
            </Tooltip>

            {/* Total Cap */}
            <Tooltip title="Total Crypto Market Cap">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                  Market Cap:
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.8rem',
                    color: macroStats.mcapChange >= 0 ? '#10b981' : '#ef4444'
                  }}
                >
                  {macroStats.totalMcap} ({macroStats.mcapChange >= 0 ? '+' : ''}{macroStats.mcapChange}%)
                </Typography>
              </Box>
            </Tooltip>
          </>
        ) : null}
      </Box>

      {/* Grid Controls and Export */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {/* Grid selector buttons */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
            Брой графики:
          </Typography>
          <ButtonGroup
            size="small"
            sx={{
              background: 'rgba(255, 255, 255, 0.05)',
              '.MuiButton-root': {
                borderColor: 'var(--surface-border)',
                color: 'var(--text-secondary)',
                fontFamily: 'Outfit, sans-serif',
                fontWeight: 600,
                width: '32px',
                minWidth: '32px',
                height: '28px',
                p: 0,
                '&.active': {
                  background: 'var(--primary-color)',
                  color: '#fff',
                  boxShadow: '0 0 8px var(--primary-glow)'
                },
                '&:hover': {
                  background: 'rgba(99, 102, 241, 0.1)',
                  color: '#fff'
                }
              }
            }}
          >
            {[1, 2, 4, 6, 8].map((num) => (
              <Button
                key={num}
                className={gridCount === num ? 'active' : ''}
                onClick={() => onGridCountChange(num)}
              >
                {num}
              </Button>
            ))}
          </ButtonGroup>
        </Box>

        {/* Export to Claude */}
        <Button
          variant="contained"
          size="small"
          onClick={onExport}
          startIcon={<AutoAwesomeIcon sx={{ fontSize: '0.9rem' }} />}
          sx={{
            background: 'rgba(255, 255, 255, 0.08)',
            border: '1px solid var(--surface-border)',
            color: '#fff',
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 500,
            textTransform: 'none',
            fontSize: '0.8rem',
            height: '28px',
            px: 1.5,
            boxShadow: 'none',
            '&:hover': {
              background: 'var(--primary-color)',
              boxShadow: '0 0 8px var(--primary-glow)',
              borderColor: 'var(--primary-color)'
            }
          }}
        >
          Експорт за Claude
        </Button>

        {/* Sidebar toggle — mobile only */}
        <Tooltip title="Панел">
          <IconButton
            onClick={onToggleSidebar}
            sx={{
              display: { xs: 'flex', md: 'none' },
              color: '#fff',
              border: '1px solid var(--surface-border)',
              borderRadius: '8px',
              width: '32px',
              height: '28px',
              p: 0,
              '&:hover': { background: 'var(--primary-color)', borderColor: 'var(--primary-color)' }
            }}
          >
            <MenuOpenIcon sx={{ fontSize: '1.1rem' }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
