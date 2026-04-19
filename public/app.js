// Themes & Config
const THEME = {
  green: '#2ecc71',
  amber: '#f39c12',
  orange: '#e67e22',
  red: '#e74c3c',
  purple: '#7c6af7'
};

// Global State
let zoneConfig = {};
let hourlyChartInstance = null;
let dwellChartInstance = null;
let activeAlerts = new Set();
let audioContext = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initCharts();
  fetchOccupancy();
  fetchHealth();
  fetchHistory();
  fetchDwell();
  fetchFlows();

  setInterval(fetchOccupancy, 5000);
  setInterval(fetchHealth, 5000);
  setInterval(fetchHistory, 5000);
  setInterval(fetchDwell, 5000);
  setInterval(fetchFlows, 30000);
  
  // Track 5-min rolling average locally (simplified, stores history per zone)
  setInterval(checkAnomalies, 5000);
});

// Sound Alert
function playAlertBeep() {
  if (!audioContext) {
    try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); }
    catch(e) { return; }
  }
  if(audioContext.state === 'suspended') audioContext.resume();
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(800, audioContext.currentTime);
  osc.frequency.exponentialRampToValueAtTime(400, audioContext.currentTime + 0.1);
  gain.gain.setValueAtTime(0.1, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.1);
  osc.connect(gain);
  gain.connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.1);
}

// ----------------------------------------------------
// Section: Heatmap (Occupancy)
// ----------------------------------------------------
function getColor(percent) {
  if (percent < 40) return THEME.green;
  if (percent < 70) return THEME.amber;
  if (percent < 85) return THEME.orange;
  return THEME.red;
}

const rollingHistory = {}; // { nodeId: [counts...] }

async function fetchOccupancy() {
  try {
    const res = await fetch('/api/occupancy');
    const data = await res.json();
    
    document.getElementById('total-devices').innerText = data.uniqueTotal;
    
    // Sort logic for most/least
    const sorted = [...data.zones].sort((a,b) => b.count - a.count);
    if(sorted.length > 0) {
      document.getElementById('most-crowded').innerText = `${sorted[0].name} (${sorted[0].occupancyPercent}%)`;
      document.getElementById('least-crowded').innerText = `${sorted[sorted.length-1].name} (${sorted[sorted.length-1].occupancyPercent}%)`;
    }

    renderHeatmap(data.zones);
    updateRollingHistory(data.zones);
    
    // Save locally for settings
    data.zones.forEach(z => {
      zoneConfig[z.nodeId] = { name: z.name, maxCapacity: z.capacity, alertThreshold: z.alertThreshold };
    });
    
  } catch (err) {
    console.error("Failed to fetch occupancy", err);
  }
}

function renderHeatmap(zones) {
  const container = document.getElementById('zone-cards');
  zones.forEach(z => {
    let card = document.getElementById(`zone-card-${z.nodeId}`);
    const color = getColor(z.occupancyPercent);
    if (!card) {
      card = document.createElement('div');
      card.className = 'zone-card';
      card.id = `zone-card-${z.nodeId}`;
      card.onclick = () => openPanel(z.nodeId, z.name);
      container.appendChild(card);
    }
    
    card.style.backgroundColor = color;
    card.innerHTML = `
      <div>
        <h4>${z.name}</h4>
        <div class="node-label">Node ${z.nodeId}</div>
        <div class="live-count">${z.count}</div>
      </div>
      <div>
        <div style="font-size: 0.85rem; font-weight: bold;">${z.occupancyPercent}% capacity</div>
        <div class="last-updated">
          <span class="pulse-dot active"></span> Just now
        </div>
        <div class="gear" onclick="event.stopPropagation(); openSettings()">⚙️</div>
      </div>
    `;
    
    // reset pulse
    setTimeout(() => {
      const dot = card.querySelector('.pulse-dot');
      if(dot) { dot.classList.remove('active'); dot.nextSibling.textContent = ' 5s ago'; }
    }, 1000);
  });
}

// ----------------------------------------------------
// Alerts & Anomalies
// ----------------------------------------------------
function updateRollingHistory(zones) {
  zones.forEach(z => {
    if (!rollingHistory[z.nodeId]) rollingHistory[z.nodeId] = [];
    rollingHistory[z.nodeId].push(z.count);
    if (rollingHistory[z.nodeId].length > 60) { // 60 * 5s = 5 mins
      rollingHistory[z.nodeId].shift();
    }
  });
}

