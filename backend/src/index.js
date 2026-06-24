require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

// Whitelist for symbol/interval — used both as subprocess args and as
// filename fragments under plansDir, so this also blocks path traversal.
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;
const INTERVAL_RE = /^[0-9]{1,3}[mhdwM]$/;
const isValidSymbol = (s) => typeof s === 'string' && SYMBOL_RE.test(s);
const isValidInterval = (i) => typeof i === 'string' && INTERVAL_RE.test(i);

app.use(cors());
app.use(express.json());

// Temp dir for monitor.py (needs a local JSON file to read plan config)
const plansDir = process.platform === 'win32'
  ? path.join(__dirname, '..', 'plans')
  : '/tmp/plans';
if (!fs.existsSync(plansDir)) {
  fs.mkdirSync(plansDir, { recursive: true });
}

// Supabase client (service role — bypasses RLS)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Create HTTP server
const server = http.createServer(app);

// Initialize WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ noServer: true });

// --- Helper to execute python bridge commands ---
// Uses spawn with an argument array (no shell), so arguments can never be
// interpreted as shell metacharacters — unlike the previous exec()-based
// version, which only escaped double quotes and was vulnerable to command
// injection via the symbol/interval route params.
function runBridge(command, args = []) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'python', 'bridge.py');
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(pythonBin, [pythonScript, command, ...args.map(String)]);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (code !== 0) {
        console.error(`Python Exec error (exit ${code}): ${stderr || stdout}`);
        return reject(new Error(stderr || stdout || `Exit ${code}`));
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json.error) {
          return reject(new Error(json.error));
        }
        resolve(json);
      } catch (parseError) {
        console.error(`Failed to parse stdout: ${stdout}`);
        reject(new Error(`Failed to parse Python output: ${parseError.message}`));
      }
    });
  });
}

// --- Helper to execute monitor.py ---
function runMonitor(symbol) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'python', 'src', 'monitor.py');
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(pythonBin, [pythonScript, symbol, '--json', '--plans-dir', plansDir]);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (code !== 0) {
        console.error(`Monitor Exec error (exit ${code}): ${stderr || stdout}`);
        return reject(new Error(stderr || stdout || `Exit ${code}`));
      }
      try {
        const json = JSON.parse(stdout.trim());
        if (json.error) {
          return reject(new Error(json.error));
        }
        resolve(json);
      } catch (parseError) {
        console.error(`Failed to parse monitor stdout: ${stdout}`);
        reject(new Error(`Failed to parse Monitor output: ${parseError.message}`));
      }
    });
  });
}

// --- Helper to pass large data to Python via stdin ---
function runBridgeWithStdin(command, args, stdinData) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'python', 'bridge.py');
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    const child = spawn(pythonBin, [pythonScript, command, ...args]);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || stdout || `Exit ${code}`));
      try {
        const json = JSON.parse(stdout.trim());
        if (json.error) return reject(new Error(json.error));
        resolve(json);
      } catch (e) {
        reject(new Error(`Parse error: ${e.message}`));
      }
    });
    child.stdin.write(stdinData);
    child.stdin.end();
  });
}

// --- Helpers ---

