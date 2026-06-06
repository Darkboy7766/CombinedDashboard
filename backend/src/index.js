require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Ensure plans folder exists (use /tmp on Linux/Render, local path on Windows dev)
const plansDir = process.platform === 'win32'
  ? path.join(__dirname, '..', 'plans')
  : '/tmp/plans';
if (!fs.existsSync(plansDir)) {
  fs.mkdirSync(plansDir, { recursive: true });
}

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
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List all active plans
app.get('/api/plans', (req, res) => {
  try {
    const files = fs.readdirSync(plansDir);
    const plans = [];
    
    files.forEach(file => {
      if (file.endsWith('_plan.json')) {
        const filePath = path.join(plansDir, file);
        try {
          const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          plans.push({
            id: file.replace('_plan.json', ''),
            symbol: content.symbol,
            created_at: content.created_at,
            config: content.config
          });
        } catch (e) {
          console.error(`Failed to read plan file ${file}: ${e.message}`);
        }
      }
    });
    
    // Sort plans by creation date (newest first)
    plans.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json(plans);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get plan markdown report
app.get('/api/plans/:symbol/markdown', (req, res) => {
  const { symbol } = req.params;
  const filePath = path.join(plansDir, `${symbol.toUpperCase()}_plan.md`);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `Markdown report for ${symbol} not found.` });
  }
  try {
    const markdown = fs.readFileSync(filePath, 'utf-8');
    res.json({ markdown });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Monitor an active plan
app.get('/api/plans/:symbol/monitor', async (req, res) => {
  const { symbol } = req.params;
  try {
    const status = await runMonitor(symbol);
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete an active plan
app.delete('/api/plans/:symbol', (req, res) => {
  const { symbol } = req.params;
  const upperSymbol = symbol.toUpperCase();
  const jsonPath = path.join(plansDir, `${upperSymbol}_plan.json`);
  const mdPath = path.join(plansDir, `${upperSymbol}_plan.md`);
  
  let deleted = false;
  try {
    if (fs.existsSync(jsonPath)) {
      fs.unlinkSync(jsonPath);
      deleted = true;
    }
    if (fs.existsSync(mdPath)) {
      fs.unlinkSync(mdPath);
      deleted = true;
    }
    if (deleted) {
      res.json({ success: true, message: `Plan for ${upperSymbol} deleted successfully` });
    } else {
      res.status(404).json({ error: `No active plan found for ${upperSymbol}` });
    }
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
server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