function checkAnomalies() {
  const hr = new Date().getHours();
  let totalAcrossZones = 0;
  
  Object.keys(rollingHistory).forEach(nodeId => {
    const list = rollingHistory[nodeId];
    if (list.length === 0) return;
    
    const count = list[list.length - 1];
    totalAcrossZones += count;
    
    if (list.length > 20) { // need enough data points
      const avg = list.slice(0, list.length-1).reduce((a,b)=>a+b, 0) / (list.length-1);
      if (avg > 10 && count > avg * 1.4) {
        triggerAlert(nodeId, 'HIGH CROWD SURGE', `Count spiked 40%+ above 5m avg (${Math.round(avg)} -> ${count})`, 'high');
      }
    }
  });

  if ((hr >= 23 || hr < 6) && totalAcrossZones > 0) {
    triggerAlert('all', 'OFF-HOURS DETECTION', `${totalAcrossZones} devices detected after hours.`, 'warn');
  }

  if (hr >= 8 && hr < 20 && totalAcrossZones === 0) {
    triggerAlert('all', 'SYSTEM OFFLINE WARNING', `0 devices detected during peak hours.`, 'warn');
  }
}

function triggerAlert(id, title, desc, level) {
  const alertKey = `${id}-${title}`;
  if (activeAlerts.has(alertKey)) return;
  activeAlerts.add(alertKey);

  if(level === 'high') playAlertBeep();

  const container = document.getElementById('alerts-container');
  const d = document.createElement('div');
  d.className = `toast ${level}`;
  d.innerHTML = `
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-desc">${desc}</div>
      <div class="toast-time">${new Date().toLocaleTimeString()}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove(); activeAlerts.delete('${alertKey}')">×</button>
  `;
  container.appendChild(d);
  
  setTimeout(() => {
    if (d.parentElement) {
      d.remove();
      activeAlerts.delete(alertKey);
    }
  }, 10000); 
}

// ----------------------------------------------------
// Health
// ----------------------------------------------------
async function fetchHealth() {
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    const bdg = document.getElementById('system-status');
    bdg.textContent = d.status.toUpperCase();
    bdg.className = `status-badge ${d.status}`;
    document.getElementById('ping-latency').innerText = `Ping: ${d.latency}ms`;
  } catch(e) {
    const bdg = document.getElementById('system-status');
    bdg.textContent = 'OFFLINE';
    bdg.className = 'status-badge offline';
  }
}

// ----------------------------------------------------
// Charts - Init
// ----------------------------------------------------
function initCharts() {
  Chart.defaults.color = '#a0a0b8';
  Chart.defaults.font.family = 'Inter';

  // Hourly Line Chart
  const ctxHour = document.getElementById('hourlyChart').getContext('2d');
  hourlyChartInstance = new Chart(ctxHour, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Unique Devices',
        data: [],
        borderColor: THEME.purple,
        backgroundColor: 'rgba(124, 106, 247, 0.15)',
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true }
      }
    }
  });

  // Dwell Bar Chart
  const ctxDwell = document.getElementById('dwellChart').getContext('2d');
  dwellChartInstance = new Chart(ctxDwell, {
    type: 'bar',
    data: {
      labels: [],
      datasets: [{
        label: 'Avg Dwell (min)',
        data: [],
        backgroundColor: []
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, beginAtZero: true },
        y: { grid: { display: false } }
      }
    }
  });
}

// Update Hourly
async function fetchHistory() {
  try {
    const r = await fetch('/api/history');
    const d = await r.json();
    hourlyChartInstance.data.labels = d.labels;
    hourlyChartInstance.data.datasets[0].data = d.data;
    hourlyChartInstance.update('none');
  } catch(e) {}
}

// Update Dwell
async function fetchDwell() {
  try {
    const r = await fetch('/api/dwell');
    const d = await r.json();
    
    dwellChartInstance.data.labels = d.map(x => x.name);
    dwellChartInstance.data.datasets[0].data = d.map(x => parseFloat(x.avgDwellMin));
    // Dynamic color based on dwell (short = green, long = red)
    dwellChartInstance.data.datasets[0].backgroundColor = d.map(x => {
        const val = parseFloat(x.avgDwellMin);
        if (val < 2) return THEME.green;
        if (val < 5) return THEME.amber;
        return THEME.red;
    });
    dwellChartInstance.update('none');
  } catch(e) {}
}

// Update Flows (Sankey)
async function fetchFlows() {
  try {
    const r = await fetch('/api/flows');
    const flows = await r.json();
    renderSankey(flows);
  } catch(e) {}
}

