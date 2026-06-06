#!/usr/bin/env python3
import sys
import os
import json
import traceback

# Add the current directory to sys.path so it can find 'src' and other modules
current_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, current_dir)

import data_source as ds
import analysis_engine as ae
from src.data_fetcher import DataFetcher
from src.agent import TradingAgent
from src.monitor import TradingMonitor

def cmd_klines(symbol, interval, limit=250):
    candles = ds.get_klines(symbol, interval, limit, futures=True)
    emas = ae.get_ema_series(candles)
    return {"candles": candles, "emas": emas}

def cmd_analysis(symbol, interval, limit=250):
    candles = ds.get_klines(symbol, interval, limit, futures=True)
    analysis = ae.analyse(candles, symbol, interval)
    return analysis

def df_to_records(df):
    # Convert timestamps and structures to json-friendly list of dicts
    records = df.copy()
    if "datetime" in records.columns:
        records["datetime"] = records["datetime"].dt.strftime("%Y-%m-%d %H:%M:%S")
    return records.to_dict(orient="records")

def cmd_snapshot(symbol):
    fetcher = DataFetcher()
    data = fetcher.fetch_all_market_data(symbol)
    
    # Make it JSON serializable
    serializable = {}
    for k, v in data.items():
        if k in ["ohlcv_1d", "ohlcv_4h", "ohlcv_1h"]:
            serializable[k] = df_to_records(v)
        else:
            serializable[k] = v
    return serializable

def cmd_generate_plan(symbol, plans_dir="plans"):
    fetcher = DataFetcher()
    agent = TradingAgent(plans_dir=plans_dir)
    
    # 1. Fetch market snapshot data
    data = fetcher.fetch_all_market_data(symbol)
    
    # 2. Generate prompt
    prompt = agent.generate_prompt_content(data)
    
    # 3. Request plan from Gemini
    ai_response = agent.generate_plan_via_api(prompt)
    if not ai_response:
        return {"error": "Неуспешна комуникация с Gemini API."}
        
    # 4. Parse JSON config and clean report
    config, clean_report = agent.parse_ai_response_for_json(ai_response)
    if not config:
        return {
            "error": "Отговорът от AI не съдържаше валиден структуриран JSON блок за нивата.",
            "raw_response": ai_response
        }
        
    # 5. Save the plan
    md_path, json_path = agent.save_plan(symbol, config, clean_report)
    
    return {
        "success": True,
        "symbol": symbol,
        "config": config,
        "report": clean_report,
        "md_path": md_path,
        "json_path": json_path
    }

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command specified"}))
        sys.exit(1)
        
    cmd = sys.argv[1].lower()
    
    # Forces stdout encoding to be utf-8
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        
    try:
        if cmd == "klines":
            symbol = sys.argv[2]
            interval = sys.argv[3]
            limit = int(sys.argv[4]) if len(sys.argv) > 4 else 250
            res = cmd_klines(symbol, interval, limit)
            print(json.dumps(res, ensure_ascii=False))
            
        elif cmd == "analysis":
            symbol = sys.argv[2]
            interval = sys.argv[3]
            res = cmd_analysis(symbol, interval)
            print(json.dumps(res, ensure_ascii=False))
            
        elif cmd == "snapshot":
            symbol = sys.argv[2]
            res = cmd_snapshot(symbol)
            print(json.dumps(res, ensure_ascii=False))
            
        elif cmd == "generate-plan":
            symbol = sys.argv[2]
            plans_dir = sys.argv[3] if len(sys.argv) > 3 else "plans"
            res = cmd_generate_plan(symbol, plans_dir)
            print(json.dumps(res, ensure_ascii=False))
            
        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}))
            sys.exit(1)
            
    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "traceback": traceback.format_exc()
        }, ensure_ascii=False))
        sys.exit(1)

if __name__ == "__main__":
    main()
