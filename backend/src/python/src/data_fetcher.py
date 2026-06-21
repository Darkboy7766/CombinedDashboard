import os
import sys
import requests
import pandas as pd
import time
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bybit_source

class DataFetcher:
    """
    Класифициран модул за извличане на пазарни данни от Binance Futures API,
    както и сентимент и макро индикатори от външни публични API-та.

    При грешка от Binance (rate limit, region block, timeout) автоматично
    превключва към Bybit за същия символ.
    """
    def __init__(self):
        self.base_url = "https://fapi.binance.com"
        self.fng_url = "https://api.alternative.me/fng/"
        self.coingecko_url = "https://api.coingecko.com/api/v3/global"

    def normalize_symbol(self, symbol: str) -> str:
        """
        Нормализира символа от формат като BTC/USDT, btc-usdt или btc usdt в BTCUSDT.
        """
        return symbol.replace("/", "").replace("-", "").replace(" ", "").upper()

    def fetch_ohlcv(self, symbol: str, interval: str = "1h", limit: int = 300) -> pd.DataFrame:
        """
        Извлича исторически OHLCV данни от Binance Futures.
        Връща Pandas DataFrame с колони: timestamp, open, high, low, close, volume.
        """
        norm_symbol = self.normalize_symbol(symbol)
        endpoint = f"{self.base_url}/fapi/v1/klines"
        params = {
            "symbol": norm_symbol,
            "interval": interval,
            "limit": limit
        }

        try:
            response = requests.get(endpoint, params=params, timeout=10)
            response.raise_for_status()
            data = response.json()

            # Конвертиране в DataFrame
            df = pd.DataFrame(data, columns=[
                "timestamp", "open", "high", "low", "close", "volume",
                "close_time", "quote_volume", "count", "taker_buy_volume",
                "taker_buy_quote_volume", "ignore"
            ])

            # Преобразуване на типовете данни към float
            float_cols = ["open", "high", "low", "close", "volume"]
            df[float_cols] = df[float_cols].astype(float)
        except Exception:
            candles = bybit_source.get_klines(norm_symbol, interval, limit, futures=True)
            df = pd.DataFrame([
                {"timestamp": c["t"], "open": c["o"], "high": c["h"],
                 "low": c["l"], "close": c["c"], "volume": c["v"]} for c in candles
            ])

        # Времева марка към дата и час
        df["datetime"] = pd.to_datetime(df["timestamp"], unit="ms")

        return df[["timestamp", "datetime", "open", "high", "low", "close", "volume"]]

    def fetch_funding_rate_info(self, symbol: str) -> Dict[str, any]:
        """
        Извлича текущия Funding Rate и изчислява средната му стойност за последните 10 периода.
        """
        norm_symbol = self.normalize_symbol(symbol)

        try:
            # 1. Текущ Funding Rate
            endpoint_current = f"{self.base_url}/fapi/v1/premiumIndex"
            params = {"symbol": norm_symbol}
            res_current = requests.get(endpoint_current, params=params, timeout=10)
            res_current.raise_for_status()
            current_data = res_current.json()

            current_funding_rate = float(current_data.get("lastFundingRate", 0.0))
            mark_price = float(current_data.get("markPrice", 0.0))

            # 2. История за изчисляване на средното (10 периода)
            endpoint_history = f"{self.base_url}/fapi/v1/fundingRate"
            params_history = {
                "symbol": norm_symbol,
                "limit": 10
            }
            res_hist = requests.get(endpoint_history, params_history, timeout=10)
            res_hist.raise_for_status()
            hist_data = res_hist.json()

            rates = [float(x["fundingRate"]) for x in hist_data]
            avg_funding_rate = sum(rates) / len(rates) if rates else current_funding_rate
        except Exception:
            # Bybit има само текущия funding rate, не история — средното = текущото.
            ticker = bybit_source.get_ticker(norm_symbol)
            current_funding_rate = ticker["funding_rate"]
            mark_price = ticker["mark_price"]
            avg_funding_rate = current_funding_rate
        
        # Проверка кой плаща (лонговете или шортовете)
        payer = "Longs pay Shorts" if current_funding_rate > 0 else "Shorts pay Longs"
        if current_funding_rate == 0:
            payer = "Neutral"

        return {
            "current_funding_rate": current_funding_rate,
            "current_funding_rate_pct": current_funding_rate * 100,
            "avg_funding_rate_10p": avg_funding_rate,
            "avg_funding_rate_10p_pct": avg_funding_rate * 100,
            "payer": payer,
            "mark_price": mark_price
        }

    def fetch_open_interest_info(self, symbol: str) -> Dict[str, any]:
        """
        Извлича текущия Open Interest и процентната му промяна (Delta %) за последното денонощие и 1 час.
        """
        norm_symbol = self.normalize_symbol(symbol)

        try:
            # 1. Текущ Open Interest
            endpoint_current = f"{self.base_url}/fapi/v1/openInterest"
            res_current = requests.get(endpoint_current, params={"symbol": norm_symbol}, timeout=10)
            res_current.raise_for_status()
            current_oi = float(res_current.json().get("openInterest", 0.0))
            binance_ok = True
        except Exception:
            current_oi = bybit_source.get_ticker(norm_symbol)["open_interest"]
            binance_ok = False

        # 2. История на Open Interest за 1h период (последните 2 записа)
        oi_delta_pct = 0.0
        try:
            if binance_ok:
                endpoint_hist = f"{self.base_url}/data/openInterestHist"
                res_hist = requests.get(endpoint_hist, params={"symbol": norm_symbol, "period": "1h", "limit": 2}, timeout=10)
                res_hist.raise_for_status()
                hist_data = res_hist.json()
            else:
                hist_data = bybit_source.get_open_interest_hist(norm_symbol, "1h", 2)

            if len(hist_data) >= 2:
                prev_oi = float(hist_data[0]["sumOpenInterest"])
                curr_oi_hist = float(hist_data[1]["sumOpenInterest"])
                if prev_oi > 0:
                    oi_delta_pct = ((curr_oi_hist - prev_oi) / prev_oi) * 100
        except Exception:
            pass

        return {
            "open_interest": current_oi,
            "oi_delta_1h_pct": oi_delta_pct,
            "capital_flow": "Capital Entering (Bullish/Trend strengthening)" if oi_delta_pct > 0 else "Capital Leaving (Bearish/Trend weakening)"
        }

    def fetch_long_short_ratio(self, symbol: str) -> Dict[str, any]:
        """
        Извлича Long/Short съотношението на Binance Futures (глобално за акаунти).
        """
        norm_symbol = self.normalize_symbol(symbol)
        endpoint = f"{self.base_url}/data/globalLongShortAccountRatio"
        params = {
            "symbol": norm_symbol,
            "period": "1h",
            "limit": 1
        }
        
        ratio = 1.0
        long_pct = 50.0
        short_pct = 50.0

        try:
            res = requests.get(endpoint, params=params, timeout=10)
            res.raise_for_status()
            data = res.json()
        except Exception:
            try:
                data = bybit_source.get_long_short_ratio(norm_symbol, "1h", 1)
            except Exception:
                data = None

        if data:
            ratio = float(data[0]["longShortRatio"])
            long_pct = float(data[0]["longAccount"]) * 100
            short_pct = float(data[0]["shortAccount"]) * 100

        signal = "Neutral"
        if ratio > 2.0:
            signal = "Extreme Long Dominance (Potential Contrarian Bearish Signal)"
        elif ratio < 0.5:
            signal = "Extreme Short Dominance (Potential Contrarian Bullish Signal)"

        return {
            "long_short_ratio": ratio,
            "long_account_pct": long_pct,
            "short_account_pct": short_pct,
            "contrarian_signal": signal
        }

    def fetch_order_book_imbalance(self, symbol: str) -> Dict[str, any]:
        """
        Извлича Order Book дълбочината и изчислява Imbalance Ratio (bids / asks за първите 50 нива).
        """
        norm_symbol = self.normalize_symbol(symbol)
        endpoint = f"{self.base_url}/fapi/v1/depth"
        params = {
            "symbol": norm_symbol,
            "limit": 100
        }

        try:
            res = requests.get(endpoint, params=params, timeout=10)
            res.raise_for_status()
            depth = res.json()
        except Exception:
            depth = bybit_source.get_orderbook(norm_symbol, 100)

        bids = depth.get("bids", [])[:50]
        asks = depth.get("asks", [])[:50]
        
        total_bid_vol = sum(float(volume) for price, volume in bids)
        total_ask_vol = sum(float(volume) for price, volume in asks)
        
        imbalance = 1.0
        if total_ask_vol > 0:
            imbalance = total_bid_vol / total_ask_vol
            
        interpretation = "Neutral / Balanced"
        if imbalance > 1.5:
            interpretation = "Buyers Dominating Order Book (Bullish Pressure)"
        elif imbalance < 0.67:
            interpretation = "Sellers Dominating Order Book (Bearish Pressure)"

        return {
            "bid_volume_top50": total_bid_vol,
            "ask_volume_top50": total_ask_vol,
            "imbalance_ratio": imbalance,
            "order_book_pressure": interpretation
        }

    def fetch_fear_and_greed_index(self) -> Dict[str, any]:
        """
        Извлича индекса на страх и алчност (Fear & Greed Index) за крипто пазара.
        """
        try:
            res = requests.get(self.fng_url, timeout=10)
            res.raise_for_status()
            data = res.json()
            
            fng_value = int(data["data"][0]["value"])
            fng_class = data["data"][0]["value_classification"]
            
            interpretation = "Neutral"
            if fng_value < 25:
                interpretation = "Extreme Fear (Potential Buying Opportunity)"
            elif fng_value > 75:
                interpretation = "Extreme Greed (Potential Market Top / Risk)"
            elif fng_value < 45:
                interpretation = "Fear"
            elif fng_value > 55:
                interpretation = "Greed"
                
            return {
                "fear_and_greed_value": fng_value,
                "fear_and_greed_classification": fng_class,
                "sentiment_interpretation": interpretation
            }
        except Exception:
            return {
                "fear_and_greed_value": 50,
                "fear_and_greed_classification": "Neutral",
                "sentiment_interpretation": "Sentiment data unavailable"
            }

    def fetch_macro_context(self) -> Dict[str, any]:
        """
        Извлича глобални крипто макро данни.
        """
        try:
            res = requests.get(self.coingecko_url, timeout=10)
            res.raise_for_status()
            data = res.json()["data"]
            
            btc_d = float(data.get("market_cap_percentage", {}).get("btc", 54.0))
            eth_d = float(data.get("market_cap_percentage", {}).get("eth", 17.0))
            
            total_mcap = float(data.get("total_market_cap", {}).get("usd", 2.2e12))
            mcap_change_24h = float(data.get("market_cap_change_percentage_24h_usd", 0.0))
            
            return {
                "btc_dominance": btc_d,
                "eth_dominance": eth_d,
                "total_market_cap_usd": total_mcap,
                "market_cap_change_24h_pct": mcap_change_24h
            }
        except Exception:
            return {
                "btc_dominance": 54.5,
                "eth_dominance": 17.2,
                "total_market_cap_usd": 2.35e12,
                "market_cap_change_24h_pct": 1.25
            }

    def fetch_all_market_data(self, symbol: str) -> Dict[str, any]:
        """
        Извлича ВСИЧКИ необходими пазарни данни за пълноценен анализ на дадения актив.
        """
        norm_symbol = self.normalize_symbol(symbol)
        
        # 1. Извличане на OHLCV за три времеви рамки
        df_1d = self.fetch_ohlcv(norm_symbol, "1d", limit=200)
        df_4h = self.fetch_ohlcv(norm_symbol, "4h", limit=200)
        df_1h = self.fetch_ohlcv(norm_symbol, "1h", limit=200)
        
        # 2. Деривативни данни
        funding = self.fetch_funding_rate_info(norm_symbol)
        oi = self.fetch_open_interest_info(norm_symbol)
        ls_ratio = self.fetch_long_short_ratio(norm_symbol)
        
        # 3. Order Book и пазарен контекст
        order_book = self.fetch_order_book_imbalance(norm_symbol)
        sentiment = self.fetch_fear_and_greed_index()
        macro = self.fetch_macro_context()
        
        return {
            "symbol": norm_symbol,
            "formatted_symbol": f"{norm_symbol[:-4]}/{norm_symbol[-4:]}" if norm_symbol.endswith("USDT") else norm_symbol,
            "timestamp": time.time(),
            "time_string": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "ohlcv_1d": df_1d,
            "ohlcv_4h": df_4h,
            "ohlcv_1h": df_1h,
            "funding_rate": funding,
            "open_interest": oi,
            "long_short_ratio": ls_ratio,
            "order_book": order_book,
            "sentiment": sentiment,
            "macro": macro
        }
