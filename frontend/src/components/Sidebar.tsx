import React, { useEffect, useState } from 'react';
import { API_BASE } from '../config';
import { fetchMarketSnapshot } from '../utils/market';

const BINANCE_FAPI = 'https://fapi.binance.com';
import {
  Box,
  Tabs,
  Tab,
  Typography,
  Button,
  CircularProgress,
  List,
  ListItem,
  IconButton,
  Divider,
  Paper,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Chip
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CloseIcon from '@mui/icons-material/Close';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import { PlanLevels } from './TradingChart';

interface SidebarProps {
  activeSymbol: string;
  activeInterval: string;
  onActivatePlan: (levels: PlanLevels) => void;
}

interface Plan {
  id: string;
  symbol: string;
  created_at: string;
  config: {
    direction: string;
    entry_min: number;
    entry_max: number;
    targets: number[];
    stop_loss: number;
  };
}

interface MonitorStatus {
  symbol: string;
  current_price: number;
  current_rsi: number;
  funding_rate: number;
  status_text: string;
  status_code: string;
}

export const Sidebar: React.FC<SidebarProps> = ({ activeSymbol, activeInterval, onActivatePlan }) => {
  const [tabValue, setTabValue] = useState(0);

  // Technical Analysis state
  const [analysisData, setAnalysisData] = useState<any>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  // Active Plans state
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansLoading, setPlansLoading] = useState(false);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [waking, setWaking] = useState(false);
  const [monitoredStatuses, setMonitoredStatuses] = useState<{ [id: string]: MonitorStatus }>({});
  const [monitoringLoading, setMonitoringLoading] = useState<{ [id: string]: boolean }>({});

  // AI Plan Generator state
  const [generating, setGenerating] = useState(false);
  const [_generatedPlan, setGeneratedPlan] = useState<any>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);

  // Markdown Modal state
  const [markdownModalOpen, setMarkdownModalOpen] = useState(false);
  const [selectedPlanMarkdown, setSelectedPlanMarkdown] = useState<string>('');
  const [selectedPlanSymbol, setSelectedPlanSymbol] = useState<string>('');
  const [markdownLoading, setMarkdownLoading] = useState(false);

  // 1. Fetch Technical Analysis — klines come from Binance directly (datacenter IPs are blocked)
  const fetchAnalysis = async () => {
    if (!activeSymbol || !activeInterval) return;
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const klRes = await fetch(
        `${BINANCE_FAPI}/fapi/v1/klines?symbol=${activeSymbol}&interval=${activeInterval}&limit=300`
      );
      if (!klRes.ok) throw new Error(`Binance error: ${klRes.status}`);
      const raw: any[][] = await klRes.json();
      const candles = raw.map(d => ({
        t: d[0], o: parseFloat(d[1]), h: parseFloat(d[2]),
        l: parseFloat(d[3]), c: parseFloat(d[4]), v: parseFloat(d[5]),
      }));

      const response = await fetch(
        `${API_BASE}/api/analysis/${activeSymbol}/${activeInterval}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candles }),
        }
      );
      if (!response.ok) throw new Error('Failed to fetch analysis');
      const data = await response.json();
      setAnalysisData(data);
    } catch (err: any) {
      setAnalysisError(err.message);
    } finally {
      setAnalysisLoading(false);
    }
  };

  // 2. Fetch all saved plans
  const fetchPlans = async () => {
    setPlansLoading(true);
    setPlansError(null);
    try {
      const response = await fetch(`${API_BASE}/api/plans`);
      if (!response.ok) throw new Error(`Сървърна грешка: ${response.status}`);
      const data = await response.json();
      setPlans(data);

      // Auto-trigger monitoring for each plan
      data.forEach((plan: Plan) => {
        monitorPlan(plan.id);
      });
    } catch (err: any) {
      console.error('Failed to load plans', err);
      setPlansError('Сървърът не отговаря (Render е заспал).');
    } finally {
      setPlansLoading(false);
    }
  };

  // 2b. Wake up Render backend by polling /api/health
  const wakeBackend = async () => {
    setWaking(true);
    setPlansError(null);
    const maxAttempts = 20;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          setWaking(false);
          fetchPlans();
          return;
        }
      } catch {
        // still sleeping — keep polling
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    setWaking(false);
    setPlansError('Сървърът не успя да се събуди. Опитай пак.');
  };

  // 3. Monitor a specific plan
  const monitorPlan = async (id: string) => {
    setMonitoringLoading(prev => ({ ...prev, [id]: true }));
    try {
      const response = await fetch(`${API_BASE}/api/plans/${id}/monitor`);
      if (!response.ok) throw new Error('Failed to monitor plan');
      const status = await response.json();
      setMonitoredStatuses(prev => ({ ...prev, [id]: status }));
    } catch (err) {
      console.error(`Failed to monitor ${id}`, err);
    } finally {
      setMonitoringLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  // 4. Generate AI Trading Plan
  const generateAIPlan = async () => {
    setGenerating(true);
    setGenerationError(null);
    setGeneratedPlan(null);
    try {
      const snapshot = await fetchMarketSnapshot(activeSymbol, API_BASE);
      const response = await fetch(`${API_BASE}/api/plans/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: activeSymbol, snapshot }),
      });
      if (!response.ok) throw new Error('Failed to generate plan. Please verify API key.');
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      
      setGeneratedPlan(data);
      // Refresh plans list to show the new plan
      fetchPlans();
      // Switch tab to Plans
      setTabValue(1);
    } catch (err: any) {
      setGenerationError(err.message);
    } finally {
      setGenerating(false);
    }
  };

  // 5. Open Plan Markdown Report
  const viewPlanMarkdown = async (id: string, symbol: string) => {
    setMarkdownLoading(true);
    setSelectedPlanSymbol(symbol);
    setMarkdownModalOpen(true);
    try {
      const response = await fetch(`${API_BASE}/api/plans/${id}/markdown`);
      if (!response.ok) throw new Error('Failed to load plan report');
      const data = await response.json();
      setSelectedPlanMarkdown(data.markdown);
    } catch (err: any) {
      setSelectedPlanMarkdown(`Грешка при зареждане на доклада: ${err.message}`);
    } finally {
      setMarkdownLoading(false);
    }
  };

  // 6. Delete active plan
  const deletePlan = async (id: string) => {
    if (!window.confirm(`Сигурни ли сте, че искате да изтриете плана за ${id}?`)) return;
    try {
      const response = await fetch(`${API_BASE}/api/plans/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('Failed to delete plan');
      
      // Filter out plan locally
      setPlans(prev => prev.filter(p => p.id !== id));
      setMonitoredStatuses(prev => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });
    } catch (err) {
      console.error('Delete error', err);
    }
  };

  // Trigger analysis load when active symbol/interval changes
  useEffect(() => {
    if (tabValue === 0) {
      fetchAnalysis();
    }
  }, [activeSymbol, activeInterval, tabValue]);

  // Trigger plans fetch when tab is opened
  useEffect(() => {
    if (tabValue === 1) {
      fetchPlans();
    }
  }, [tabValue]);

  const getSignalColor = (sig: string) => {
    if (sig === 'LONG') return 'var(--color-long)';
    if (sig === 'SHORT') return 'var(--color-short)';
    return 'var(--color-wait)';
  };

  const getStatusCodeColor = (code: string) => {
    if (!code) return 'var(--text-secondary)';
    if (code === 'ENTRY_ZONE') return 'var(--color-long)';
    if (code === 'STOP_LOSS') return 'var(--color-short)';
    if (code.includes('TP') && code.includes('HIT')) return '#10b981';
    if (code === 'ACTIVE') return '#3b82f6'; // Blue
    return 'var(--color-wait)';
  };

  const getStatusCodeLabel = (code: string) => {
    if (!code) return 'Изчисляване...';
    if (code === 'ENTRY_ZONE') return 'В ЗОНА ЗА ВХОД';
    if (code === 'STOP_LOSS') return 'СТОП ЛОС ДОСТИГНАТ';
    if (code.includes('TP') && code.includes('HIT')) return `ДОСТИГНАТ ${code.replace('_HIT', '')}`;
    if (code === 'ACTIVE') return 'АКТИВЕН';
    if (code === 'BELOW_ENTRY') return 'ПОД ВХОДА (LONG)';
    if (code === 'ABOVE_ENTRY') return 'НАД ВХОДА (SHORT)';
    return 'ИЗЧАКВАНЕ';
  };

  return (
    <Box
      className="glass-panel"
      sx={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: 0,
        borderTop: 'none',
        borderBottom: 'none',
        borderRight: 'none',
        background: 'rgba(11, 15, 25, 0.4)'
      }}
    >
      {/* Sidebar Header / Navigation */}
      <Box sx={{ borderBottom: '1px solid var(--surface-border)', background: 'rgba(15, 23, 42, 0.3)' }}>
        <Tabs
          value={tabValue}
          onChange={(_, val) => setTabValue(val)}
          variant="fullWidth"
          sx={{
            minHeight: '48px',
            '.MuiTab-root': {
              color: 'var(--text-secondary)',
              fontFamily: 'Outfit, sans-serif',
              fontSize: '0.85rem',
              fontWeight: 500,
              py: 1.5,
              '&.Mui-selected': { color: 'var(--primary-color)' }
            },
            '.MuiTabs-indicator': {
              backgroundColor: 'var(--primary-color)',
              height: '3px',
              borderRadius: '999px'
            }
          }}
        >
          <Tab label="Анализ" />
          <Tab label="Планове" />
          <Tab label="Робот (AI)" />
        </Tabs>
      </Box>

      {/* Tab Panels */}
      <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 2 }}>
        
        {/* Tab 0: Technical Analysis */}
        {tabValue === 0 && (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Технически Анализ: {activeSymbol} ({activeInterval})
              </Typography>
              <IconButton size="small" onClick={fetchAnalysis} disabled={analysisLoading} sx={{ color: '#fff' }}>
                <RefreshIcon />
              </IconButton>
            </Box>

            {analysisLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                <CircularProgress size={30} sx={{ color: 'var(--primary-color)' }} />
              </Box>
            ) : analysisError ? (
              <Typography color="error" variant="body2" sx={{ textAlign: 'center', py: 4 }}>
                Грешка при зареждане на анализа: {analysisError}
              </Typography>
            ) : analysisData ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                
                {/* Main Signal Display */}
                <Paper
                  sx={{
                    p: 2,
                    background: 'rgba(255, 255, 255, 0.03)',
                    border: '1px solid var(--surface-border)',
                    borderRadius: '10px',
                    textAlign: 'center'
                  }}
                >
                  <Typography variant="body2" sx={{ color: 'var(--text-secondary)', mb: 0.5 }}>
                    ГЕНЕРИРАН СИГНАЛ
                  </Typography>
                  <Typography
                    variant="h4"
                    sx={{
                      fontWeight: 700,
                      color: getSignalColor(analysisData.signal),
                      textShadow: `0 0 10px ${getSignalColor(analysisData.signal)}33`,
                      letterSpacing: '1px'
                    }}
                  >
                    {analysisData.signal_label}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'var(--text-muted)', display: 'block', mt: 0.5 }}>
                    Сила на сигнала: {analysisData.score} (на база Тренд и RSI)
                  </Typography>
                </Paper>

                {/* Trend Analysis */}
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'var(--text-secondary)', mb: 1 }}>
                    📈 ТРЕНД & СРЕДНИ ЦЕНИ
                  </Typography>
                  <List dense className="glass-panel" sx={{ py: 0, overflow: 'hidden', background: 'rgba(255, 255, 255, 0.01)' }}>
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2">Тренд посока</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>{analysisData.trend.label}</Typography>
                    </ListItem>
                    <Divider sx={{ borderColor: 'var(--surface-border)' }} />
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2">EMA 21</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{analysisData.trend.ema21}</Typography>
                    </ListItem>
                    <Divider sx={{ borderColor: 'var(--surface-border)' }} />
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2">EMA 50</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{analysisData.trend.ema50}</Typography>
                    </ListItem>
                    <Divider sx={{ borderColor: 'var(--surface-border)' }} />
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2">EMA 200</Typography>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{analysisData.trend.ema200}</Typography>
                    </ListItem>
                  </List>
                </Box>

                {/* RSI and Volatility */}
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'var(--text-secondary)', mb: 1 }}>
                    ⚡ ОСЦИЛАТОРИ & ВОЛАТИЛНОСТ
                  </Typography>
                  <List dense className="glass-panel" sx={{ py: 0, overflow: 'hidden', background: 'rgba(255, 255, 255, 0.01)' }}>
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2">RSI (14)</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {analysisData.rsi.value} ({analysisData.rsi.label})
                      </Typography>
                    </ListItem>
                    <Divider sx={{ borderColor: 'var(--surface-border)' }} />
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2">Волатилност (ATR 14)</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {analysisData.volatility.level} ({analysisData.volatility.atr_pct}%)
                      </Typography>
                    </ListItem>
                  </List>
                </Box>

                {/* Key levels */}
                <Box>
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'var(--text-secondary)', mb: 1 }}>
                    🎯 КЛЮЧОВИ НИВА (SUPPORT / RESISTANCE)
                  </Typography>
                  <List dense className="glass-panel" sx={{ py: 0, overflow: 'hidden', background: 'rgba(255, 255, 255, 0.01)' }}>
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2" sx={{ color: 'var(--color-short)' }}>Най-близка съпротива</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
                        {analysisData.levels.near_resist || 'Няма'}
                      </Typography>
                    </ListItem>
                    <Divider sx={{ borderColor: 'var(--surface-border)' }} />
                    <ListItem sx={{ py: 1, justifyContent: 'space-between' }}>
                      <Typography variant="body2" sx={{ color: 'var(--color-long)' }}>Най-близка подкрепа</Typography>
                      <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>
                        {analysisData.levels.near_support || 'Няма'}
                      </Typography>
                    </ListItem>
                  </List>
                </Box>

              </Box>
            ) : (
              <Typography variant="body2" sx={{ textAlign: 'center', py: 4, color: 'var(--text-muted)' }}>
                Изберете графика, за да се зареди технически анализ.
              </Typography>
            )}
          </Box>
        )}

        {/* Tab 1: Active Plans */}
        {tabValue === 1 && (
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                Трейдинг планове за проследяване
              </Typography>
              <IconButton size="small" onClick={fetchPlans} disabled={plansLoading} sx={{ color: '#fff' }}>
                <RefreshIcon />
              </IconButton>
            </Box>

            {plansLoading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
                <CircularProgress size={30} sx={{ color: 'var(--primary-color)' }} />
              </Box>
            ) : waking ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 6, gap: 2 }}>
                <CircularProgress size={30} sx={{ color: 'var(--primary-color)' }} />
                <Typography variant="body2" sx={{ color: 'var(--text-secondary)', textAlign: 'center' }}>
                  Събуждане на сървъра... (до ~60 сек.)
                </Typography>
              </Box>
            ) : plansError ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', py: 6, gap: 2 }}>
                <Typography variant="body2" sx={{ color: '#f43f5e', textAlign: 'center' }}>
                  ⚠ {plansError}
                </Typography>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={wakeBackend}
                  sx={{ color: 'var(--primary-color)', borderColor: 'var(--primary-color)', textTransform: 'none' }}
                >
                  Събуди сървъра
                </Button>
              </Box>
            ) : plans.length === 0 ? (
              <Typography variant="body2" sx={{ textAlign: 'center', py: 6, color: 'var(--text-secondary)' }}>
                Няма активни планове за мониторинг. Генерирайте нов план чрез робота (AI)!
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
                {plans.map((plan) => {
                  const status = monitoredStatuses[plan.id];
                  const loading = monitoringLoading[plan.id];
                  
                  return (
                    <Box
                      key={plan.id}
                      className="glass-panel"
                      sx={{
                        p: 2,
                        background: 'rgba(255, 255, 255, 0.02)',
                        border: '1px solid var(--surface-border)',
                        borderRadius: '10px',
                        '&:hover': {
                          borderColor: 'rgba(255, 255, 255, 0.15)'
                        }
                      }}
                    >
                      {/* Plan Header */}
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                            {plan.symbol}
                          </Typography>
                          <Chip
                            label={plan.config.direction}
                            size="small"
                            sx={{
                              height: '20px',
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              background: getSignalColor(plan.config.direction) + '22',
                              color: getSignalColor(plan.config.direction),
                              border: `1px solid ${getSignalColor(plan.config.direction)}44`
                            }}
                          />
                        </Box>
                        
                        <Box>
                          <IconButton
                            size="small"
                            onClick={() => monitorPlan(plan.id)}
                            disabled={loading}
                            sx={{ color: 'var(--text-secondary)' }}
                          >
                            <RefreshIcon sx={{ fontSize: '1rem' }} />
                          </IconButton>
                          <IconButton
                            size="small"
                            onClick={() => deletePlan(plan.id)}
                            sx={{ color: '#f43f5e' }}
                          >
                            <DeleteIcon sx={{ fontSize: '1.1rem' }} />
                          </IconButton>
                        </Box>
                      </Box>

                      {/* Levels grid */}
                      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mb: 2 }}>
                        <Box>
                          <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>Входна Зона</Typography>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                            {plan.config.entry_min} - {plan.config.entry_max}
                          </Typography>
                        </Box>
                        <Box>
                          <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>Stop Loss</Typography>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace', color: 'var(--color-short)', fontWeight: 600 }}>
                            {plan.config.stop_loss}
                          </Typography>
                        </Box>
                        <Box sx={{ gridColumn: 'span 2' }}>
                          <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>Цели (Take Profit)</Typography>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
                            {plan.config.targets.join(' ➔ ')}
                          </Typography>
                        </Box>
                      </Box>

                      <Divider sx={{ borderColor: 'var(--surface-border)', my: 1.5 }} />

                      {/* Monitoring Status Panel */}
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Typography variant="caption" sx={{ color: 'var(--text-secondary)' }}>Пазарен статус</Typography>
                          {loading ? (
                            <CircularProgress size={12} sx={{ color: 'var(--primary-color)' }} />
                          ) : status ? (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 600, color: 'var(--text-primary)' }}>
                                Цена: {status.current_price} USD
                              </Typography>
                            </Box>
                          ) : (
                            <Typography variant="caption" sx={{ color: 'var(--text-muted)' }}>Неизвестен</Typography>
                          )}
                        </Box>

                        {/* Status alert text */}
                        {status && (
                          <Box
                            sx={{
                              p: 1,
                              borderRadius: '6px',
                              background: getStatusCodeColor(status.status_code) + '0b',
                              border: `1px solid ${getStatusCodeColor(status.status_code)}22`,
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 0.5
                            }}
                          >
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <Typography
                                variant="caption"
                                sx={{
                                  fontWeight: 700,
                                  color: getStatusCodeColor(status.status_code)
                                }}
                              >
                                {getStatusCodeLabel(status.status_code)}
                              </Typography>
                              <Typography variant="caption" sx={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                                RSI: {status.current_rsi}
                              </Typography>
                            </Box>
                            <Typography variant="caption" sx={{ color: 'var(--text-secondary)', fontSize: '0.75rem', lineHeight: '1.25' }}>
                              {status.status_text}
                            </Typography>
                          </Box>
                        )}
                      </Box>

                      {/* Activate plan on chart */}
                      <Button
                        size="small"
                        fullWidth
                        variant="contained"
                        startIcon={<ShowChartIcon sx={{ fontSize: '0.9rem' }} />}
                        onClick={() => onActivatePlan({
                          symbol: plan.symbol,
                          direction: plan.config.direction,
                          entry_min: plan.config.entry_min,
                          entry_max: plan.config.entry_max,
                          targets: plan.config.targets,
                          stop_loss: plan.config.stop_loss,
                        })}
                        sx={{
                          mt: 2,
                          background: 'linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%)',
                          color: '#fff',
                          fontFamily: 'Outfit, sans-serif',
                          textTransform: 'none',
                          fontSize: '0.75rem',
                          py: 0.5,
                          boxShadow: '0 2px 10px rgba(99,102,241,0.25)',
                          '&:hover': { boxShadow: '0 4px 15px rgba(99,102,241,0.4)' }
                        }}
                      >
                        Нанеси на графика
                      </Button>

                      {/* View full MD button */}
                      <Button
                        size="small"
                        fullWidth
                        variant="outlined"
                        onClick={() => viewPlanMarkdown(plan.id, plan.symbol)}
                        sx={{
                          mt: 2,
                          color: '#fff',
                          borderColor: 'var(--surface-border)',
                          fontFamily: 'Outfit, sans-serif',
                          textTransform: 'none',
                          fontSize: '0.75rem',
                          py: 0.5,
                          '&:hover': {
                            borderColor: 'var(--primary-color)',
                            background: 'rgba(99, 102, 241, 0.05)'
                          }
                        }}
                      >
                        Виж целия AI доклад (Markdown)
                      </Button>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        )}

        {/* Tab 2: AI Plan Generator */}
        {tabValue === 2 && (
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1 }}>
              🤖 AI Трейдинг Робот
            </Typography>
            <Typography variant="body2" sx={{ color: 'var(--text-secondary)', mb: 3 }}>
              Роботът ще събере технически данни за {activeSymbol} (показатели за 1h, 4h и 1d времеви рамки), деривативни статистики като Open Interest и Funding Rate, пазарен сентимент и книгата с поръчки. След това ще извика Gemini Pro, за да състави професионален трейдинг план на български език с нива за вход, цели и стоп.
            </Typography>

            <Button
              variant="contained"
              fullWidth
              disabled={generating || !activeSymbol}
              onClick={generateAIPlan}
              startIcon={generating ? <CircularProgress size={16} sx={{ color: '#fff' }} /> : <AutoAwesomeIcon />}
              sx={{
                background: 'linear-gradient(135deg, var(--primary-color) 0%, var(--secondary-color) 100%)',
                color: '#fff',
                fontFamily: 'Outfit, sans-serif',
                fontWeight: 600,
                textTransform: 'none',
                py: 1.5,
                borderRadius: '8px',
                boxShadow: '0 4px 15px rgba(99, 102, 241, 0.3)',
                '&:hover': {
                  background: 'linear-gradient(135deg, var(--primary-color) 20%, var(--secondary-color) 100%)',
                  boxShadow: '0 6px 20px rgba(99, 102, 241, 0.4)'
                }
              }}
            >
              {generating ? 'Генериране на план...' : `Състави план за ${activeSymbol}`}
            </Button>

            {generationError && (
              <Box sx={{ mt: 3, p: 2, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', borderRadius: '8px' }}>
                <Typography variant="body2" color="error">
                  Грешка при генериране: {generationError}
                </Typography>
              </Box>
            )}
          </Box>
        )}
      </Box>

      {/* Markdown Report Modal */}
      <Dialog
        open={markdownModalOpen}
        onClose={() => setMarkdownModalOpen(false)}
        maxWidth="md"
        fullWidth
        PaperProps={{
          sx: {
            background: 'var(--background-color)',
            backgroundImage: 'var(--bg-gradient)',
            border: '1px solid var(--surface-border)',
            borderRadius: '16px',
            color: '#fff',
            maxHeight: '85vh'
          }
        }}
      >
        <DialogTitle
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            p: 2,
            borderBottom: '1px solid var(--surface-border)'
          }}
        >
          <Typography variant="h6" sx={{ fontFamily: 'Outfit, sans-serif', fontWeight: 700 }}>
            🤖 AI Трейдинг план за {selectedPlanSymbol}
          </Typography>
          <IconButton onClick={() => setMarkdownModalOpen(false)} sx={{ color: '#fff' }}>
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 3, borderColor: 'var(--surface-border)' }}>
          {markdownLoading ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
              <CircularProgress sx={{ color: 'var(--primary-color)' }} />
            </Box>
          ) : (
            <Box
              sx={{
                fontFamily: 'Outfit, sans-serif',
                lineHeight: 1.6,
                color: '#e2e8f0',
                '& h1, & h2, & h3': {
                  color: '#fff',
                  mt: 2,
                  mb: 1,
                  fontWeight: 600
                },
                '& ul, & ol': {
                  pl: 3,
                  mb: 2
                },
                '& li': {
                  mb: 0.5
                },
                '& hr': {
                  borderColor: 'var(--surface-border)',
                  my: 2
                },
                '& strong': {
                  color: '#fff',
                  fontWeight: 600
                },
                whiteSpace: 'pre-wrap'
              }}
            >
              {selectedPlanMarkdown}
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, borderTop: '1px solid var(--surface-border)' }}>
          <Button
            onClick={() => setMarkdownModalOpen(false)}
            variant="contained"
            sx={{
              background: 'var(--primary-color)',
              '&:hover': { background: '#4f46e5' },
              fontFamily: 'Outfit, sans-serif',
              textTransform: 'none'
            }}
          >
            Затвори
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};
