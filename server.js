const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;
const EXTERNAL_SERVER = 'http://127.0.0.1:3000';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const DATA_FILE = path.join(__dirname, 'data.json');
const CONFIG_FILE = path.join(__dirname, 'config.json');

// --- State and Config ---
let config = {};
try {
  config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch (e) {
  config = {
    "1": { name: "Main Entrance", maxCapacity: 200, alertThreshold: 85 },
    "2": { name: "Cafeteria", maxCapacity: 150, alertThreshold: 85 },
    "3": { name: "Library", maxCapacity: 100, alertThreshold: 85 }
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

let appData = {
  history: {},       // { "YYYY-MM-DD": { "HH": uniqueCount } }
  flows: {},         // { "NodeX->NodeY": count }
  dwell: {},         // { mac: { node: '1', firstSeen: ts, lastSeen: ts } }
  deviceHistory: {}  // { mac: { node: '1', lastSeen: ts } }
};

try {
  if (fs.existsSync(DATA_FILE)) {
    const rawData = fs.readFileSync(DATA_FILE, 'utf8');
    if (rawData) {
      const parsed = JSON.parse(rawData);
      if (parsed) Object.assign(appData, parsed);
    }
  }
} catch (e) {
  console.error("Error loading data.json", e.message);
}

// Persist data every 60 seconds
setInterval(() => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(appData));
  } catch (e) {
    console.error("Error saving data.json", e.message);
  }
}, 60000);

let lastRawData = [];
let backendUp = false;
let externalLatency = 0;

