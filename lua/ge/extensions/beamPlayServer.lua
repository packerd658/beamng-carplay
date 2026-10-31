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

-- Finds the IP address this machine would use to reach the outside world,
-- which in practice is its LAN-facing address -- exactly what a phone on
-- the same WiFi needs to connect back to. This is the standard portable
-- trick for "what's my own LAN IP": open a UDP socket, "connect" it to an
-- arbitrary address (UDP connect() just picks a route/local address; it
-- sends no packets and needs no reachable peer), then read back the local
-- endpoint with getsockname(). This deliberately avoids hostname/DNS
-- lookups (dns.gethostname()+dns.toip()) -- those commonly resolve a
-- machine's own hostname to 127.0.0.1 or a stale/VPN address, which is
-- exactly the bug this replaces: it was showing 127.0.0.1 to phones,
-- which can only ever mean "the phone itself" and always fails there.
local function detectLanIp()
  local ok, probe = pcall(socket.udp)
  if not ok or not probe then return nil end

  local connectOk = select(1, pcall(function()
    return probe:setpeername('203.0.113.1', 80) -- TEST-NET-3 (RFC 5737): never routed, nothing is sent
  end))
  if not connectOk then
    probe:close()
    return nil
  end

  local nameOk, ip = pcall(function() return (probe:getsockname()) end)
  probe:close()
  if not nameOk or type(ip) ~= 'string' then return nil end
  if ip == '0.0.0.0' or ip == '127.0.0.1' or ip:match('^169%.254%.') then return nil end
  return ip
end

