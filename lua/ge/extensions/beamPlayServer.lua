-- BeamPlay phone companion server.
--
-- A tiny, non-blocking local HTTP server so a phone on the same WiFi
-- network can open a CarPlay-styled read-only mirror of the in-game
-- BeamPlay UI app in its browser. Structure and networking approach
-- (LuaSocket, poll-driven accept/receive loop wired to onUpdate, manual
-- HTTP/1.1 responses) follow the same pattern used by another published
-- BeamNG UI-app mod's local web endpoint feature.
--
-- Data flow: the BeamPlay UI app (app.js) computes and formats all
-- telemetry client-side (as it already does for the in-game widget) and
-- pushes a JSON snapshot into M.setData() via bngApi.engineLua(). This
-- module just stores that string and serves it back out over HTTP -- it
-- does no telemetry reading or formatting of its own. The one thing that
-- flows the other way is a tiny command queue (currently just
-- "reset-trip"), so a phone button tap can trigger an in-game action.

local M = {}

local socket = require('socket.socket')
local json = require('json')

local server = nil
local clients = {}
local running = false
local dataStr = '{}'
local defaultPort = 23515
local listenPort = defaultPort
local pendingCommand = nil

local stop -- forward declaration

local function detectLanIp()
  local ok, dns = pcall(require, 'socket.dns')
  if not ok or not dns then return nil end
  local hostOk, hostname = pcall(dns.gethostname)
  if not hostOk or type(hostname) ~= 'string' then return nil end
  local ipOk, ip = pcall(dns.toip, hostname)
  if not ipOk or type(ip) ~= 'string' then return nil end
  if ip == '127.0.0.1' or ip:match('^169%.254%.') then return nil end
  return ip
end

