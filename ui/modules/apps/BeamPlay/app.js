// BeamPlay - a CarPlay/Android-Auto-inspired in-car display for BeamNG.drive.
//
// Architecture note: every function above the "angular.module" line at the
// bottom of this file is a pure function with no dependency on Angular,
// StreamsManager or the browser. That split lets the whole logic layer run
// (and be unit tested) under plain Node.js via `npm test`, the same pattern
// used by other shipped BeamNG UI apps. Only the directive registration at
// the bottom touches BeamNG/Angular globals, and it is skipped entirely
// when this file is loaded outside a browser.

var KM_PER_MILE = 1.60934;
var MPS_TO_KMH = 3.6;
var MPS_TO_MPH = 2.2369362921;

// engineInfo stream array indices (confirmed against two independently
// published BeamNG UI mods that read the same fields):
//   0  idle RPM        1  redline/max RPM     4  current RPM
//   16 current gear (>0 forward, <0 reverse, 0 neutral)
var ENGINE_INFO = {
  IDLE_RPM: 0,
  MAX_RPM: 1,
  RPM: 4,
  GEAR: 16
};

function isFiniteNumber(x) {
  return typeof x === 'number' && isFinite(x);
}

function safeNumber(x, fallback) {
  return isFiniteNumber(x) ? x : fallback;
}

