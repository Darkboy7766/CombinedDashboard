# CombinedDashboard — Трейдинг Табло

Обединено крипто трейдинг табло с live графики, технически анализ, AI план генератор и мониторинг на позиции.

---

## Архитектура

```
CombinedDashboard/
├── frontend/                  # React + TypeScript + Vite (порт 3000)
│   ├── src/
│   │   ├── App.tsx            # Главен компонент — grid, sidebar, export
│   │   ├── config.ts          # API_BASE от VITE_BACKEND_URL
│   │   ├── utils/
│   │   │   └── market.ts      # fetchMarketSnapshot() — споделен utility
│   │   └── components/
│   │       ├── Navbar.tsx     # Macro статистики, grid контрол, Експорт
│   │       ├── ChartsGrid.tsx # Grid layout (1/2/4/6/8 графики)
│   │       ├── TradingChart.tsx  # Candlestick + EMA 21/50/200 + план нива
│   │       └── Sidebar.tsx    # Анализ / Планове / AI Робот tabs
│   ├── vercel.json            # Rewrite: /api/* → Render backend
│   └── vite.config.ts         # Dev proxy: /api → localhost:5000
│
├── backend/                   # Node.js + Express (порт 5000)
│   ├── src/
│   │   ├── index.js           # REST endpoints + WebSocket сървър
│   │   └── python/
│   │       ├── bridge.py      # CLI интерфейс към Python слоя
│   │       ├── analysis_engine.py  # EMA, RSI, ATR, Support/Resistance
│   │       ├── data_source.py      # Klines от Binance (server-side)
│   │       └── src/
│   │           ├── agent.py        # Gemini API интеграция
│   │           ├── data_fetcher.py # Пълен snapshot (server-side)
│   │           ├── indicators.py   # Технически индикатори
│   │           └── monitor.py      # Следи план спрямо пазарна цена
│   ├── plans/                 # JSON + Markdown файлове с генерирани планове
│   └── requirements.txt       # Python зависимости
└── package.json               # Root scripts (concurrently dev)
```

---

## Потоци на данни

### 1. Live графики (WebSocket)

```
Binance Futures WebSocket (fstream.binance.com)
  → backend/src/index.js (WebSocket proxy)
    → TradingChart.tsx (lightweight-charts candlestick)
```

Фронтендът изпраща `{ symbol, interval }` към бекенда. Бекендът отваря WebSocket към Binance и препраща тиковете в реално време към браузъра.

### 2. Технически анализ (Tab „Анализ")

```
Binance FAPI REST (от браузъра)
  → klines 300 свещи
    → POST /api/analysis/:symbol/:interval
      → Python bridge.py (analysis-stdin)
        → analysis_engine.py
          → EMA 21/50/200, RSI 14, ATR 14, Support/Resistance
            → JSON резултат → Sidebar.tsx
```

Klines се fetch-ват директно от браузъра (Binance позволява CORS за `/fapi/v1/klines`). Candles-ите се изпращат като POST body към бекенда, за да се избегне CORS блокът за server-side Binance заявки.

### 3. AI Трейдинг план (Tab „Робот (AI)")

```
Браузър → fetchMarketSnapshot(symbol)
  ├── Binance FAPI: klines 1h/4h/1d, premiumIndex, openInterest, depth
  ├── /api/binance/openInterestHist (backend proxy → Binance futures/data)
  ├── /api/binance/globalLongShortAccountRatio (backend proxy → Binance futures/data)
  ├── alternative.me/fng (Fear & Greed)
  └── CoinGecko /api/v3/global (BTC dominance, Market Cap)
    → POST /api/plans/generate { symbol, snapshot }
      → Python bridge.py (generate-plan-stdin)
        → agent.py → generate_prompt_content()
          → Gemini API (gemini-3.1-flash-lite)
            → parse JSON config блок
              → save_plan() → plans/SYMBOL_plan.json + .md
                → { success, config, report }
```

Snapshot-ът се събира изцяло в браузъра и се изпраща към бекенда. Два Binance endpoint-а `/futures/data/` са CORS блокирани от браузъра и минават през backend proxy.

### 4. Мониторинг на планове (Tab „Планове")

```
GET /api/plans → чете plans/*.json
GET /api/plans/:id/monitor
  → Python src/monitor.py
    → Binance: текуща цена + RSI
      → сравнява с entry_zone / stop_loss / targets
        → { status_code, status_text, current_price, current_rsi }
```

### 5. Macro статистики (Navbar)

```
Браузър (при зареждане)
  ├── alternative.me/fng → Fear & Greed Index
  └── CoinGecko /api/v3/global → BTC Dominance, Total Market Cap
```

Директни browser заявки — без бекенд, без Python.

### 6. Експорт за Claude

```
Браузър → fetchMarketSnapshot(symbol) [пълен snapshot]
  + Binance klines за текущия interval
    → POST /api/analysis/:symbol/:interval [Python технически анализ]
      → JSON payload в клипборда
        { user_trading_profile, market_snapshot, historical_ohlcv_data, technical_analysis }
```

---

## Backend REST Endpoints

| Метод | Endpoint | Описание |
|-------|----------|----------|
| GET | `/api/health` | Health check |
| GET | `/api/klines/:symbol/:interval` | Klines + EMAs (Python/server-side) |
| POST | `/api/analysis/:symbol/:interval` | Технически анализ от candles в body |
| GET | `/api/snapshot/:symbol` | Пълен snapshot (Python/server-side) |
| GET | `/api/binance/openInterestHist` | Proxy → Binance futures/data |
| GET | `/api/binance/globalLongShortAccountRatio` | Proxy → Binance futures/data |
| POST | `/api/plans/generate` | Генерира AI план (Gemini) |
| GET | `/api/plans` | Списък всички планове |
| GET | `/api/plans/:id/markdown` | Markdown доклад на план |
| GET | `/api/plans/:id/monitor` | Текущ статус на план |
| DELETE | `/api/plans/:id` | Изтрива план |
| WS | `/ws` | WebSocket proxy към Binance streams |

---

## Деплоймент

### Production

- **Frontend**: Vercel (`combined-dashboard-pi.vercel.app`)
- **Backend**: Render (`combineddashboard-xvoo.onrender.com`)

`frontend/vercel.json` съдържа rewrite правило, което проксира всички `/api/*` заявки от Vercel към Render. По този начин фронтендът не се нуждае от `VITE_BACKEND_URL` env var.

### Локална разработка

```bash
# В корена на проекта
npm run dev
```

Стартира фронтенда на :3000 и бекенда на :5000 едновременно (concurrently). Vite proxy в `vite.config.ts` препраща `/api` → `localhost:5000`.

### Environment Variables (Render)

| Промен лива | Описание |
|-------------|----------|
| `GEMINI_API_KEY` | API ключ за Gemini (задължително) |
| `GEMINI_MODEL` | Модел (по подразбиране: `gemini-3.1-flash-lite`) |
| `PORT` | HTTP порт (по подразбиране: 5000) |

---

## Python зависимости

```
google-generativeai
pandas
python-dotenv
requests
numpy
```

Инсталират се автоматично при `npm install` в backend/ чрез `postinstall` script.

---

## Защо някои данни идват от браузъра

Binance блокира заявки от datacenter IP адреси (Render, Vercel) за повечето FAPI endpoints. Затова:

- Klines, premiumIndex, openInterest, depth → директно от браузъра ✓
- `/futures/data/openInterestHist`, `/futures/data/globalLongShortAccountRatio` → CORS блокирани от браузъра, минават през backend proxy ✓
- Технически анализ → candles от браузъра, изчисления в Python на Render ✓
