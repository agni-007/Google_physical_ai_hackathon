from flask import Flask, request, jsonify, render_template_string
import math
import time

app = Flask(__name__)

# --- CONFIGURATION ---
PORT = 3000
TX_POWER = -59  # Calibrated RSSI at 1 meter
N_FACTOR = 2.0  # Environmental constant (2.0 = open space)

# --- DATA STORAGE ---
recent_detections = []
unique_macs = set()

def estimate_distance(rssi):
    """Calculates distance in meters using the Log-Distance Path Loss Model"""
    try:
        return round(10**((TX_POWER - rssi) / (10 * N_FACTOR)), 2)
    except:
        return 0.0

# --- DASHBOARD UI ---
HTML_TEMPLATE = """
<!DOCTYPE html>
<html>
<head>
    <title>Rescue Scout HQ</title>
    <meta http-equiv="refresh" content="2">
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0a0a0a; color: #00ffcc; padding: 20px; }
        .stat-bar { background: #1a1a1a; padding: 15px; border-radius: 8px; margin-bottom: 20px; display: flex; gap: 20px; }
        .stat-item { color: white; font-size: 1.2em; }
        .stat-value { color: #00ffcc; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; background: #111; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #222; }
        th { background: #1f1f1f; color: white; }
        .new-device { color: #ffcc00; font-weight: bold; }
    </style>
</head>
<body>
    <h1>📡 RESCUE SCOUT LIVE FEED</h1>
    <div class="stat-bar">
        <div class="stat-item">Unique Humans/Devices Found: <span class="stat-value">{{ unique_count }}</span></div>
        <div class="stat-item">Server Status: <span class="stat-value" style="color:#00ff00">ONLINE</span></div>
    </div>
    <table>
        <tr><th>NODE</th><th>MAC ADDRESS</th><th>SIGNAL</th><th>EST. DISTANCE</th></tr>
        {% for item in detections %}
        <tr>
            <td>{{ item.node_id }}</td>
            <td>{{ item.mac }}</td>
            <td>{{ item.rssi }} dBm</td>
            <td style="color:#ffcc00">{{ item.distance }}m</td>
        </tr>
        {% endfor %}
    </table>
</body>
</html>
"""

@app.route('/')
def dashboard():
    return render_template_string(HTML_TEMPLATE, 
                                 detections=reversed(recent_detections[-15:]), 
                                 unique_count=len(unique_macs))

@app.route('/data', methods=['POST'])
def receive_data():
    content = request.json
    mac = content['mac']
    
    # Check if this is a first-time discovery
    is_new = mac not in unique_macs
    if is_new:
        unique_macs.add(mac)
        print(f"\n[NEW DISCOVERY] MAC: {mac} | Total: {len(unique_macs)}")

    # Calculate Distance
    content['distance'] = estimate_distance(content['rssi'])
    content['timestamp'] = time.time()
    recent_detections.append(content)

    # Standard Terminal Log
    print(f"Scout {content['node_id']} caught {mac} at {content['distance']}m")
    
    return jsonify({"status": "received"}), 200

@app.route('/api/devices', methods=['GET'])
def api_devices():
    formatted = []
    # Deduplicate and only return devices seen in the last 15 seconds
    current_time = time.time()
    active_devices = {}
    
    for d in recent_detections:
        # Check if timestamps exist (fallback to 0 for old data before reboot)
        ts = d.get('timestamp', 0)
        if current_time - ts <= 15:
            mac = d.get("mac", "")
            rssi = d.get("rssi", -100)
            # Update dictionary so we only assign the device to the node with the STRONGEST signal
            if mac not in active_devices or rssi > active_devices[mac]["signal_dbm"]:
                active_devices[mac] = {
                    "node": d.get("node_id", 1),
                    "mac_address": mac,
                    "signal_dbm": rssi,
                    "est_distance_m": d.get("distance", 0.0)
                }
            
    for item in active_devices.values():
        formatted.append(item)
        
    return jsonify(formatted)

if __name__ == '__main__':
    print(f"\nCOMMAND CENTER ACTIVE\nLocalhost: http://localhost:{PORT}")
    app.run(host='0.0.0.0', port=PORT)