import pandas as pd
import numpy as np
from typing import Dict, List, Tuple

class IndicatorsCalculator:
    """
    Клас за изчисляване на технически индикатори и нива на подкрепа/съпротива 
    с помощта на Pandas, без външни сложни зависимости.
    """
    
    @staticmethod
    def calculate_sma(df: pd.DataFrame, period: int = 50) -> pd.Series:
        return df["close"].rolling(window=period).mean()

    @staticmethod
    def calculate_ema(df: pd.DataFrame, period: int = 20) -> pd.Series:
        return df["close"].ewm(span=period, adjust=False).mean()

    @staticmethod
    def calculate_rsi(df: pd.DataFrame, period: int = 14) -> pd.Series:
        delta = df["close"].diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        
        # Стандартно изглаждане на Уайлдър (Wilder's smoothing)
        avg_gain = gain.ewm(com=period - 1, adjust=False).mean()
        avg_loss = loss.ewm(com=period - 1, adjust=False).mean()
        
        # Предотвратяване на разделяне на нула
        avg_loss = avg_loss.replace(0, 0.00001)
        
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        return rsi

    @staticmethod
    def calculate_macd(df: pd.DataFrame, fast_period: int = 12, slow_period: int = 26, signal_period: int = 9) -> Tuple[pd.Series, pd.Series, pd.Series]:
        ema_fast = df["close"].ewm(span=fast_period, adjust=False).mean()
        ema_slow = df["close"].ewm(span=slow_period, adjust=False).mean()
        
        macd_line = ema_fast - ema_slow
        signal_line = macd_line.ewm(span=signal_period, adjust=False).mean()
        macd_hist = macd_line - signal_line
        
        return macd_line, signal_line, macd_hist

    @staticmethod
    def calculate_bollinger_bands(df: pd.DataFrame, period: int = 20, num_std: float = 2.0) -> Tuple[pd.Series, pd.Series, pd.Series]:
        middle_band = df["close"].rolling(window=period).mean()
        std_dev = df["close"].rolling(window=period).std()
        
        upper_band = middle_band + (num_std * std_dev)
        lower_band = middle_band - (num_std * std_dev)
        
        return upper_band, middle_band, lower_band

    @staticmethod
    def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
        high = df["high"]
        low = df["low"]
        close_prev = df["close"].shift(1)
        
        tr1 = high - low
        tr2 = (high - close_prev).abs()
        tr3 = (low - close_prev).abs()
        
        tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
        # Стандартно Уайлдър изглаждане за ATR
        atr = tr.ewm(com=period - 1, adjust=False).mean()
        return atr

    @staticmethod
    def find_support_resistance_levels(df: pd.DataFrame, window: int = 5) -> Dict[str, List[float]]:
        """
        Открива локални нива на подкрепа (локални минимуми) и съпротива (локални максимуми).
        Параметърът `window` определя колко свещи отляво и отдясно трябва да са по-ниски/по-високи.
        Нивата се групират и филтрират, за да се изведат най-важните.
        """
        supports = []
        resistances = []
        
        # Работим главно с последните 150 свещи за актуалност
        df_len = len(df)
        start_idx = max(window, df_len - 150)
        
        for i in range(start_idx, df_len - window):
            current_high = df["high"].iloc[i]
            current_low = df["low"].iloc[i]
            
            # Проверка за локален максимум (Resistance)
            is_resistance = True
            for w in range(1, window + 1):
                if df["high"].iloc[i - w] >= current_high or df["high"].iloc[i + w] >= current_high:
                    is_resistance = False
                    break
            
            # Проверка за локален минимум (Support)
            is_support = True
            for w in range(1, window + 1):
                if df["low"].iloc[i - w] <= current_low or df["low"].iloc[i + w] <= current_low:
                    is_support = False
                    break
                    
            if is_resistance:
                resistances.append(current_high)
            if is_support:
                supports.append(current_low)
                
        # Филтриране и групиране на близки нива (в рамките на 1.2% разстояние)
        # за предотвратяване на твърде много близки линии.
        def cluster_levels(levels: List[float], threshold_pct: float = 1.2) -> List[float]:
            if not levels:
                return []
            levels = sorted(levels)
            clustered = []
            current_cluster = [levels[0]]
            
            for lvl in levels[1:]:
                # Ако нивото е близо до предходното (под threshold_pct %)
                if (lvl - current_cluster[-1]) / current_cluster[-1] * 100 < threshold_pct:
                    current_cluster.append(lvl)
                else:
                    clustered.append(float(np.mean(current_cluster)))
                    current_cluster = [lvl]
            clustered.append(float(np.mean(current_cluster)))
            
            # Връщаме сортирани нива
            return sorted(clustered)

        # Взимаме текущата цена за референция
        current_price = float(df["close"].iloc[-1])
        
        clustered_sup = cluster_levels(supports)
        clustered_res = cluster_levels(resistances)
        
        # Разделяне на нивата спрямо текущата цена
        active_supports = [lvl for lvl in clustered_sup if lvl < current_price][-3:] # Последните 3 най-близки подкрепи
        active_resistances = [lvl for lvl in clustered_res if lvl > current_price][:3] # Първите 3 най-близки съпротиви
        
        return {
            "supports": active_supports,
            "resistances": active_resistances
        }

    def process_dataframe(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Обработва DataFrame и добавя всички изчислени индикатори към него.
        """
        df = df.copy()
        
        # Пълзящи средни
        df["ema_20"] = self.calculate_ema(df, 20)
        df["sma_50"] = self.calculate_sma(df, 50)
        df["sma_200"] = self.calculate_sma(df, 200)
        
        # Осцилатори
        df["rsi"] = self.calculate_rsi(df, 14)
        
        # MACD
        macd_l, signal_l, macd_h = self.calculate_macd(df)
        df["macd_line"] = macd_l
        df["macd_signal"] = signal_l
        df["macd_hist"] = macd_h
        
        # Bollinger Bands
        upper_bb, middle_bb, lower_bb = self.calculate_bollinger_bands(df)
        df["bb_upper"] = upper_bb
        df["bb_middle"] = middle_bb
        df["bb_lower"] = lower_bb
        
        # Волатилност (ATR)
        df["atr"] = self.calculate_atr(df, 14)
        
        return df