-- Self-contained companion page: no external CSS/JS files, so this one
-- HTTP response is everything a phone browser needs. Polls /data.json
-- once a second and renders it CarPlay-style (sidebar nav, a live
-- position trail, Now Playing, a live-stats ticker); the radio screen
-- plays its own independent Web Audio synth locally on the phone
-- (station definitions come from the polled JSON, so there is nothing to
-- keep in sync by hand). Best viewed with the phone turned sideways.
local companionHtml = [====[
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1"/>
<title>BeamPlay</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; background: #120720; }
  body {
    font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    color: #f1edfb;
    background: linear-gradient(135deg, #2a1152 0%, #190a30 55%, #120720 100%);
    height: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .statusbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; font-size: 14px; font-weight: 600; flex-shrink: 0;
    background: rgba(0,0,0,0.22); border-bottom: 1px solid rgba(255,255,255,0.08);
  }
  .dot { color: #6a7686; font-size: 10px; }
  .dot.on { color: #33e07a; }
  .conn { font-size: 11px; opacity: 0.6; }
  .body { display: flex; flex: 1; min-height: 0; }
  .sidebar {
    width: 56px; flex: 0 0 auto; display: flex; flex-direction: column; align-items: center;
    gap: 10px; padding: 10px 0; background: rgba(0,0,0,0.18); border-right: 1px solid rgba(255,255,255,0.07);
  }
  .nav-spacer { flex: 1; }
  .nav-icon { cursor: pointer; padding: 4px; border-radius: 12px; }
  .nav-icon.active { background: rgba(255,255,255,0.1); }
  .nav-glyph {
    width: 34px; height: 34px; display: flex; align-items: center; justify-content: center;
    border-radius: 30%; font-size: 13px; font-weight: 700; color: #fff;
    background: linear-gradient(145deg, #3d2766, #241244); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
  }
  .nav-icon.active .nav-glyph { box-shadow: 0 0 0 2px #7c5cff, inset 0 0 0 1px rgba(255,255,255,0.1); }
  .nav-drive { background: linear-gradient(145deg, #2f6fed, #1746a2); font-size: 11px; }
  .nav-trip { background: linear-gradient(145deg, #2fbf71, #177a44); }
  .nav-status { background: linear-gradient(145deg, #e0a72f, #a06e12); }
  .nav-radio { background: linear-gradient(145deg, #c04fd6, #7a1f8c); }
  .main { flex: 1; min-width: 0; overflow-y: auto; }
  .screen { display: none; height: 100%; box-sizing: border-box; padding: 14px; }
  .screen.drive { gap: 12px; }
  .screen.active { display: block; }
  .screen.drive.active { display: flex; }
  .card {
    flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 12px;
    border-radius: 14px; background: rgba(255,255,255,0.06); box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06);
  }
  .card-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.6; margin-bottom: 6px; }
  .position-readout { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  .position-map { flex: 1; width: 100%; border-radius: 10px; background: rgba(0,0,0,0.2); }
  .trail-path { fill: none; stroke: #7c5cff; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .trail-dot { fill: #33e07a; stroke: rgba(255,255,255,0.8); stroke-width: 1.5; }
  .position-hint { margin-top: 8px; font-size: 11px; opacity: 0.55; text-align: center; }
  .nowplaying-card { align-items: center; justify-content: center; text-align: center; }
  .np-station { font-size: 18px; font-weight: 700; margin: 6px 0 14px; }
  .np-controls { display: flex; align-items: center; justify-content: center; gap: 16px; }
  .np-volume { display: flex; align-items: center; gap: 8px; margin-top: 16px; font-size: 12px; width: 100%; }
  .np-volume input { flex: 1; }
  .round { width: 54px; height: 54px; border-radius: 50%; font-size: 18px; border: none; background: rgba(255,255,255,0.1); color: #fff; }
  .play { width: 66px; height: 66px; font-size: 22px; background: #2fbf71; }
  .row { display: flex; justify-content: space-between; padding: 10px 4px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 15px; }
  .row .label { opacity: 0.7; }
  .row .value { font-weight: 700; }
  .btn { margin-top: 18px; width: 100%; padding: 12px; border: none; border-radius: 10px; background: #7c5cff; color: #fff; font-weight: 700; font-size: 15px; }
  .status-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
  .status-cell { text-align: center; padding: 14px 6px; border-radius: 10px; background: rgba(255,255,255,0.05); font-size: 12px; opacity: 0.6; }
  .status-cell.on { opacity: 1; background: rgba(51,224,122,0.16); }
  .status-glyph { font-size: 22px; margin-bottom: 4px; }
  .status-val { margin-top: 4px; font-weight: 700; }
  .ticker {
    flex-shrink: 0; display: flex; align-items: center; gap: 8px; margin: 8px 12px 12px;
    padding: 10px 14px; border-radius: 12px; background: rgba(0,0,0,0.3);
    box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08); font-size: 13px; font-weight: 600;
  }
  .ticker-text { opacity: 0.85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint { margin-top: 18px; font-size: 11px; opacity: 0.5; text-align: center; }
</style>
</head>
<body>
  <div class="statusbar">
    <span id="clock">--:--</span>
    <span><span class="dot" id="engineDot">&#9679;</span></span>
    <span class="conn" id="connStatus">connecting&hellip;</span>
  </div>

  <div class="body">
    <div class="sidebar">
      <div class="nav-icon active" data-nav="drive" onclick="showScreen('drive')"><div class="nav-glyph nav-drive" id="navSpeed">0</div></div>
      <div class="nav-icon" data-nav="trip" onclick="showScreen('trip')"><div class="nav-glyph nav-trip">&#9673;</div></div>
      <div class="nav-icon" data-nav="status" onclick="showScreen('status')"><div class="nav-glyph nav-status">&#9888;</div></div>
      <div class="nav-icon" data-nav="radio" onclick="showScreen('radio')"><div class="nav-glyph nav-radio">&#9834;</div></div>
      <div class="nav-spacer"></div>
    </div>

    <div class="main">
      <div class="screen drive active" data-screen="drive">
        <div class="card">
          <div class="card-title">Live Position</div>
          <div class="position-readout" id="positionReadout">0 km/h</div>
          <svg class="position-map" viewBox="0 0 300 180" preserveAspectRatio="xMidYMid meet">
            <path id="trailPath" class="trail-path" d=""></path>
            <circle id="trailDot" class="trail-dot" cx="150" cy="90" r="5" style="display:none"></circle>
          </svg>
          <div class="position-hint" id="positionHint">Position unavailable &mdash; a live breadcrumb trail, not a road map.</div>
        </div>
        <div class="card nowplaying-card">
          <div class="card-title">Now Playing</div>
          <div class="np-station" id="radioStationName">&mdash;</div>
          <div class="np-controls">
            <button class="round" onclick="changeStation(-1)">&#9198;</button>
            <button class="round play" id="playBtn" onclick="toggleRadio()">&#9654;</button>
            <button class="round" onclick="changeStation(1)">&#9197;</button>
          </div>
          <div class="np-volume">
            <span>Vol</span>
            <input type="range" id="volumeSlider" min="0" max="100" value="60" oninput="setVolume(this.value)"/>
            <span id="volumeLabel">60%</span>
          </div>
        </div>
      </div>

      <div class="screen" data-screen="trip">
        <div class="row"><span class="label">Distance</span><span class="value" id="tripDistanceText">--</span></div>
        <div class="row"><span class="label">Duration</span><span class="value" id="tripDurationText">--</span></div>
        <div class="row"><span class="label">Average speed</span><span class="value" id="tripAvgSpeedText">--</span></div>
        <div class="row"><span class="label">Top speed</span><span class="value" id="topSpeedText">--</span></div>
        <button class="btn" onclick="sendCommand('reset-trip')">Reset trip</button>
      </div>

      <div class="screen" data-screen="status">
        <div class="status-grid">
          <div class="status-cell" id="cell-lowbeam"><div class="status-glyph">&#9788;</div><div>Low beam</div><div class="status-val" id="val-lowbeam">n/a</div></div>
          <div class="status-cell" id="cell-highbeam"><div class="status-glyph">&#9728;</div><div>High beam</div><div class="status-val" id="val-highbeam">n/a</div></div>
          <div class="status-cell" id="cell-hazard"><div class="status-glyph">&#9650;</div><div>Hazards</div><div class="status-val" id="val-hazard">n/a</div></div>
          <div class="status-cell" id="cell-parkingBrake"><div class="status-glyph">P</div><div>Parking brake</div><div class="status-val" id="val-parkingBrake">n/a</div></div>
        </div>
      </div>

      <div class="screen" data-screen="radio">
        <div class="np-station" id="radioStationNameFull" style="font-size:22px; margin:24px 0 20px;">&mdash;</div>
        <div class="np-controls">
          <button class="round" onclick="changeStation(-1)">&#9198;</button>
          <button class="round play" id="playBtnFull" onclick="toggleRadio()">&#9654;</button>
          <button class="round" onclick="changeStation(1)">&#9197;</button>
        </div>
        <div class="hint">Plays locally on this phone &mdash; independent synth audio, not streamed from the PC.</div>
      </div>
    </div>
  </div>

  <div class="ticker">
    <span class="dot" id="tickerDot">&#9679;</span>
    <span class="ticker-text" id="tickerText">Waiting for telemetry&hellip;</span>
  </div>

<script>
(function () {
  'use strict';

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-screen') === name);
    });
    document.querySelectorAll('.nav-icon').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-nav') === name);
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

  function setStatusCell(key) {
    var val = lastData && lastData.status ? lastData.status[key] : null;
    var cell = document.getElementById('cell-' + key);
    var valEl = document.getElementById('val-' + key);
    if (!cell || !valEl) return;
    cell.classList.toggle('on', val === true);
    valEl.textContent = val === null || typeof val === 'undefined' ? 'n/a' : (val ? 'ON' : 'off');
  }

  // --- Live position trail (client-accumulated from polled x/y, same
  // breadcrumb-plot approach as the in-game widget; lower resolution
  // here since this only updates once per HTTP poll) ---
  var trail = [];
  var TRAIL_MAX = 60;

  function updateTrail(point) {
    if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return;
    var last = trail[trail.length - 1];
    if (!last || Math.abs(last.x - point.x) > 0.5 || Math.abs(last.y - point.y) > 0.5) {
      trail.push({ x: point.x, y: point.y });
    }
    if (trail.length > TRAIL_MAX) trail = trail.slice(trail.length - TRAIL_MAX);
  }

  function renderTrail() {
    var viewW = 300, viewH = 180, pad = 12;
    var pathEl = document.getElementById('trailPath');
    var dotEl = document.getElementById('trailDot');
    if (trail.length < 2) {
      pathEl.setAttribute('d', '');
      dotEl.style.display = 'none';
      return;
    }
    var xs = trail.map(function (p) { return p.x; });
    var ys = trail.map(function (p) { return p.y; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var spanX = Math.max(maxX - minX, 1);
    var spanY = Math.max(maxY - minY, 1);
    var scale = Math.min((viewW - pad * 2) / spanX, (viewH - pad * 2) / spanY);
    function project(p) {
      return { x: pad + (p.x - minX) * scale, y: (viewH - pad) - (p.y - minY) * scale };
    }
    var d = trail.map(function (p, i) {
      var v = project(p);
      return (i === 0 ? 'M' : 'L') + v.x.toFixed(1) + ',' + v.y.toFixed(1);
    }).join(' ');
    pathEl.setAttribute('d', d);
    var cur = project(trail[trail.length - 1]);
    dotEl.setAttribute('cx', cur.x.toFixed(1));
    dotEl.setAttribute('cy', cur.y.toFixed(1));
    dotEl.style.display = '';
  }

  function render(data) {
    lastData = data;
    document.getElementById('engineDot').classList.toggle('on', !!data.engineOn);
    document.getElementById('tickerDot').classList.toggle('on', !!data.engineOn);
    document.getElementById('connStatus').textContent = 'connected';

    document.getElementById('navSpeed').textContent = data.speedValue;
    document.getElementById('positionReadout').textContent =
      data.speedValue + ' ' + data.speedUnit +
      (data.position && data.position.headingText ? '  ·  Heading ' + data.position.headingText : '');

    document.getElementById('tripDistanceText').textContent = data.tripDistanceText;
    document.getElementById('tripDurationText').textContent = data.tripDurationText;
    document.getElementById('tripAvgSpeedText').textContent = data.tripAvgSpeedText;
    document.getElementById('topSpeedText').textContent = data.topSpeedText;

    setStatusCell('lowbeam');
    setStatusCell('highbeam');
    setStatusCell('hazard');
    setStatusCell('parkingBrake');

    document.getElementById('tickerText').textContent = data.tickerText || (data.engineOn ? '' : 'Engine off');

    var posEl = document.getElementById('positionHint');
    if (data.position && data.position.available) {
      posEl.style.display = 'none';
      updateTrail(data.position);
      renderTrail();
    } else {
      posEl.style.display = '';
    }

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
  var volumePct = 60;

  function renderStationName() {
    var name = stations[stationIndex] ? stations[stationIndex].name : '—';
    var el1 = document.getElementById('radioStationName');
    var el2 = document.getElementById('radioStationNameFull');
    if (el1) el1.textContent = name;
    if (el2) el2.textContent = name;
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
    masterGain.gain.value = volumePct / 100;
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
    document.getElementById('playBtnFull').textContent = '▶';
  }

  function startRadio() {
    if (!stations.length) return;
    var ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
    playing = true;
    document.getElementById('playBtn').textContent = '⏸';
    document.getElementById('playBtnFull').textContent = '⏸';
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

  function setVolume(pct) {
    volumePct = Number(pct) || 0;
    document.getElementById('volumeLabel').textContent = volumePct + '%';
    if (masterGain) masterGain.gain.value = volumePct / 100;
  }
  window.setVolume = setVolume;
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
  local ip = detectLanIp()
  return json.encode({
    running = running,
    port = listenPort,
    ip = ip or '127.0.0.1',
    -- false means detection failed and `ip` is just the loopback
    -- fallback, which will not work from a phone; the UI uses this to
    -- warn the user instead of silently showing an address that can't work.
    detected = ip ~= nil
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