// --- Data Polling ---
async function fetchBackendData() {
  const start = Date.now();
  try {
    const fetchMod = globalThis.fetch ? globalThis.fetch : (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    
    // We expect the ESP32 backend at /devices or root, adjust if needed
    const res = await fetchMod(`${EXTERNAL_SERVER}/api/devices`);
    if (res.ok) {
      lastRawData = await res.json();
      backendUp = true;
      externalLatency = Date.now() - start;
      processNewData(lastRawData);
    } else {
      throw new Error(`Status ${res.status}`);
    }
  } catch (err) {
    backendUp = false;
    externalLatency = Date.now() - start;
    lastRawData = []; // Clear raw data if backend is down
    processNewData(lastRawData);
  }
}

function processNewData(devices) {
  const nowObj = new Date();
  const now = nowObj.getTime();
  const dateStr = nowObj.toISOString().split('T')[0];
  const minKey = `${nowObj.getHours().toString().padStart(2, '0')}:${nowObj.getMinutes().toString().padStart(2, '0')}`;
  
  if (!appData.minuteHistory) appData.minuteHistory = {};
  if (!appData.minuteHistory[dateStr]) appData.minuteHistory[dateStr] = {};
  
  const uniqueMacs = new Set();
  
  devices.forEach(d => {
    uniqueMacs.add(d.mac_address);
    const nodeStr = String(d.node);
    
    // Process Dwell Time
    if (!appData.dwell[d.mac_address]) {
      appData.dwell[d.mac_address] = { node: nodeStr, firstSeen: now, lastSeen: now };
    } else {
      let dRecord = appData.dwell[d.mac_address];
      if (dRecord.node === nodeStr) {
        dRecord.lastSeen = now;
      } else {
        dRecord = { node: nodeStr, firstSeen: now, lastSeen: now };
        appData.dwell[d.mac_address] = dRecord;
      }
    }
    
    // Process Flows
    if (appData.deviceHistory[d.mac_address]) {
      const hist = appData.deviceHistory[d.mac_address];
      if (hist.node !== nodeStr && (now - hist.lastSeen) <= 30000) {
        const flowKey = `${hist.node}->${nodeStr}`;
        if (!Array.isArray(appData.flows[flowKey])) appData.flows[flowKey] = [];
        appData.flows[flowKey].push(now);
      }
    }
    
    appData.deviceHistory[d.mac_address] = { node: nodeStr, lastSeen: now };
  });

  // Track max unique per minute
  const currentMinCount = appData.minuteHistory[dateStr][minKey] || 0;
  if (uniqueMacs.size > currentMinCount) {
    appData.minuteHistory[dateStr][minKey] = uniqueMacs.size;
  }
}



// Poll every 5s
setInterval(fetchBackendData, 5000);

// --- API Routes ---
app.get('/api/health', (req, res) => {
  res.json({
    status: backendUp ? 'ok' : 'degraded',
    uptime: process.uptime(),
    timestamp: Date.now(),
    latency: externalLatency
  });
});

app.get('/api/occupancy', (req, res) => {
  const counts = { "1": 0, "2": 0, "3": 0 };
  const uniqueTotal = new Set();
  
  lastRawData.forEach(d => {
    const n = String(d.node);
    counts[n] = (counts[n] || 0) + 1;
    uniqueTotal.add(d.mac_address);
  });
  
  const zones = ["1", "2", "3"].map(id => {
    const count = counts[id] || 0;
    const capacity = config[id]?.maxCapacity || 100;
    return {
      nodeId: id,
      name: config[id]?.name || `Zone ${id}`,
      count: count,
      capacity: capacity,
      occupancyPercent: Math.min((count / capacity) * 100, 100).toFixed(1),
      alertThreshold: config[id]?.alertThreshold || 85,
      updatedAt: Date.now()
    };
  });
  
  res.json({ uniqueTotal: uniqueTotal.size, zones });
});

app.get('/api/devices/:nodeId', (req, res) => {
  const nodeId = String(req.params.nodeId);
  const filtered = lastRawData.filter(d => String(d.node) === nodeId);
  
  const enriched = filtered.map(d => {
    const dwellRec = appData.dwell[d.mac_address];
    return {
      ...d,
      firstSeen: dwellRec ? dwellRec.firstSeen : Date.now()
    };
  });
  res.json(enriched);
});

app.get('/api/history', (req, res) => {
  const labels = [];
  const data = [];
  const now = new Date();
  const uniqueTotal = new Set(lastRawData.map(d => d.mac_address)).size;
  
  for (let i = 59; i >= 0; i--) {
     const t = new Date(now.getTime() - i * 60000);
     const dStr = t.toISOString().split('T')[0];
     const mStr = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`;
     
     labels.push(mStr);
     
     let val = (appData.minuteHistory && appData.minuteHistory[dStr] && appData.minuteHistory[dStr][mStr]) 
               ? appData.minuteHistory[dStr][mStr] : 0;
               
     if (i === 0 && uniqueTotal > val) {
         val = uniqueTotal;
     }
     data.push(val);
  }
  
  res.json({ labels, data });
});

app.get('/api/flows', (req, res) => {
  const now = Date.now();
  const recentFlows = {};
  
  Object.keys(appData.flows).forEach(key => {
     // Filter out timestamps older than 60 seconds
     if (Array.isArray(appData.flows[key])) {
         appData.flows[key] = appData.flows[key].filter(ts => now - ts < 60000);
         if (appData.flows[key].length > 0) {
             recentFlows[key] = appData.flows[key].length;
         }
     }
  });
  
  res.json(recentFlows);
});

app.get('/api/dwell', (req, res) => {
  const nodeStats = { "1": [], "2": [], "3": [] };
  const now = Date.now();
  
  Object.values(appData.dwell).forEach(rec => {
    if (rec && nodeStats[rec.node] && (now - rec.lastSeen < 600000)) { // consider active in last 10 mins
      nodeStats[rec.node].push(rec);
    }
  });

  const result = [];
  ["1", "2", "3"].forEach(id => {
    const list = nodeStats[id] || [];
    let resident = 0, transit = 0;
    let totalDwellTime = 0;
    
    list.forEach(r => {
      const dwellMin = (r.lastSeen - r.firstSeen) / 60000;
      totalDwellTime += dwellMin;
      if (dwellMin >= 2) resident++;
      else transit++;
    });
    
    let avgDwellMin = list.length ? (totalDwellTime / list.length) : 0;
    
    result.push({
      nodeId: id,
      name: config[id]?.name || `Zone ${id}`,
      avgDwellMin: avgDwellMin.toFixed(1),
      transit,
      resident
    });
  });
  
  res.json(result);
});

app.post('/api/config', (req, res) => {
  config = req.body;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  res.json({status: "ok"});
});


app.listen(PORT, () => {
  console.log(`Campus Dashboard running at http://localhost:${PORT}`);
});
