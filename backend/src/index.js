require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 5000;

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
function runBridge(command, args = []) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'python', 'bridge.py');
    const escapedArgs = args.map(arg => `"${arg.toString().replace(/"/g, '\\"')}"`).join(' ');
    const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
    const cmd = `${pythonBin} "${pythonScript}" ${command} ${escapedArgs}`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Python Exec error: ${error.message}`);
        console.error(`Stderr: ${stderr}`);
        console.error(`Stdout: ${stdout}`);
        console.error(`Exit code: ${error.code} | Signal: ${error.signal}`);
        return reject(new Error(stderr || stdout || error.message));
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
    const cmd = `${pythonBin} "${pythonScript}" "${symbol}" --json --plans-dir "${plansDir}"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`Monitor Exec error: ${error.message}`);
        return reject(new Error(stderr || error.message));
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

function proxyBinanceFutures(path, res) {
  const url = `https://fapi.binance.com${path}`;
  https.get(url, (bRes) => {
    let data = '';
    bRes.on('data', d => { data += d; });
    bRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch { res.status(502).json({ error: 'Parse error from Binance' }); }
    });
  }).on('error', (e) => res.status(502).json({ error: e.message }));
}

// --- REST Endpoints ---

// Proxy Binance statistics endpoints (blocked by CORS in browsers)
app.get('/api/binance/openInterestHist', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  proxyBinanceFutures(`/futures/data/openInterestHist?${qs}`, res);
});

app.get('/api/binance/globalLongShortAccountRatio', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  proxyBinanceFutures(`/futures/data/globalLongShortAccountRatio?${qs}`, res);
});

// Health Check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'CombinedDashboard backend is running' });
});

// Fetch Candles and EMAs
app.get('/api/klines/:symbol/:interval', async (req, res) => {
  const { symbol, interval } = req.params;
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


// --- WebSocket Server Logic (Proximity stream Binance -> Client) ---

wss.on('connection', (ws) => {
  let binanceWs = null;
  console.log('Client connected to WebSocket server');

  const closeBinanceWs = () => {
    if (binanceWs) {
      if (binanceWs.readyState === WebSocket.OPEN || binanceWs.readyState === WebSocket.CONNECTING) {
        binanceWs.close();
      }
      binanceWs = null;
    }
  };

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const symbol = (data.symbol || 'BTCUSDT').toUpperCase();
      const interval = data.interval || '1h';

      console.log(`Subscribing client to Binance stream: ${symbol} @ ${interval}`);
      closeBinanceWs();

      // Connect to Binance Futures WebSocket stream
      const binanceStreamUrl = `wss://fstream.binance.com/ws/${symbol.toLowerCase()}@kline_${interval}`;
      binanceWs = new WebSocket(binanceStreamUrl);

      binanceWs.on('open', () => {
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
        if (ws.readyState === WebSocket.OPEN) {
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
    closeBinanceWs();
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