function clampFraction(x) {
  if (!isFiniteNumber(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

// --- Units -----------------------------------------------------------------

function convertSpeed(metersPerSecond, unitMode) {
  var mps = safeNumber(metersPerSecond, 0);
  if (unitMode === 'imperial') {
    return { value: Math.abs(mps) * MPS_TO_MPH, unit: 'mph' };
  }
  return { value: Math.abs(mps) * MPS_TO_KMH, unit: 'km/h' };
}

function convertDistance(meters, unitMode) {
  var m = safeNumber(meters, 0);
  if (unitMode === 'imperial') {
    return { value: (m / 1000) / KM_PER_MILE, unit: 'mi' };
  }
  return { value: m / 1000, unit: 'km' };
}

function convertTemp(celsius, unitMode) {
  if (!isFiniteNumber(celsius)) return null;
  if (unitMode === 'imperial') {
    return { value: celsius * 9 / 5 + 32, unit: '°F' };
  }
  return { value: celsius, unit: '°C' };
}

// --- Dashboard ---------------------------------------------------------------

function getGearText(gear) {
  var g = safeNumber(gear, 0);
  if (g > 0.05) return String(Math.round(g));
  if (g < -0.05) return 'R';
  return 'N';
}

function rpmFraction(rpm, idleRpm, maxRpm) {
  var lo = safeNumber(idleRpm, 0);
  var hi = safeNumber(maxRpm, 0);
  var value = safeNumber(rpm, 0);
  if (hi <= lo) return 0;
  return clampFraction((value - lo) / (hi - lo));
}

function isNearRedline(rpm, maxRpm, thresholdPct) {
  var hi = safeNumber(maxRpm, 0);
  if (hi <= 0) return false;
  var t = typeof thresholdPct === 'number' ? thresholdPct : 0.9;
  return safeNumber(rpm, 0) >= hi * t;
}

function readEngineInfo(engineInfo) {
  if (!Array.isArray(engineInfo)) {
    return { idleRpm: 0, maxRpm: 0, rpm: 0, gear: 0 };
  }
  return {
    idleRpm: safeNumber(engineInfo[ENGINE_INFO.IDLE_RPM], 0),
    maxRpm: safeNumber(engineInfo[ENGINE_INFO.MAX_RPM], 0),
    rpm: safeNumber(engineInfo[ENGINE_INFO.RPM], 0),
    gear: safeNumber(engineInfo[ENGINE_INFO.GEAR], 0)
  };
}

function isEngineOn(electrics) {
  if (!electrics) return false;
  if (typeof electrics.ignitionLevel === 'number') {
    return electrics.ignitionLevel > 1;
  }
  if (typeof electrics.engineRunning === 'boolean') {
    return electrics.engineRunning;
  }
  return false;
}

function readSpeedMps(electrics) {
  if (!electrics) return 0;
  if (isFiniteNumber(electrics.wheelspeed)) return electrics.wheelspeed;
  if (isFiniteNumber(electrics.airspeed)) return electrics.airspeed;
  return 0;
}

// --- Trip --------------------------------------------------------------------

function formatDuration(totalSeconds) {
  var s = Math.max(0, Math.floor(safeNumber(totalSeconds, 0)));
  var h = Math.floor(s / 3600);
  var m = Math.floor((s % 3600) / 60);
  var sec = s % 60;
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  if (h > 0) return h + ':' + pad(m) + ':' + pad(sec);
  return m + ':' + pad(sec);
}

function computeAverageSpeedKmh(distanceMeters, elapsedSeconds) {
  var d = safeNumber(distanceMeters, 0);
  var t = safeNumber(elapsedSeconds, 0);
  if (t <= 0) return 0;
  return (d / 1000) / (t / 3600);
}

// --- Status indicators ---------------------------------------------------

// Every getter below is defensive: a vehicle/BeamNG version that doesn't
// expose a given electrics field yields `null` (not a crash, not a bogus
// zero) so the UI can render an explicit "--" instead of a false reading.
function readBoolFlag(electrics, key) {
  if (!electrics || typeof electrics[key] === 'undefined') return null;
  var v = electrics[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v > 0.5;
  return null;
}

function readStatusFlags(electrics) {
  return {
    lowbeam: readBoolFlag(electrics, 'lowbeam'),
    highbeam: readBoolFlag(electrics, 'highbeam'),
    signalLeft: readBoolFlag(electrics, 'signal_L'),
    signalRight: readBoolFlag(electrics, 'signal_R'),
    hazard: readBoolFlag(electrics, 'hazard_enabled'),
    parkingBrake: readBoolFlag(electrics, 'parkingbrake')
  };
}

function readFuelFraction(electrics) {
  if (!electrics || !isFiniteNumber(electrics.fuel)) return null;
  return clampFraction(electrics.fuel);
}

function readTemps(electrics, unitMode) {
  var water = electrics ? convertTemp(electrics.watertemp, unitMode) : null;
  var oil = electrics ? convertTemp(electrics.oiltemp, unitMode) : null;
  return { water: water, oil: oil };
}

// --- Clock / day-night -----------------------------------------------------

function formatClock(date, use24h) {
  var h = date.getHours();
  var m = date.getMinutes();
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  if (use24h) {
    return pad(h) + ':' + pad(m);
  }
  var period = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return h12 + ':' + pad(m) + ' ' + period;
}

function resolveDayNight(hour) {
  return (hour >= 6 && hour < 20) ? 'day' : 'night';
}

// --- Radio (Web Audio synth "stations", no external/copyrighted assets) ----

var RADIO_STATIONS = [
  { id: 'chill', name: 'Chillwave FM', wave: 'sine', baseFreq: 220, notes: [0, 3, 5, 7, 5, 3], tempoMs: 420, gain: 0.18 },
  { id: 'synth', name: 'Synth Drive', wave: 'sawtooth', baseFreq: 196, notes: [0, 2, 4, 7, 4, 2], tempoMs: 260, gain: 0.10 },
  { id: 'arcade', name: 'Arcade 8-bit', wave: 'square', baseFreq: 262, notes: [0, 4, 7, 12, 7, 4], tempoMs: 180, gain: 0.08 },
  { id: 'ambient', name: 'Ambient Cruise', wave: 'triangle', baseFreq: 174, notes: [0, 5, 7], tempoMs: 900, gain: 0.16 }
];

function nextStationIndex(current, length, direction) {
  if (length <= 0) return 0;
  var d = direction < 0 ? -1 : 1;
  return ((current + d) % length + length) % length;
}

// Semitone offset -> frequency multiplier.
function noteFrequency(baseFreq, semitoneOffset) {
  return baseFreq * Math.pow(2, semitoneOffset / 12);
}

// --- Phone companion (local HTTP mirror, see lua/ge/extensions/beamPlayServer.lua) --

// Builds the exact JSON-serializable snapshot pushed to the local web server
// so a phone on the same network can render a read-only CarPlay-style mirror
// of the current screen. Keeping this as one pure function means the payload
// shape is defined (and tested) in exactly one place.
function buildCompanionPayload(f) {
  f = f || {};
  return {
    engineOn: !!f.engineOn,
    speedValue: safeNumber(f.speedValue, 0),
    speedUnit: f.speedUnit || 'km/h',
    gearText: f.gearText || 'N',
    rpmPct: safeNumber(f.rpmPct, 0),
    nearRedline: !!f.nearRedline,
    fuelPctText: f.fuelPctText || '--',
    waterTempText: f.waterTempText || '--',
    oilTempText: f.oilTempText || '--',
    status: f.status || {},
    tripDistanceText: f.tripDistanceText || '',
    tripDurationText: f.tripDurationText || '',
    tripAvgSpeedText: f.tripAvgSpeedText || '',
    topSpeedText: f.topSpeedText || '',
    unitMode: f.unitMode === 'imperial' ? 'imperial' : 'metric',
    stations: RADIO_STATIONS
  };
}

// Normalizes whatever the Lua side hands back for a pending phone-issued
// command: trims it and turns "", undefined or non-strings into null so
// callers can do a plain `if (cmd === 'reset-trip')` check.
function parseCommand(raw) {
  if (typeof raw !== 'string') return null;
  var trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Decides which host the "open on your phone" URL should use. A
// user-typed manual override always wins -- it's the one option
// guaranteed to work no matter what networking APIs BeamNG's Lua sandbox
// does or doesn't expose (auto-detection has already been wrong once and
// unavailable once on real installs). Falls back to whatever the Lua
// server auto-detected, if anything.
function resolveCompanionHost(manualIp, autoIp, autoDetected) {
  var manual = (manualIp || '').trim();
  if (manual) return { host: manual, source: 'manual' };
  if (autoDetected && autoIp) return { host: autoIp, source: 'auto' };
  return { host: autoIp || '127.0.0.1', source: 'fallback' };
}

function buildCompanionUrl(host, port) {
  return 'http://' + host + ':' + port + '/';
}

var pureExports = {
  KM_PER_MILE: KM_PER_MILE,
  MPS_TO_KMH: MPS_TO_KMH,
  MPS_TO_MPH: MPS_TO_MPH,
  ENGINE_INFO: ENGINE_INFO,
  isFiniteNumber: isFiniteNumber,
  safeNumber: safeNumber,
  clampFraction: clampFraction,
  convertSpeed: convertSpeed,
  convertDistance: convertDistance,
  convertTemp: convertTemp,
  getGearText: getGearText,
  rpmFraction: rpmFraction,
  isNearRedline: isNearRedline,
  readEngineInfo: readEngineInfo,
  isEngineOn: isEngineOn,
  readSpeedMps: readSpeedMps,
  formatDuration: formatDuration,
  computeAverageSpeedKmh: computeAverageSpeedKmh,
  readBoolFlag: readBoolFlag,
  readStatusFlags: readStatusFlags,
  readFuelFraction: readFuelFraction,
  readTemps: readTemps,
  formatClock: formatClock,
  resolveDayNight: resolveDayNight,
  RADIO_STATIONS: RADIO_STATIONS,
  nextStationIndex: nextStationIndex,
  noteFrequency: noteFrequency,
  buildCompanionPayload: buildCompanionPayload,
  parseCommand: parseCommand,
  resolveCompanionHost: resolveCompanionHost,
  buildCompanionUrl: buildCompanionUrl
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = pureExports;
}

// -----------------------------------------------------------------------------
// Angular / BeamNG glue. Guarded so requiring this file under plain Node.js
// (as the test suite does) never touches `angular`, `StreamsManager`, or the
// browser Web Audio API.
// -----------------------------------------------------------------------------
if (typeof angular !== 'undefined') {
  angular.module('beamng.apps')
    .directive('beamPlay', [function () {
      return {
        templateUrl: '/ui/modules/apps/BeamPlay/app.html',
        replace: true,
        restrict: 'EA',
        scope: true,
        controller: ['$scope', '$interval', function ($scope, $interval) {
          var streamsList = ['electrics', 'engineInfo'];
          StreamsManager.add(streamsList);

          $scope.screen = 'home';
          $scope.unitMode = 'metric';
          $scope.use24h = true;
          $scope.dayNight = 'day';

          $scope.speedValue = 0;
          $scope.speedUnit = 'km/h';
          $scope.gearText = 'N';
          $scope.rpmPct = 0;
          $scope.nearRedline = false;
          $scope.engineOn = false;

          $scope.tripDistanceText = '0.0 km';
          $scope.tripAvgSpeedText = '0.0 km/h';
          $scope.tripDurationText = '0:00';
          $scope.topSpeedText = '0.0 km/h';

          $scope.status = { lowbeam: null, highbeam: null, signalLeft: null, signalRight: null, hazard: null, parkingBrake: null };
          $scope.fuelPct = null;
          $scope.waterTempText = '--';
          $scope.oilTempText = '--';

          $scope.stations = RADIO_STATIONS;
          $scope.stationIndex = 0;
          $scope.radioPlaying = false;
          $scope.radioVolumePct = 60;

          $scope.companionEnabled = false;
          $scope.companionStatus = 'off'; // 'off' | 'starting' | 'on'
          $scope.companionUrl = '';
          $scope.companionPort = null;
          $scope.companionUrlSource = 'fallback'; // 'manual' | 'auto' | 'fallback'
          $scope.companionManualIp = '';

          var companionAutoIp = null;
          var companionAutoDetected = false;

          var tripStartMs = null;
          var topSpeedMps = 0;

          function loadSettings() {
            try {
              var raw = localStorage.getItem('beamPlaySettings');
              if (!raw) return;
              var saved = JSON.parse(raw);
              if (saved.unitMode === 'metric' || saved.unitMode === 'imperial') $scope.unitMode = saved.unitMode;
              if (typeof saved.use24h === 'boolean') $scope.use24h = saved.use24h;
              if (typeof saved.radioVolumePct === 'number') $scope.radioVolumePct = saved.radioVolumePct;
              if (typeof saved.companionEnabled === 'boolean') $scope.companionEnabled = saved.companionEnabled;
              if (typeof saved.companionManualIp === 'string') $scope.companionManualIp = saved.companionManualIp;
            } catch (e) { /* corrupt/missing settings: keep defaults */ }
          }

          function saveSettings() {
            try {
              localStorage.setItem('beamPlaySettings', JSON.stringify({
                unitMode: $scope.unitMode,
                use24h: $scope.use24h,
                radioVolumePct: $scope.radioVolumePct,
                companionEnabled: $scope.companionEnabled,
                companionManualIp: $scope.companionManualIp
              }));
            } catch (e) { /* storage unavailable: settings just won't persist */ }
          }

          loadSettings();

          // --- Phone companion server (see lua/ge/extensions/beamPlayServer.lua) ---

          // Recomputes the displayed URL from whatever we currently know
          // (manual override always wins) without needing another round
          // trip to Lua -- so typing in the manual IP field updates the
          // shown URL immediately.
          function updateCompanionUrl() {
            if ($scope.companionStatus !== 'on' || !$scope.companionPort) {
              $scope.companionUrl = '';
              return;
            }
            var resolved = resolveCompanionHost($scope.companionManualIp, companionAutoIp, companionAutoDetected);
            $scope.companionUrlSource = resolved.source;
            $scope.companionUrl = buildCompanionUrl(resolved.host, $scope.companionPort);
          }

          $scope.setCompanionManualIp = function (value) {
            $scope.companionManualIp = value || '';
            saveSettings();
            updateCompanionUrl();
          };

          function startCompanionServer() {
            if (!bngApi || typeof bngApi.engineLua !== 'function') return;
            $scope.companionStatus = 'starting';
            bngApi.engineLua('extensions.load("beamPlayServer")');
            bngApi.engineLua('extensions.beamPlayServer.start()', function () {
              bngApi.engineLua('extensions.beamPlayServer.getInfo()', function (res) {
                $scope.$evalAsync(function () {
                  try {
                    var info = JSON.parse(res);
                    $scope.companionStatus = info.running ? 'on' : 'off';
                    $scope.companionPort = info.running ? info.port : null;
                    companionAutoIp = info.ip || null;
                    companionAutoDetected = !!info.detected;
                  } catch (e) {
                    $scope.companionStatus = 'off';
                    $scope.companionPort = null;
                    companionAutoIp = null;
                    companionAutoDetected = false;
                  }
                  updateCompanionUrl();
                });
              });
            });
          }

          function stopCompanionServer() {
            if (bngApi && typeof bngApi.engineLua === 'function') {
              bngApi.engineLua('extensions.beamPlayServer.stop()');
            }
            $scope.companionStatus = 'off';
            $scope.companionUrl = '';
            $scope.companionPort = null;
            companionAutoIp = null;
            companionAutoDetected = false;
          }

          $scope.toggleCompanion = function () {
            $scope.companionEnabled = !$scope.companionEnabled;
            saveSettings();
            if ($scope.companionEnabled) startCompanionServer(); else stopCompanionServer();
          };

          if ($scope.companionEnabled) startCompanionServer();

          var commandPollTimer = $interval(function () {
            if ($scope.companionStatus !== 'on' || !bngApi || typeof bngApi.engineLua !== 'function') return;
            bngApi.engineLua('extensions.beamPlayServer.getPendingCommand()', function (raw) {
              var cmd = parseCommand(raw);
              if (!cmd) return;
              bngApi.engineLua('extensions.beamPlayServer.clearPendingCommand()');
              if (cmd === 'reset-trip') {
                $scope.$evalAsync(function () { $scope.resetTrip(); });
              }
            });
          }, 500);

          $scope.goTo = function (screen) { $scope.screen = screen; };
          $scope.goHome = function () { $scope.screen = 'home'; };

          $scope.setUnitMode = function (mode) { $scope.unitMode = mode; saveSettings(); };
          $scope.toggleClockFormat = function () { $scope.use24h = !$scope.use24h; saveSettings(); };

          $scope.resetTrip = function () {
            tripStartMs = Date.now();
            topSpeedMps = 0;
            $scope._tripStartDistance = null;
          };
          $scope.resetTrip();

          // --- Radio (Web Audio synth, no external audio files needed) ---
          var audioCtx = null;
          var activeOscillators = [];
          var masterGain = null;
          var stepTimer = null;

          function ensureAudioContext() {
            if (audioCtx) return audioCtx;
            var Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            audioCtx = new Ctor();
            masterGain = audioCtx.createGain();
            masterGain.gain.value = $scope.radioVolumePct / 100;
            masterGain.connect(audioCtx.destination);
            return audioCtx;
          }

          function stopRadio() {
            if (stepTimer) { $interval.cancel(stepTimer); stepTimer = null; }
            activeOscillators.forEach(function (osc) {
              try { osc.stop(); } catch (e) { /* already stopped */ }
            });
            activeOscillators = [];
          }

          function playStep(station) {
            var ctx = ensureAudioContext();
            if (!ctx) return;
            var step = playStep._i || 0;
            var semis = station.notes[step % station.notes.length];
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
            activeOscillators.push(osc);
            osc.onended = function () {
              var idx = activeOscillators.indexOf(osc);
              if (idx !== -1) activeOscillators.splice(idx, 1);
            };
            playStep._i = step + 1;
          }

          $scope.playRadio = function () {
            var ctx = ensureAudioContext();
            if (!ctx) return;
            if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
            $scope.radioPlaying = true;
            var station = $scope.stations[$scope.stationIndex];
            playStep._i = 0;
            playStep(station);
            stepTimer = $interval(function () { playStep(station); }, station.tempoMs);
          };

          $scope.pauseRadio = function () {
            $scope.radioPlaying = false;
            stopRadio();
          };

          $scope.toggleRadio = function () {
            if ($scope.radioPlaying) $scope.pauseRadio(); else $scope.playRadio();
          };

          $scope.changeStation = function (direction) {
            $scope.stationIndex = nextStationIndex($scope.stationIndex, $scope.stations.length, direction);
            if ($scope.radioPlaying) { stopRadio(); $scope.playRadio(); }
          };

          $scope.setVolume = function (pct) {
            $scope.radioVolumePct = pct;
            if (masterGain) masterGain.gain.value = pct / 100;
            saveSettings();
          };

          // --- Clock tick (real-world time, like real CarPlay) ---
          function tickClock() {
            var now = new Date();
            $scope.clockText = formatClock(now, $scope.use24h);
            $scope.dayNight = resolveDayNight(now.getHours());
          }
          tickClock();
          var clockTimer = $interval(tickClock, 1000);

          // --- Telemetry ---
          $scope.$on('streamsUpdate', function (event, streams) {
            if (!streams) return;
            updateFromStreams(streams.electrics, streams.engineInfo);
          });

          function updateFromStreams(electrics, engineInfo) {
            var speedMps = readSpeedMps(electrics);
            var speed = convertSpeed(speedMps, $scope.unitMode);
            $scope.speedValue = Math.round(speed.value);
            $scope.speedUnit = speed.unit;

            var eng = readEngineInfo(engineInfo);
            $scope.gearText = getGearText(eng.gear);
            $scope.rpmPct = Math.round(rpmFraction(eng.rpm, eng.idleRpm, eng.maxRpm) * 100);
            $scope.nearRedline = isNearRedline(eng.rpm, eng.maxRpm, 0.9);
            $scope.engineOn = isEngineOn(electrics);

            $scope.status = readStatusFlags(electrics);
            $scope.fuelPct = readFuelFraction(electrics);
            var fuelPct = $scope.fuelPct;
            $scope.fuelPctText = fuelPct === null ? '--' : Math.round(fuelPct * 100) + '%';

            var temps = readTemps(electrics, $scope.unitMode);
            $scope.waterTempText = temps.water ? Math.round(temps.water.value) + temps.water.unit : '--';
            $scope.oilTempText = temps.oil ? Math.round(temps.oil.value) + temps.oil.unit : '--';

            if (Math.abs(speedMps) > topSpeedMps) topSpeedMps = Math.abs(speedMps);
            var topSpeed = convertSpeed(topSpeedMps, $scope.unitMode);
            $scope.topSpeedText = topSpeed.value.toFixed(1) + ' ' + topSpeed.unit;

            var tripMeters = electrics && isFiniteNumber(electrics.trip) ? electrics.trip : 0;
            if ($scope._tripStartDistance === null || typeof $scope._tripStartDistance === 'undefined') {
              $scope._tripStartDistance = tripMeters;
            }
            var tripDelta = Math.max(0, tripMeters - $scope._tripStartDistance);
            var tripDist = convertDistance(tripDelta, $scope.unitMode);
            $scope.tripDistanceText = tripDist.value.toFixed(1) + ' ' + tripDist.unit;

            var elapsedSeconds = tripStartMs ? (Date.now() - tripStartMs) / 1000 : 0;
            $scope.tripDurationText = formatDuration(elapsedSeconds);
            var avgKmh = computeAverageSpeedKmh(tripDelta, elapsedSeconds);
            var avgConverted = $scope.unitMode === 'imperial' ? avgKmh / KM_PER_MILE : avgKmh;
            $scope.tripAvgSpeedText = avgConverted.toFixed(1) + ' ' + speed.unit;

            if ($scope.companionStatus === 'on' && bngApi && typeof bngApi.engineLua === 'function') {
              var payload = buildCompanionPayload({
                engineOn: $scope.engineOn,
                speedValue: $scope.speedValue,
                speedUnit: $scope.speedUnit,
                gearText: $scope.gearText,
                rpmPct: $scope.rpmPct,
                nearRedline: $scope.nearRedline,
                fuelPctText: $scope.fuelPctText,
                waterTempText: $scope.waterTempText,
                oilTempText: $scope.oilTempText,
                status: $scope.status,
                tripDistanceText: $scope.tripDistanceText,
                tripDurationText: $scope.tripDurationText,
                tripAvgSpeedText: $scope.tripAvgSpeedText,
                topSpeedText: $scope.topSpeedText,
                unitMode: $scope.unitMode
              });
              bngApi.engineLua('extensions.beamPlayServer.setData(' + JSON.stringify(JSON.stringify(payload)) + ')');
            }
          }

          $scope.$on('$destroy', function () {
            StreamsManager.remove(streamsList);
            $interval.cancel(clockTimer);
            $interval.cancel(commandPollTimer);
            stopRadio();
            if ($scope.companionStatus !== 'off') stopCompanionServer();
          });
        }]
      };
    }]);
}
