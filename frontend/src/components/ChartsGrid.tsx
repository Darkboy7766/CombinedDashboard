import React from 'react';
import { Box } from '@mui/material';
import { TradingChart, PlanLevels } from './TradingChart';

interface ChartInfo {
  id: string;
  symbol: string;
  interval: string;
}

interface ChartsGridProps {
  charts: ChartInfo[];
  activeChartId: string;
  gridCount: number;
  onSelectChart: (id: string) => void;
  onRemoveChart: (id: string) => void;
  onActiveChartInfoChange: (symbol: string, interval: string) => void;
  planLevels?: PlanLevels | null;
}

export const ChartsGrid: React.FC<ChartsGridProps> = ({
  charts,
  activeChartId,
  gridCount,
  onSelectChart,
  onRemoveChart,
  onActiveChartInfoChange,
  planLevels
}) => {
  // Determine grid template columns based on requested grid count
  const getGridTemplate = () => {
    switch (gridCount) {
      case 1:
        return {
          gridTemplateColumns: '1fr',
          gridTemplateRows: '1fr',
        };
      case 2:
        return {
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
          gridTemplateRows: { xs: 'repeat(2, 1fr)', md: '1fr' },
        };
      case 4:
        return {
          gridTemplateColumns: 'repeat(2, 1fr)',
          gridTemplateRows: 'repeat(2, 1fr)',
        };
      case 6:
        return {
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)' },
          gridTemplateRows: 'repeat(2, 1fr)',
        };
      case 8:
        return {
          gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)' },
          gridTemplateRows: 'repeat(2, 1fr)',
        };
      default:
        return {
          gridTemplateColumns: '1fr',
          gridTemplateRows: '1fr',
        };
    }
  };

  const gridStyles = getGridTemplate();

  // Slice charts array to render only what corresponds to gridCount
  const visibleCharts = charts.slice(0, gridCount);

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        width: '100%',
        height: '100%',
        p: 2,
        ...gridStyles,
      }}
    >
      {visibleCharts.map((chart) => (
        <Box key={chart.id} sx={{ minHeight: 0 }}>
          <TradingChart
            id={chart.id}
            isActive={chart.id === activeChartId}
            onSelect={() => onSelectChart(chart.id)}
            onRemove={visibleCharts.length > 1 ? () => onRemoveChart(chart.id) : undefined}
            defaultSymbol={chart.symbol}
            defaultInterval={chart.interval}
            onActiveInfoChange={onActiveChartInfoChange}
            forcedSymbol={chart.id === activeChartId ? planLevels?.symbol : undefined}
            planLevels={chart.id === activeChartId ? planLevels : null}
          />
        </Box>
      ))}
    </Box>
  );
};
