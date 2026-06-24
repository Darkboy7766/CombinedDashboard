import os
import json
import sys
import re
from src.data_fetcher import DataFetcher
from colorama import Fore, Style, init

init(autoreset=True)

class TradingMonitor:
    """
    Клас, който сравнява реалното състояние на пазара с активния съхранен план
    и извежда подробен статус в конзолата с цветни кодове.
    """
    def __init__(self, plans_dir: str = "plans"):
        self.plans_dir = plans_dir
        self.fetcher = DataFetcher()

    def get_active_plans(self) -> list:
        """
        Връща списък с всички активи, за които има записани планове.
        """
        if not os.path.exists(self.plans_dir):
            return []
        
        plans = []
        for file in os.listdir(self.plans_dir):
            if file.endswith("_plan.json"):
                plans.append(file.replace("_plan.json", ""))
        return plans

    def load_plan(self, symbol: str) -> dict:
        """
        Зарежда записания JSON план за дадения актив.
        """
        norm_symbol = re.sub(r"[^A-Za-z0-9]", "", symbol).upper()
        path = os.path.join(self.plans_dir, f"{norm_symbol}_plan.json")
        
        if not os.path.exists(path):
            raise FileNotFoundError(f"Не е намерен активен план за {norm_symbol}.")
            
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def check_market_status(self, symbol: str) -> dict:
        """
        Сравнява текущите пазарни данни от Binance Futures с активния записан план.
        Връща детайлен отчет.
        """
        plan_data = self.load_plan(symbol)
        config = plan_data["config"]
        
        direction = config.get("direction", "WAIT").upper()
        entry_min = float(config.get("entry_min", 0.0))
        entry_max = float(config.get("entry_max", 0.0))
        targets = [float(x) for x in config.get("targets", [])]
        stop_loss = float(config.get("stop_loss", 0.0))
        
        # Намиране на реалния борсов символ
        match = re.match(r"^([A-Z0-9]+)_\d{8}_\d{6}$", symbol.upper())
        base_symbol = match.group(1) if match else symbol
        
        # Взимаме текущата цена и пазарни показатели от Binance Futures
        funding_info = self.fetcher.fetch_funding_rate_info(base_symbol)
        current_price = funding_info["mark_price"]
        
        # Извличаме RSI (1h) за фино позициониране
        df_1h = self.fetcher.fetch_ohlcv(base_symbol, "1h", limit=50)
        from src.indicators import IndicatorsCalculator
        calc = IndicatorsCalculator()
        processed_df = calc.process_dataframe(df_1h)
        current_rsi = float(processed_df["rsi"].iloc[-1])
        
        status_text = ""
        color = ""
        status_code = "WAITING"
        
        if direction == "WAIT":
            if entry_min > 0:
                if entry_min <= current_price <= entry_max:
                    status_text = f"ИЗЧАКВАНЕ (WAIT) - Цената влезе в потенциалната зона за вход! (Цена {current_price:.4f} е между {entry_min:.4f} и {entry_max:.4f})"
                    color = Fore.GREEN + Style.BRIGHT
                    status_code = "ENTRY_ZONE"
                else:
                    status_text = f"ИЗЧАКВАНЕ (WAIT) - Наблюдава се пазара. Потенциален вход при {entry_min:.4f} - {entry_max:.4f} (Текуща цена: {current_price:.4f})"
                    color = Fore.YELLOW
                    status_code = "WAITING"
            else:
                status_text = "ИЗЧАКВАНЕ (WAIT) - Пазарът се наблюдава, няма активни нива."
                color = Fore.YELLOW
                status_code = "WAITING"
        elif direction == "LONG":
            if current_price < stop_loss:
                status_text = f"СТОП ЛОС Е ДОСТИГНАТ! (Цена {current_price:.4f} < SL {stop_loss:.4f})"
                color = Fore.RED + Style.BRIGHT
                status_code = "STOP_LOSS"
            elif entry_min <= current_price <= entry_max:
                status_text = f"ЦЕНАТА Е В ЗОНАТА ЗА ВХОД (ENTRY ZONE)! (Цена {current_price:.4f} е между {entry_min:.4f} и {entry_max:.4f})"
                color = Fore.GREEN + Style.BRIGHT
                status_code = "ENTRY_ZONE"
            elif current_price < entry_min:
                status_text = f"ЦЕНАТА Е ПОД ЗОНАТА ЗА ВХОД, но над Stop Loss. (Възможно по-евтино влизане? Цена: {current_price:.4f})"
                color = Fore.CYAN
                status_code = "BELOW_ENTRY"
            else:
                reached_targets = [t for t in targets if current_price >= t]
                pending_targets = [t for t in targets if current_price < t]
                
                if reached_targets:
                    status_text = f"ДОСТИГНАТИ ЦЕЛИ: {', '.join([f'TP{targets.index(t)+1} ({t:.4f})' for t in reached_targets])}!"
                    if pending_targets:
                        status_text += f" Следваща цел: TP{targets.index(pending_targets[0])+1} ({pending_targets[0]:.4f})"
                    color = Fore.GREEN
                    status_code = f"TP{len(reached_targets)}_HIT"
                else:
                    status_text = f"Позицията е активна. Цена е над зоната за вход ({current_price:.4f} > {entry_max:.4f}). Изчакване на TP1 ({targets[0]:.4f})."
                    color = Fore.BLUE
                    status_code = "ACTIVE"
                    
        elif direction == "SHORT":
            if current_price > stop_loss:
                status_text = f"СТОП ЛОС Е ДОСТИГНАТ! (Цена {current_price:.4f} > SL {stop_loss:.4f})"
                color = Fore.RED + Style.BRIGHT
                status_code = "STOP_LOSS"
            elif entry_min <= current_price <= entry_max:
                status_text = f"ЦЕНАТА Е В ЗОНАТА ЗА ВХОД (ENTRY ZONE)! (Цена {current_price:.4f} е между {entry_min:.4f} и {entry_max:.4f})"
                color = Fore.GREEN + Style.BRIGHT
                status_code = "ENTRY_ZONE"
            elif current_price > entry_max:
                status_text = f"ЦЕНАТА Е НАД ЗОНАТА ЗА ВХОД, но под Stop Loss. (Възможно по-скъпо SHORT влизане? Цена: {current_price:.4f})"
                color = Fore.CYAN
                status_code = "ABOVE_ENTRY"
            else:
                reached_targets = [t for t in targets if current_price <= t]
                pending_targets = [t for t in targets if current_price > t]
                
                if reached_targets:
                    status_text = f"ДОСТИГНАТИ ЦЕЛИ: {', '.join([f'TP{targets.index(t)+1} ({t:.4f})' for t in reached_targets])}!"
                    if pending_targets:
                        status_text += f" Следваща цел: TP{targets.index(pending_targets[0])+1} ({pending_targets[0]:.4f})"
                    color = Fore.GREEN
                    status_code = f"TP{len(reached_targets)}_HIT"
                else:
                    status_text = f"Позицията е активна. Цена е под зоната за вход ({current_price:.4f} < {entry_min:.4f}). Изчакване на TP1 ({targets[0]:.4f})."
                    color = Fore.BLUE
                    status_code = "ACTIVE"

        return {
            "symbol": symbol,
            "created_at": plan_data["created_at"],
            "direction": direction,
            "entry_min": entry_min,
            "entry_max": entry_max,
            "targets": targets,
            "stop_loss": stop_loss,
            "current_price": current_price,
            "current_rsi": current_rsi,
            "status_text": status_text,
            "status_code": status_code,
            "color_code": color,
            "funding_rate": funding_info["current_funding_rate_pct"]
        }

    def print_monitoring_report(self, symbol: str):
        """
        Принтира форматирания красив статус репорт в конзолата.
        """
        try:
            report = self.check_market_status(symbol)
        except FileNotFoundError as e:
            print(f"{Fore.RED}[!] {e}")
            return
            
        print("\n" + "="*60)
        print(f"{Fore.CYAN}{Style.BRIGHT}   МОНИТОРИНГ НА ТРЕЙДИНГ ПЛАН: {report['symbol'].upper()}   ")
        print("="*60)
        print(f"[*] Планирана посока : {Fore.MAGENTA}{Style.BRIGHT}{report['direction']}")
        print(f"[*] Дата на съставяне: {report['created_at']}")
        print(f"[*] Планиран Вход    : {report['entry_min']:.4f} - {report['entry_max']:.4f} USD")
        print(f"[*] Цели (Take Profit): {', '.join([f'TP{i+1}: {x:.4f}' for i, x in enumerate(report['targets'])])} USD")
        print(f"[*] Stop Loss        : {Fore.RED}{report['stop_loss']:.4f} USD")
        print("-"*60)
        print(f"{Fore.WHITE}{Style.BRIGHT}[+] ТЕКУЩО СЪСТОЯНИЕ НА ПАЗАРА:")
        print(f"    - Текуща цена: {Fore.YELLOW}{Style.BRIGHT}{report['current_price']:.4f} USD")
        print(f"    - RSI (1h)   : {report['current_rsi']:.2f}")
        print(f"    - Funding    : {report['funding_rate']:.4f}%")
        print("-"*60)
        print(f"{Fore.WHITE}{Style.BRIGHT}[!] СТАТУС НА ПЛАНА:")
        print(f"    {report['color_code']}{report['status_text']}")
        print("="*60 + "\n")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("symbol", nargs="?", default=None)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--plans-dir", default="plans")
    args = parser.parse_args()
    
    # Preventing windows console encoding crash
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        
    monitor = TradingMonitor(plans_dir=args.plans_dir)
    if args.symbol:
        if args.json:
            try:
                res = monitor.check_market_status(args.symbol)
                # Copying and cleaning ANSI codes from json response
                clean_res = res.copy()
                clean_res["color_code"] = ""
                print(json.dumps(clean_res, ensure_ascii=False))
            except Exception as e:
                print(json.dumps({"error": str(e)}, ensure_ascii=False))
        else:
            monitor.print_monitoring_report(args.symbol)
    else:
        plans = monitor.get_active_plans()
        if args.json:
            print(json.dumps(plans, ensure_ascii=False))
        else:
            print(f"Active plans: {plans}")