-- Self-contained companion page: no external CSS/JS files, so this one
-- HTTP response is everything a phone browser needs. Polls /data.json
-- once a second and renders it CarPlay-style; the radio tab plays its
-- own independent Web Audio synth locally on the phone (station
-- definitions come from the polled JSON, so there is nothing to keep in
-- sync by hand).
local companionHtml = [====[
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>BeamPlay</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #060b12; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #f0f4f8;
    background: linear-gradient(180deg, #0c1622 0%, #060b12 100%);
    min-height: 100%;
    display: flex;
    flex-direction: column;
  }
  .statusbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; font-size: 15px; font-weight: 600;
    background: rgba(0,0,0,0.25); border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .dot { color: #6a7686; }
  .dot.on { color: #33e07a; }
  .conn { font-size: 11px; opacity: 0.6; }
  .screen { flex: 1; padding: 20px; display: none; }
  .screen.active { display: block; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
  .icon { display: flex; flex-direction: column; align-items: center; }
  .icon-glyph {
    width: 100%; aspect-ratio: 1/1; display: flex; align-items: center; justify-content: center;
    border-radius: 22%; font-size: 32px; font-weight: 700;
    background: linear-gradient(145deg, #1c2b3f, #101a28);
    box-shadow: 0 4px 10px rgba(0,0,0,0.35);
  }
  .icon-label { margin-top: 8px; font-size: 13px; opacity: 0.9; }
  .back { font-size: 14px; opacity: 0.75; margin-bottom: 16px; }
  .speed-big { font-size: 72px; font-weight: 800; text-align: center; margin-top: 10px; }
  .speed-unit { font-size: 20px; font-weight: 600; opacity: 0.7; margin-left: 6px; }
  .gear { text-align: center; font-size: 24px; font-weight: 700; margin: 8px 0 20px; opacity: 0.85; }
  .rpm-bar { height: 12px; border-radius: 999px; background: rgba(255,255,255,0.1); overflow: hidden; }
  .rpm-fill { height: 100%; background: linear-gradient(90deg, #2fbf71, #e0d02f); }
  .rpm-fill.redline { background: #ff3b30; }
  .mini-row { display: flex; gap: 12px; margin-top: 24px; }
  .mini-stat { flex: 1; text-align: center; padding: 14px 8px; border-radius: 12px; background: rgba(255,255,255,0.06); }
  .mini-label { font-size: 12px; opacity: 0.65; }
  .mini-value { font-size: 20px; font-weight: 700; margin-top: 4px; }
  .row { display: flex; justify-content: space-between; padding: 12px 4px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 16px; }
  .row .label { opacity: 0.7; }
  .row .value { font-weight: 700; }
  .btn { margin-top: 20px; width: 100%; padding: 14px; border: none; border-radius: 12px; background: #2f6fed; color: #fff; font-weight: 700; font-size: 16px; }
  .status-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px; }
  .status-cell { text-align: center; padding: 18px 8px; border-radius: 12px; background: rgba(255,255,255,0.05); font-size: 13px; opacity: 0.6; }
  .status-cell.on { opacity: 1; background: rgba(51,224,122,0.16); }
  .status-glyph { font-size: 26px; margin-bottom: 6px; }
  .status-val { margin-top: 6px; font-weight: 700; }
  .radio-station { text-align: center; font-size: 22px; font-weight: 700; margin: 24px 0 20px; }
  .radio-controls { display: flex; align-items: center; justify-content: center; gap: 22px; }
  .round { width: 60px; height: 60px; border-radius: 50%; font-size: 20px; border: none; background: rgba(255,255,255,0.1); color: #fff; }
  .play { width: 74px; height: 74px; font-size: 26px; background: #2fbf71; }
  .hint { margin-top: 22px; font-size: 12px; opacity: 0.5; text-align: center; }
</style>
</head>
<body>
  <div class="statusbar">
    <span id="clock">--:--</span>
    <span><span class="dot" id="engineDot">&#9679;</span></span>
    <span class="conn" id="connStatus">connecting&hellip;</span>
  </div>

  <div class="screen active" data-screen="home">
    <div class="grid">
      <div class="icon" onclick="showScreen('dash')">
        <div class="icon-glyph" id="homeSpeed">0</div>
        <div class="icon-label">Dashboard</div>
      </div>
      <div class="icon" onclick="showScreen('trip')">
        <div class="icon-glyph">&#128506;</div>
        <div class="icon-label">Trip</div>
      </div>
      <div class="icon" onclick="showScreen('status')">
        <div class="icon-glyph">&#9888;</div>
        <div class="icon-label">Status</div>
      </div>
      <div class="icon" onclick="showScreen('radio')">
        <div class="icon-glyph">&#9834;</div>
        <div class="icon-label">BeamPlay Radio</div>
      </div>
    </div>
  </div>

  <div class="screen" data-screen="dash">
    <div class="back" onclick="showScreen('home')">&lsaquo; Home</div>
    <div class="speed-big"><span id="speedValue">0</span><span class="speed-unit" id="speedUnit">km/h</span></div>
    <div class="gear" id="gearText">N</div>
    <div class="rpm-bar"><div class="rpm-fill" id="rpmFill" style="width:0%"></div></div>
    <div class="mini-row">
      <div class="mini-stat"><div class="mini-label">Fuel</div><div class="mini-value" id="fuelPctText">--</div></div>
      <div class="mini-stat"><div class="mini-label">Water</div><div class="mini-value" id="waterTempText">--</div></div>
      <div class="mini-stat"><div class="mini-label">Oil</div><div class="mini-value" id="oilTempText">--</div></div>
    </div>
  </div>

  <div class="screen" data-screen="trip">
    <div class="back" onclick="showScreen('home')">&lsaquo; Home</div>
    <div class="row"><span class="label">Distance</span><span class="value" id="tripDistanceText">--</span></div>
    <div class="row"><span class="label">Duration</span><span class="value" id="tripDurationText">--</span></div>
    <div class="row"><span class="label">Average speed</span><span class="value" id="tripAvgSpeedText">--</span></div>
    <div class="row"><span class="label">Top speed</span><span class="value" id="topSpeedText">--</span></div>
    <button class="btn" onclick="sendCommand('reset-trip')">Reset trip</button>
  </div>

  <div class="screen" data-screen="status">
    <div class="back" onclick="showScreen('home')">&lsaquo; Home</div>
    <div class="status-grid">
      <div class="status-cell" id="cell-lowbeam"><div class="status-glyph">&#9788;</div><div>Low beam</div><div class="status-val" id="val-lowbeam">n/a</div></div>
      <div class="status-cell" id="cell-highbeam"><div class="status-glyph">&#9728;</div><div>High beam</div><div class="status-val" id="val-highbeam">n/a</div></div>
      <div class="status-cell" id="cell-hazard"><div class="status-glyph">&#9650;</div><div>Hazards</div><div class="status-val" id="val-hazard">n/a</div></div>
      <div class="status-cell" id="cell-parkingBrake"><div class="status-glyph">P</div><div>Parking brake</div><div class="status-val" id="val-parkingBrake">n/a</div></div>
    </div>
  </div>

  <div class="screen" data-screen="radio">
    <div class="back" onclick="showScreen('home')">&lsaquo; Home</div>
    <div class="radio-station" id="radioStationName">&mdash;</div>
    <div class="radio-controls">
      <button class="round" onclick="changeStation(-1)">&#9198;</button>
      <button class="round play" id="playBtn" onclick="toggleRadio()">&#9654;</button>
      <button class="round" onclick="changeStation(1)">&#9197;</button>
    </div>
    <div class="hint">Plays locally on this phone &mdash; independent synth audio, not streamed from the PC.</div>
  </div>

<script>
(function () {
  'use strict';

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-screen') === name);
    });
  }
  window.showScreen = showScreen;

  function sendCommand(name) {
    fetch('/command/' + name).catch(function () {});
  }
  window.sendCommand = sendCommand;

  function tickClock() {
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    document.getElementById('clock').textContent = pad(h) + ':' + pad(m);
  }
  tickClock();
  setInterval(tickClock, 1000);

  var lastData = null;

  function setStatusCell(key, label) {
    var val = lastData && lastData.status ? lastData.status[key] : null;
    var cell = document.getElementById('cell-' + key);
    var valEl = document.getElementById('val-' + key);
    if (!cell || !valEl) return;
    cell.classList.toggle('on', val === true);
    valEl.textContent = val === null || typeof val === 'undefined' ? 'n/a' : (val ? 'ON' : 'off');
  }

  function render(data) {
    lastData = data;
    document.getElementById('engineDot').classList.toggle('on', !!data.engineOn);
    document.getElementById('connStatus').textContent = 'connected';

    document.getElementById('homeSpeed').textContent = data.speedValue;
    document.getElementById('speedValue').textContent = data.speedValue;
    document.getElementById('speedUnit').textContent = data.speedUnit;
    document.getElementById('gearText').textContent = data.gearText;
    var fill = document.getElementById('rpmFill');
    fill.style.width = Math.max(0, Math.min(100, data.rpmPct || 0)) + '%';
    fill.classList.toggle('redline', !!data.nearRedline);

    document.getElementById('fuelPctText').textContent = data.fuelPctText;
    document.getElementById('waterTempText').textContent = data.waterTempText;
    document.getElementById('oilTempText').textContent = data.oilTempText;

    document.getElementById('tripDistanceText').textContent = data.tripDistanceText;
    document.getElementById('tripDurationText').textContent = data.tripDurationText;
    document.getElementById('tripAvgSpeedText').textContent = data.tripAvgSpeedText;
    document.getElementById('topSpeedText').textContent = data.topSpeedText;

    setStatusCell('lowbeam');
    setStatusCell('highbeam');
    setStatusCell('hazard');
    setStatusCell('parkingBrake');

    if (Array.isArray(data.stations) && data.stations.length && !stations.length) {
      stations = data.stations;
      renderStationName();
    }
  }

  function poll() {
    fetch('/data.json').then(function (r) { return r.json(); }).then(render).catch(function () {
      document.getElementById('connStatus').textContent = 'disconnected';
    });
  }
  poll();
  setInterval(poll, 1000);

  // --- Independent local radio (Web Audio synth, no streaming from the PC) ---
  var stations = [];
  var stationIndex = 0;
  var playing = false;
  var audioCtx = null;
  var masterGain = null;
  var stepTimer = null;
  var stepCount = 0;

  function renderStationName() {
    var el = document.getElementById('radioStationName');
    if (el && stations[stationIndex]) el.textContent = stations[stationIndex].name;
  }

  function noteFrequency(baseFreq, semis) {
    return baseFreq * Math.pow(2, semis / 12);
  }

  function ensureAudio() {
    if (audioCtx) return audioCtx;
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.6;
    masterGain.connect(audioCtx.destination);
    return audioCtx;
  }

  function playStep(station) {
    var ctx = ensureAudio();
    if (!ctx) return;
    var semis = station.notes[stepCount % station.notes.length];
    var freq = noteFrequency(station.baseFreq, semis);
    var osc = ctx.createOscillator();
    var gainNode = ctx.createGain();
    osc.type = station.wave;
    osc.frequency.value = freq;
    gainNode.gain.value = station.gain;
    osc.connect(gainNode);
    gainNode.connect(masterGain);
    var now = ctx.currentTime;
    osc.start(now);
    gainNode.gain.setValueAtTime(station.gain, now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + station.tempoMs / 1000);
    osc.stop(now + station.tempoMs / 1000);
    stepCount += 1;
  }

  function stopRadio() {
    if (stepTimer) { clearInterval(stepTimer); stepTimer = null; }
    playing = false;
    document.getElementById('playBtn').textContent = '▶';
  }

  function startRadio() {
    if (!stations.length) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    playing = true;
    document.getElementById('playBtn').textContent = '⏸';
    stepCount = 0;
    var station = stations[stationIndex];
    playStep(station);
    stepTimer = setInterval(function () { playStep(station); }, station.tempoMs);
  }

  function toggleRadio() {
    if (playing) stopRadio(); else startRadio();
  }
  window.toggleRadio = toggleRadio;

  function changeStation(direction) {
    if (!stations.length) return;
    stationIndex = ((stationIndex + direction) % stations.length + stations.length) % stations.length;
    renderStationName();
    if (playing) { stopRadio(); startRadio(); }
  }
  window.changeStation = changeStation;
})();
</script>
</body>
</html>
]====]

local function start()
  if running then stop() end

  server = socket.tcp()
  if not server then
    log('E', 'beamPlayServer', 'failed to create tcp socket')
    return nil
  end

  server:setoption('reuseaddr', true)
  local ok, err = server:bind('0.0.0.0', listenPort)
  if not ok then
    log('E', 'beamPlayServer', 'bind failed on port ' .. listenPort .. ': ' .. tostring(err))
    server:close()
    server = nil
    return nil
  end

  server:listen()
  server:settimeout(0)
  running = true
  log('I', 'beamPlayServer', 'listening on port ' .. listenPort)
  return listenPort
end

stop = function()
  if not running then return end
  for _, c in ipairs(clients) do c:close() end
  clients = {}
  if server then server:close() end
  server = nil
  running = false
  log('I', 'beamPlayServer', 'stopped')
end

function M.setData(jsonStr)
  if type(jsonStr) ~= 'string' then return end
  local ok = pcall(json.decode, jsonStr)
  if ok then
    dataStr = jsonStr
  end
end

function M.getInfo()
  return json.encode({
    running = running,
    port = listenPort,
    ip = detectLanIp() or '127.0.0.1'
  })
end

function M.getPendingCommand()
  return pendingCommand or ''
end

function M.clearPendingCommand()
  pendingCommand = nil
end

local function respond(c, status, contentType, body)
  local headers = 'HTTP/1.1 ' .. status .. '\r\nContent-Type: ' .. contentType
    .. '\r\nContent-Length: ' .. #body .. '\r\nConnection: close\r\n\r\n'
  c:send(headers .. body)
end

local function handle(c, line)
  local path = line:match('GET%s+/(.-)%s+HTTP') or ''
  if path == '' or path == 'index.html' then
    respond(c, '200 OK', 'text/html; charset=utf-8', companionHtml)
  elseif path == 'data.json' then
    respond(c, '200 OK', 'application/json', dataStr)
  elseif path == 'command/reset-trip' then
    pendingCommand = 'reset-trip'
    respond(c, '200 OK', 'application/json', '{"ok":true}')
  else
    respond(c, '404 Not Found', 'text/plain', 'not found')
  end
end

local function update()
  if not running then return end

  while true do
    local client = server:accept()
    if not client then break end
    client:settimeout(0)
    table.insert(clients, client)
  end

  for i = #clients, 1, -1 do
    local c = clients[i]
    local line, err = c:receive()
    if line then
      handle(c, line)
      c:close()
      table.remove(clients, i)
    elseif err ~= 'timeout' then
      c:close()
      table.remove(clients, i)
    end
  end
end

M.start = start
M.stop = stop
M.onUpdate = update

return M
