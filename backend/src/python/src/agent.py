import json
import re
import os
import pandas as pd
import google.generativeai as genai
from dotenv import load_dotenv
from typing import Dict, Any, Optional, Tuple

load_dotenv()

class TradingAgent:
    """
    Клас, който синтезира събраните пазарни данни, генерира подробен
    промпт за AI или директно извиква Gemini API за съставяне на трейдинг план.
    Записва генерираните планове в директория 'plans/'.
    """
    def __init__(self, plans_dir: str = "plans"):
        self.api_key = os.getenv("GEMINI_API_KEY")
        self.default_mode = os.getenv("DEFAULT_MODE", "prompt").lower()
        self.model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-flash")
        self.plans_dir = plans_dir
        
        # Създаване на директория за планове, ако не съществува
        if not os.path.exists(self.plans_dir):
            os.makedirs(self.plans_dir)
            
        if self.api_key:
            genai.configure(api_key=self.api_key)

    def generate_prompt_content(self, data: Dict[str, Any]) -> str:
        """
        Сглобява подробния промпт с всички събрани пазарни данни.
        """
        symbol = data["symbol"]
        formatted_symbol = data["formatted_symbol"]
        
        # Получаване на последната цена и индикатори от 1h, 4h и 1d
        df_1h = data["ohlcv_1h"]
        df_4h = data["ohlcv_4h"]
        df_1d = data["ohlcv_1d"]
        
        # Функция за форматиране на индикатори за последната свещ
        def get_candle_info(df):
            if df.empty or len(df) < 50:
                return "Няма достатъчно данни"
            
            # Изчисляване на локалните индикатори за свещта
            from src.indicators import IndicatorsCalculator
            calc = IndicatorsCalculator()
            processed = calc.process_dataframe(df)
            last = processed.iloc[-1]
            
            # Намиране на нива
            levels = calc.find_support_resistance_levels(df)
            
            return {
                "close": last["close"],
                "ema_20": last.get("ema_20", 0.0),
                "sma_50": last.get("sma_50", 0.0),
                "sma_200": last.get("sma_200", 0.0),
                "rsi": last.get("rsi", 50.0),
                "bb_upper": last.get("bb_upper", 0.0),
                "bb_lower": last.get("bb_lower", 0.0),
                "atr": last.get("atr", 0.0),
                "supports": levels["supports"],
                "resistances": levels["resistances"]
            }
            
        info_1h = get_candle_info(df_1h)
        info_4h = get_candle_info(df_4h)
        info_1d = get_candle_info(df_1d)
        
        # Съставяне на текстовия промпт
        prompt = f"""Вие сте елитен институционален крипто трейдър и риск мениджър.
Вашата цел е да направите детайлен технически и пазарен анализ за деривативния актив {formatted_symbol} (Binance Futures) и да съставите професионален трейдинг план за следващите дни.

--- ДАННИ ЗА АКТИВА ---
Анализиран символ: {formatted_symbol}
Текуща цена (Mark Price): {data['funding_rate']['mark_price']:.4f} USD
Време на анализ: {data['time_string']}

--- МУЛТИ-ТАЙМФРЕЙМ ТЕХНИЧЕСКИ АНАЛИЗ ---
1. Времева рамка: 1 ЧАС (1h)
   - Текуща цена: {info_1h['close']:.4f}
   - EMA 20: {info_1h['ema_20']:.4f} | SMA 50: {info_1h['sma_50']:.4f}
   - RSI (14): {info_1h['rsi']:.2f}
   - Bollinger Bands: Горна: {info_1h['bb_upper']:.4f} | Долна: {info_1h['bb_lower']:.4f}
   - ATR (14): {info_1h['atr']:.4f}
   - Локални подкрепи: {", ".join([f"{x:.4f}" for x in info_1h['supports']])}
   - Локални съпротиви: {", ".join([f"{x:.4f}" for x in info_1h['resistances']])}

2. Времева рамка: 4 ЧАСА (4h)
   - Цена: {info_4h['close']:.4f}
   - EMA 20: {info_4h['ema_20']:.4f} | SMA 50: {info_4h['sma_50']:.4f}
   - RSI (14): {info_4h['rsi']:.2f}
   - Bollinger Bands: Горна: {info_4h['bb_upper']:.4f} | Долна: {info_4h['bb_lower']:.4f}
   - ATR (14): {info_4h['atr']:.4f}
   - Локални подкрепи: {", ".join([f"{x:.4f}" for x in info_4h['supports']])}
   - Локални съпротиви: {", ".join([f"{x:.4f}" for x in info_4h['resistances']])}

3. Времева рамка: 1 ДЕН (1d)
   - Цена: {info_1d['close']:.4f}
   - EMA 20: {info_1d['ema_20']:.4f} | SMA 50: {info_1d['sma_50']:.4f} | SMA 200: {info_1d['sma_200']:.4f}
   - RSI (14): {info_1d['rsi']:.2f}
   - Bollinger Bands: Горна: {info_1d['bb_upper']:.4f} | Долна: {info_1d['bb_lower']:.4f}
   - ATR (14): {info_1d['atr']:.4f}
   - Важни подкрепи: {", ".join([f"{x:.4f}" for x in info_1d['supports']])}
   - Важни съпротиви: {", ".join([f"{x:.4f}" for x in info_1d['resistances']])}

--- ДЕРИВАТИВНИ ПОКАЗАТЕЛИ (BINANCE FUTURES) ---
- Текущ Funding Rate: {data['funding_rate']['current_funding_rate_pct']:.4f}%
- Среден Funding Rate (последни 10 периода): {data['funding_rate']['avg_funding_rate_10p_pct']:.4f}%
- Кой плаща: {data['funding_rate']['payer']}
- Open Interest: {data['open_interest']['open_interest']:.2f}
- Open Interest Delta (1h %): {data['open_interest']['oi_delta_1h_pct']:.2f}% ({data['open_interest']['capital_flow']})
- Long/Short Ratio: {data['long_short_ratio']['long_short_ratio']:.2f}
- Съотношение на акаунтите: Лонгове {data['long_short_ratio']['long_account_pct']:.2f}% vs Шортове {data['long_short_ratio']['short_account_pct']:.2f}%
- Контрариански сигнал: {data['long_short_ratio']['contrarian_signal']}
- Дълбочина на офертите (Order Book Imbalance Ratio): {data['order_book']['imbalance_ratio']:.2f} ({data['order_book']['order_book_pressure']})

--- ПАЗАРЕН СЕНТИМЕНТ & МАКРО КОНТЕКСТ ---
- Fear & Greed Index: {data['sentiment']['fear_and_greed_value']}/100 ({data['sentiment']['fear_and_greed_classification']}) -> {data['sentiment']['sentiment_interpretation']}
- BTC Dominance: {data['macro']['btc_dominance']:.2f}%
- ETH Dominance: {data['macro']['eth_dominance']:.2f}%
- Обща капитализация: {data['macro']['total_market_cap_usd'] / 1e12:.2f}T USD | 24h промяна: {data['macro']['market_cap_change_24h_pct']:.2f}%

--- ВАШИТЕ ЗАДАЧИ ---
Моля, напишете професионален трейдинг план на БЪЛГАРСКИ език. Той трябва да съдържа:

1. **Пазарен Преглед**: Анализ на структурата на пазара на различните времеви рамки (тренд, моментум, волатилност по ATR).

2. **Деривативен Анализ**: Тълкуване на Funding Rate, Open Interest Delta, Long/Short Ratio и Order Book Imbalance. Какво правят големите играчи? Влиза ли нов капитал или излиза?

3. **Сентимент & Макро контекст**: Тълкуване на Fear & Greed и доминацията.

4. **Проверка на потвърждаващите фактори (ЗАДЪЛЖИТЕЛНО ПРЕДИ СТРАТЕГИЯТА)**:
Оцени всеки от следните 7 фактора като ✅ ИЗПЪЛНЕН или ❌ НЕ ИЗПЪЛНЕН, с кратко обяснение защо:
   - Фактор 1: HTF тренд (1d EMA стек — бичи/мечи подредба)
   - Фактор 2: LTF тренд (4h EMA стек — съответствие с HTF)
   - Фактор 3: RSI позиция (не в неутрална зона 45–55 на работния таймфрейм)
   - Фактор 4: Funding Rate сигнал (екстремна стойност или ясна посока)
   - Фактор 5: OI Delta сигнал (ясен приток или отлив на капитал)
   - Фактор 6: Long/Short Ratio контрариански сигнал (тълпата е прекалено едностранчива)
   - Фактор 7: Order Book натиск (ясен дисбаланс bid/ask)

**ПРАВИЛО ЗА CONFLUENCE:** Ако по-малко от 3 фактора са ✅ ИЗПЪЛНЕНИ → посоката е задължително **WAIT**. Не генерирай LONG/SHORT план при недостатъчна конфлуенция. Изброй изрично кои фактори НЕ са изпълнени и защо спират сетъпа.

5. **Трейдинг Стратегия**:
   - Ясно посочена посока: **LONG**, **SHORT** или **WAIT** (Изчакване).
   - Обосновка на стратегията (защо се избира тази посока).
   - **Зона за покупка/вход (Entry Zone)**: Минимална и максимална цена за позициониране.
   - **Цели за печалба (Take Profits)**: Точно 3 цели.
     - TP1 протокол: след достигане → премести Stop Loss на breakeven.
     - TP2 протокол: след достигане → trailing Stop Loss под последния swing low (long) / над swing high (short).
   - **Ниво за спиране на загубата (Stop Loss)**: Точна цена и обосновка.
   - **Ниво на инвалидация**: Конкретна цена/условие, при което планът е невалиден и позицията се затваря незабавно (може да съвпада със SL или да е по-широко).
   - **R/R проверка (ЗАДЪЛЖИТЕЛНО)**: Изчисли R/R за TP1. Ако TP1 R/R < 1:1.5 → отхвърли сетъпа и задай WAIT.
   - **Управление на риска**: Препоръчителен размер на позицията и R/R за всички 3 цели.

6. **СТРУКТУРИРАН КОНФИГУРАЦИОНЕН БЛОК (ИЗКЛЮЧИТЕЛНО ВАЖНО!)**:
За да може софтуерният агент да следи плана Ви автоматично, моля задължително на самия край на вашия отговор добавете следния JSON блок в секция с код, попълнен с Вашите точни цифрови препоръки (без текстови коментари вътре в JSON обекта! Използвайте чисти флоут числа):

```json
{{
  "direction": "LONG",
  "entry_min": 65000.0,
  "entry_max": 65800.0,
  "targets": [67200.0, 68500.0, 70000.0],
  "stop_loss": 63900.0
}}
```
Забележка: Сменете посоката на "SHORT" или "WAIT" в зависимост от плана Ви и попълнете съответно числата. При WAIT — попълни потенциалните нива, които си анализирал (или нули ако няма). При отхвърлен сетъп заради R/R или confluence — задай direction "WAIT".
"""
        return prompt

    def generate_plan_via_api(self, prompt: str) -> Optional[str]:
        """
        Извиква Gemini API за автоматично генериране на плана.
        """
        if not self.api_key:
            return None
        
        try:
            model = genai.GenerativeModel(self.model_name)
            response = model.generate_content(prompt)
            return response.text
        except Exception as e:
            import sys
            sys.stderr.write(f"[!] Gemini API error: {e}\n")
            return None

    def parse_ai_response_for_json(self, text: str) -> Tuple[Optional[Dict[str, Any]], str]:
        """
        Търси JSON блока в отговора на изкуствения интелект и го извлича.
        """
        json_pattern = r"```json\s*(\{.*?\})\s*```"
        match = re.search(json_pattern, text, re.DOTALL)

        extracted_json = None
        clean_text = text

        if match:
            json_str = match.group(1).strip()
            try:
                extracted_json = json.loads(json_str)
                # Премахва цялата секция от заглавието на конфигурационния блок до края
                clean_text = re.sub(
                    r'\n*[^\n]*СТРУКТУРИРАН КОНФИГУРАЦИОНЕН БЛОК.*',
                    '',
                    text,
                    flags=re.DOTALL | re.IGNORECASE
                ).strip()
            except Exception as e:
                print(f"[!] Открит е JSON блок, но има грешка при форматирането му: {e}")

        return extracted_json, clean_text

    def save_plan(self, symbol: str, json_config: Dict[str, Any], markdown_report: str) -> Tuple[str, str]:
        """
        Запазва плана в два формата: JSON и Markdown.
        """
        norm_symbol = symbol.replace("/", "").replace("-", "").upper()
        
        json_path = os.path.join(self.plans_dir, f"{norm_symbol}_plan.json")
        md_path = os.path.join(self.plans_dir, f"{norm_symbol}_plan.md")
        
        full_json = {
            "symbol": norm_symbol,
            "created_at": pd.Timestamp.now().isoformat(),
            "config": json_config
        }
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(full_json, f, indent=4, ensure_ascii=False)
            
        header = f"""# ТРЕЙДИНГ ПЛАН ЗА {norm_symbol}
**Създаден на:** {pd.Timestamp.now().strftime('%Y-%m-%d %H:%M:%S')}
**Посока на търговия:** {json_config.get('direction', 'WAIT').upper()}
**Зона за вход:** {json_config.get('entry_min', 0)} - {json_config.get('entry_max', 0)} USD
**Цели (Take Profits):** {", ".join([str(x) for x in json_config.get('targets', [])])} USD
**Stop Loss:** {json_config.get('stop_loss', 0)} USD

---

"""
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(header + markdown_report)
            
        return md_path, json_path