function renderSankey(flows) {
  const svgContainer = document.getElementById('sankey-diagram');
  svgContainer.innerHTML = '';
  
  const nodesMap = {};
  const links = [];
  
  let totalMoved = 0;
  let moveText = [];

  Object.entries(flows).forEach(([key, count]) => {
    if (count === 0) return;
    const [source, target] = key.split('->');
    const sName = zoneConfig[source] ? zoneConfig[source].name : `Z${source}`;
    const tName = zoneConfig[target] ? zoneConfig[target].name : `Z${target}`;
    if (!nodesMap[sName]) nodesMap[sName] = Object.keys(nodesMap).length;
    if (!nodesMap[tName]) nodesMap[tName] = Object.keys(nodesMap).length;
    
    links.push({
      source: nodesMap[sName],
      target: nodesMap[tName],
      value: count
    });
    totalMoved += count;
    moveText.push(`${count} moved ${sName} → ${tName}`);
  });

  const summary = document.getElementById('flow-summary');
  if (links.length === 0) {
    summary.innerText = "No movement detected in the last 30s.";
    return;
  }
  summary.innerText = `In the last 30s: ${moveText.join(', ')}`;

  const width = svgContainer.clientWidth || 300;
  const height = svgContainer.clientHeight || 200;

  const nodes = Object.keys(nodesMap).map(id => ({ name: id }));
  
  const sankey = d3.sankey()
    .nodeWidth(15)
    .nodePadding(10)
    .extent([[1, 1], [width - 1, height - 6]]);

  const { nodes: graphNodes, links: graphLinks } = sankey({
    nodes: nodes.map(d => Object.assign({}, d)),
    links: links.map(d => Object.assign({}, d))
  });

  const svg = d3.select("#sankey-diagram").append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width} ${height}`);

  svg.append("g")
    .selectAll("rect")
    .data(graphNodes)
    .join("rect")
      .attr("x", d => d.x0)
      .attr("y", d => d.y0)
      .attr("height", d => d.y1 - d.y0)
      .attr("width", d => d.x1 - d.x0)
      .attr("fill", THEME.purple)
      .attr("opacity", 0.8)
    .append("title")
      .text(d => `${d.name}\n${d.value}`);

  svg.append("g")
    .attr("fill", "none")
    .attr("stroke", "rgba(255,255,255,0.2)")
    .attr("stroke-opacity", 0.5)
    .selectAll("path")
    .data(graphLinks)
    .join("path")
      .attr("d", d3.sankeyLinkHorizontal())
      .attr("stroke-width", d => Math.max(1, d.width))
    .append("title")
      .text(d => `${d.source.name} → ${d.target.name}\n${d.value}`);

  svg.append("g")
    .attr("font-family", "Inter, sans-serif")
    .attr("font-size", 10)
    .attr("fill", "#fff")
    .selectAll("text")
    .data(graphNodes)
    .join("text")
      .attr("x", d => d.x0 < width / 2 ? d.x1 + 6 : d.x0 - 6)
      .attr("y", d => (d.y1 + d.y0) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", d => d.x0 < width / 2 ? "start" : "end")
      .text(d => d.name);
}

// ----------------------------------------------------
// Panel & Settings
// ----------------------------------------------------
async function openPanel(nodeId, name) {
  document.getElementById('panel-title').innerText = `Devices in ${name}`;
  document.getElementById('side-panel').classList.add('open');
  const tbody = document.getElementById('device-list');
  tbody.innerHTML = '<tr><td colspan="4">Loading...</td></tr>';
  try {
    const r = await fetch(`/api/devices/${nodeId}`);
    const data = await r.json();
    tbody.innerHTML = '';
    const now = Date.now();
    data.forEach(d => {
      const dwellMins = ((now - d.firstSeen) / 60000).toFixed(1);
      tbody.innerHTML += `
        <tr>
          <td class="mac">${d.mac_address}</td>
          <td>${d.signal_dbm}</td>
          <td>${d.est_distance_m}</td>
          <td>${dwellMins} min</td>
        </tr>
      `;
    });
  } catch(e) {
    tbody.innerHTML = '<tr><td colspan="4">Error loading devices</td></tr>';
  }
}
function closePanel() {
  document.getElementById('side-panel').classList.remove('open');
}

function openSettings() {
  const m = document.getElementById('settings-modal');
  const cont = document.getElementById('zone-configs');
  cont.innerHTML = '';
  ['1', '2', '3'].forEach(id => {
    const c = zoneConfig[id] || {name: `Zone ${id}`, maxCapacity: 100, alertThreshold: 85};
    cont.innerHTML += `
      <div class="zone-cfg-group">
        <h4>Node ${id} Configuration</h4>
        <label>Name</label>
        <input type="text" id="cfg-name-${id}" value="${c.name}" />
        <label>Max Capacity</label>
        <input type="number" id="cfg-cap-${id}" value="${c.maxCapacity}" />
      </div>
    `;
  });
  m.classList.add('active');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('active');
}

async function saveConfig() {
  const newConf = {};
  ['1', '2', '3'].forEach(id => {
    newConf[id] = {
      name: document.getElementById(`cfg-name-${id}`).value,
      maxCapacity: parseInt(document.getElementById(`cfg-cap-${id}`).value) || 100,
      alertThreshold: 85
    };
  });
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(newConf)
    });
    closeSettings();
    fetchOccupancy(); // force refresh UI
  } catch(e) {
    alert('Failed to save configuration');
  }
}