// Fetches a URL and resolves with the parsed JSON body, or rejects on
// network error, non-2xx status (incl. 429/418 rate-limit), or bad JSON.
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (bRes) => {
      let data = '';
      bRes.on('data', d => { data += d; });
      bRes.on('end', () => {
        if (bRes.statusCode < 200 || bRes.statusCode >= 300) {
          return reject(new Error(`HTTP ${bRes.statusCode}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Binance errors (rate limit, region block) fall back to the equivalent
// Bybit v5 endpoint, reshaped to match Binance's response so callers
// (frontend/src/utils/market.ts) don't need to know which exchange answered.
async function proxyOpenInterestHist(req, res) {
  const { symbol, period = '1h', limit = '2' } = req.query;
  try {
    const data = await fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`);
    return res.json(data);
  } catch (e) {
    try {
      const result = await fetchJson(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=${period}&limit=${limit}`);
      const list = (result.result?.list || []).slice().reverse();
      return res.json(list.map(d => ({ symbol, sumOpenInterest: d.openInterest, sumOpenInterestValue: d.openInterest, timestamp: Number(d.timestamp) })));
    } catch (e2) {
      return res.status(502).json({ error: `Binance failed (${e.message}), Bybit failed (${e2.message})` });
    }
  }
}

async function proxyLongShortRatio(req, res) {
  const { symbol, period = '1h', limit = '1' } = req.query;
  try {
    const data = await fetchJson(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=${limit}`);
    return res.json(data);
  } catch (e) {
    try {
      const result = await fetchJson(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${symbol}&period=${period}&limit=${limit}`);
      const list = (result.result?.list || []).slice().reverse();
      return res.json(list.map(d => {
        const buy = Number(d.buyRatio), sell = Number(d.sellRatio);
        return { symbol, longShortRatio: sell ? buy / sell : null, longAccount: buy, shortAccount: sell, timestamp: Number(d.timestamp) };
      }));
    } catch (e2) {
      return res.status(502).json({ error: `Binance failed (${e.message}), Bybit failed (${e2.message})` });
    }
  }
}

// --- REST Endpoints ---

// Proxy Binance statistics endpoints (blocked by CORS in browsers)
app.get('/api/binance/openInterestHist', proxyOpenInterestHist);

app.get('/api/binance/globalLongShortAccountRatio', proxyLongShortRatio);

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'CombinedDashboard backend is running' });
});

// Fetch Candles and EMAs
app.get('/api/klines/:symbol/:interval', async (req, res) => {
  const { symbol, interval } = req.params;
  if (!isValidSymbol(symbol) || !isValidInterval(interval)) {
    return res.status(400).json({ error: 'Invalid symbol or interval' });
  }
  const limit = req.query.limit || 250;
  try {
    const data = await runBridge('klines', [symbol, interval, limit]);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Technical Analysis — candles come from the browser (Binance blocks server IPs)
app.post('/api/analysis/:symbol/:interval', async (req, res) => {
  const { symbol, interval } = req.params;
  if (!isValidSymbol(symbol) || !isValidInterval(interval)) {
    return res.status(400).json({ error: 'Invalid symbol or interval' });
  }
  const { candles } = req.body;
  if (!candles?.length) return res.status(400).json({ error: 'candles required' });
  try {
    const data = await runBridgeWithStdin('analysis-stdin', [symbol, interval], JSON.stringify(candles));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch Full Snapshot (Derivative + Sentiment + Macro + Technicals)
app.get('/api/snapshot/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  try {
    const data = await runBridge('snapshot', [symbol]);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate Trading Plan using Gemini API — snapshot comes from browser
app.post('/api/plans/generate', async (req, res) => {
  const { symbol, snapshot } = req.body;
  if (!symbol) return res.status(400).json({ error: 'Symbol is required' });
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  if (!snapshot) return res.status(400).json({ error: 'snapshot is required' });
  try {
    const result = await runBridgeWithStdin('generate-plan-stdin', [symbol, plansDir], JSON.stringify(snapshot));
    const { error } = await supabase.from('plans').upsert({
      id: result.symbol,
      symbol: result.symbol,
      created_at: new Date().toISOString(),
      config: result.config,
      markdown: result.report,
    }, { onConflict: 'id' });
    if (error) throw new Error(error.message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all active plans
app.get('/api/plans', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('id, symbol, created_at, config')
      .order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get plan markdown report
app.get('/api/plans/:symbol/markdown', async (req, res) => {
  const { symbol } = req.params;
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('markdown')
      .eq('id', symbol.toUpperCase())
      .single();
    if (error || !data) return res.status(404).json({ error: `Plan for ${symbol} not found.` });
    res.json({ markdown: data.markdown });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Monitor an active plan — writes temp JSON so monitor.py can read plan config
app.get('/api/plans/:symbol/monitor', async (req, res) => {
  const { symbol } = req.params;
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  const upperSymbol = symbol.toUpperCase();
  try {
    const { data } = await supabase
      .from('plans')
      .select('symbol, created_at, config')
      .eq('id', upperSymbol)
      .single();
    if (data) {
      fs.writeFileSync(
        path.join(plansDir, `${upperSymbol}_plan.json`),
        JSON.stringify({ symbol: data.symbol, created_at: data.created_at, config: data.config }, null, 2)
      );
    }
    const status = await runMonitor(upperSymbol);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an active plan
app.delete('/api/plans/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!isValidSymbol(symbol)) return res.status(400).json({ error: 'Invalid symbol' });
  const upperSymbol = symbol.toUpperCase();
  try {
    const { error, count } = await supabase
      .from('plans')
      .delete({ count: 'exact' })
      .eq('id', upperSymbol);
    if (error) throw new Error(error.message);
    ['.json', '.md'].forEach(ext => {
      const p = path.join(plansDir, `${upperSymbol}_plan${ext}`);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    if (count === 0) return res.status(404).json({ error: `No plan found for ${upperSymbol}` });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// --- WebSocket Server Logic (Proximity stream Binance -> Client, Bybit fallback) ---

// Binance-style "1h"/"4h"/"1d" -> Bybit-style "60"/"240"/"D"
function toBybitInterval(interval) {
  const unit = interval.slice(-1);
  const num = parseInt(interval.slice(0, -1), 10);
  if (unit === 'm') return String(num);
  if (unit === 'h') return String(num * 60);
  if (unit === 'd') return num === 1 ? 'D' : String(num * 1440);
  if (unit === 'w') return 'W';
  return interval;
}

wss.on('connection', (ws) => {
  let binanceWs = null;
  let bybitWs = null;
  console.log('Client connected to WebSocket server');

  const closeUpstream = () => {
    if (binanceWs) {
      if (binanceWs.readyState === WebSocket.OPEN || binanceWs.readyState === WebSocket.CONNECTING) binanceWs.close();
      binanceWs = null;
    }
    if (bybitWs) {
      if (bybitWs.readyState === WebSocket.OPEN || bybitWs.readyState === WebSocket.CONNECTING) bybitWs.close();
      bybitWs = null;
    }
  };

  const connectBybit = (symbol, interval) => {
    console.log(`Falling back to Bybit stream: ${symbol} @ ${interval}`);
    bybitWs = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    const bybitInterval = toBybitInterval(interval);

    bybitWs.on('open', () => {
      bybitWs.send(JSON.stringify({ op: 'subscribe', args: [`kline.${bybitInterval}.${symbol}`] }));
      console.log(`Bybit stream connected: kline.${bybitInterval}.${symbol}`);
    });

    bybitWs.on('message', (raw) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        const parsed = JSON.parse(raw);
        const k = parsed.data && parsed.data[0];
        if (k) {
          const tick = {
            t: k.start,
            o: parseFloat(k.open),
            h: parseFloat(k.high),
            l: parseFloat(k.low),
            c: parseFloat(k.close),
            v: parseFloat(k.volume),
            closed: k.confirm
          };
          ws.send(JSON.stringify(tick));
        }
      } catch (err) {
        console.error(`Error processing Bybit message: ${err.message}`);
      }
    });

    bybitWs.on('error', (err) => {
      console.error(`Bybit websocket error: ${err.message}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ error: `Bybit stream error: ${err.message}` }));
      }
    });

    bybitWs.on('close', () => {
      console.log(`Bybit stream closed for ${symbol}`);
    });
  };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const symbol = (data.symbol || 'BTCUSDT').toUpperCase();
      const interval = data.interval || '1h';

      console.log(`Subscribing client to Binance stream: ${symbol} @ ${interval}`);
      closeUpstream();

      // Connect to Binance Futures WebSocket stream
      const binanceStreamUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${interval}`;
      binanceWs = new WebSocket(binanceStreamUrl);
      let binanceConnected = false;

      binanceWs.on('open', () => {
        binanceConnected = true;
        console.log(`Binance stream connected: ${binanceStreamUrl}`);
      });

      binanceWs.on('message', (binanceData) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          const parsed = JSON.parse(binanceData);
          const k = parsed.k;
          if (k) {
            // Send standard tick data to browser
            const tick = {
              t: k.t,
              o: parseFloat(k.o),
              h: parseFloat(k.h),
              l: parseFloat(k.l),
              c: parseFloat(k.c),
              v: parseFloat(k.v),
              closed: k.x
            };
            ws.send(JSON.stringify(tick));
          }
        } catch (err) {
          console.error(`Error processing Binance message: ${err.message}`);
        }
      });

      binanceWs.on('error', (err) => {
        console.error(`Binance websocket error: ${err.message}`);
        // Only fall back if we never got a working connection — otherwise
        // a mid-stream drop should just close, not double-stream from Bybit too.
        if (!binanceConnected) {
          connectBybit(symbol, interval);
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: `Binance stream error: ${err.message}` }));
        }
      });

      binanceWs.on('close', () => {
        console.log(`Binance stream closed for ${symbol}`);
      });

    } catch (err) {
      console.error(`WebSocket server logic error: ${err.message}`);
      ws.send(JSON.stringify({ error: `Invalid message format: ${err.message}` }));
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected from WebSocket');
    closeUpstream();
  });
});

// Upgrade HTTP connection to WebSockets
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/ws') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Start server
server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
