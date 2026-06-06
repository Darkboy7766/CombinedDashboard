import React, { useEffect, useState } from 'react';
import { Box, Typography, Button, CircularProgress, Tooltip, IconButton } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import PublicIcon from '@mui/icons-material/Public';
import MenuOpenIcon from '@mui/icons-material/MenuOpen';
import MenuIcon from '@mui/icons-material/Menu';

interface NavbarProps {
  onExport: () => void;
  onToggleSidebar: () => void;
  sidebarOpen?: boolean;
}

interface MacroStats {
  fearGreed: number;
  fearGreedClass: string;
  btcDominance: number;
  totalMcap: string;
  mcapChange: number;
}

export const Navbar: React.FC<NavbarProps> = ({
  onExport,
  onToggleSidebar,
  sidebarOpen,
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
    } catch {
      setMacroStats(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMacroStats();
  }, []);

  const getFearGreedColor = (val: number) => {
    if (val < 30) return '#ef4444';
    if (val > 70) return '#10b981';
    return '#f59e0b';
  };

  return (
    <Box
      className="glass-panel"
      sx={{
        display: 'flex',
        alignItems: 'center',
        px: { xs: 1.5, md: 2 },
        py: { xs: 0.75, md: 1 },
        borderRadius: 0,
        borderTop: 'none',
        borderLeft: 'none',
        borderRight: 'none',
        background: 'rgba(15,23,42,0.45)',
        gap: { xs: 1, md: 2 },
        flexShrink: 0,
      }}
    >
      {/* Brand */}
      <Typography
        variant="h6"
        sx={{
          fontWeight: 800,
          background: 'linear-gradient(135deg, #fff 0%, #a5b4fc 100%)',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          letterSpacing: '0.5px',
          fontFamily: 'Outfit, sans-serif',
          fontSize: { xs: '0.95rem', md: '1.1rem' },
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
      >
        📈 ТРЕЙДИНГ ТАБЛО
      </Typography>

      {/* Macro stats — hidden on mobile */}
      <Box
        sx={{
          display: { xs: 'none', sm: 'flex' },
          alignItems: 'center',
          gap: { sm: 2, md: 3 },
          flexGrow: 1,
          justifyContent: 'center',
        }}
      >
        {loading ? (
          <CircularProgress size={14} sx={{ color: 'var(--primary-color)' }} />
        ) : macroStats ? (
          <>
            <Tooltip title="Fear & Greed Index">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <PublicIcon sx={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }} />
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  Fear&amp;Greed:
                </Typography>
                <Typography
                  variant="body2"
                  sx={{ fontWeight: 700, fontSize: '0.75rem', color: getFearGreedColor(macroStats.fearGreed) }}
                >
                  {macroStats.fearGreed} ({macroStats.fearGreedClass})
                </Typography>
              </Box>
            </Tooltip>

            <Tooltip title="Bitcoin Market Dominance">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  BTC Dom:
                </Typography>
                <Typography variant="body2" sx={{ fontWeight: 700, fontSize: '0.75rem', color: '#fff' }}>
                  {macroStats.btcDominance}%
                </Typography>
              </Box>
            </Tooltip>

            <Tooltip title="Total Crypto Market Cap">
              <Box sx={{ display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>
                  M.Cap:
                </Typography>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    color: macroStats.mcapChange >= 0 ? '#10b981' : '#ef4444',
                  }}
                >
                  {macroStats.totalMcap} ({macroStats.mcapChange >= 0 ? '+' : ''}{macroStats.mcapChange}%)
                </Typography>
              </Box>
            </Tooltip>
          </>
        ) : null}
      </Box>

      {/* Spacer on mobile */}
      <Box sx={{ display: { xs: 'flex', sm: 'none' }, flexGrow: 1 }} />

      {/* Actions */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        <Button
          variant="contained"
          size="small"
          onClick={onExport}
          startIcon={<AutoAwesomeIcon sx={{ fontSize: '0.85rem' }} />}
          sx={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid var(--surface-border)',
            color: '#fff',
            fontFamily: 'Outfit, sans-serif',
            fontWeight: 500,
            textTransform: 'none',
            fontSize: '0.78rem',
            height: '30px',
            px: 1.5,
            boxShadow: 'none',
            whiteSpace: 'nowrap',
            '&:hover': {
              background: 'var(--primary-color)',
              boxShadow: '0 0 8px var(--primary-glow)',
              borderColor: 'var(--primary-color)',
            },
          }}
        >
          <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' } }}>Експорт за </Box>Claude
        </Button>

        {/* Sidebar toggle — all screens */}
        <Tooltip title={sidebarOpen ? 'Скрий панела' : 'Покажи панела'}>
          <IconButton
            onClick={onToggleSidebar}
            sx={{
              color: sidebarOpen ? 'var(--primary-color)' : '#fff',
              border: '1px solid var(--surface-border)',
              borderRadius: '8px',
              width: '30px',
              height: '30px',
              p: 0,
              flexShrink: 0,
              '&:hover': { background: 'var(--primary-color)', borderColor: 'var(--primary-color)', color: '#fff' },
            }}
          >
            {sidebarOpen
              ? <MenuOpenIcon sx={{ fontSize: '1.1rem' }} />
              : <MenuIcon sx={{ fontSize: '1.1rem' }} />
            }
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
};
