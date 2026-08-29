const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../ui/modules/apps/BeamPlay/app.js');

test('convertSpeed: metric uses km/h, matches m/s * 3.6', () => {
  const r = app.convertSpeed(10, 'metric');
  assert.equal(r.unit, 'km/h');
  assert.ok(Math.abs(r.value - 36) < 1e-9);
});

test('convertSpeed: imperial uses mph', () => {
  const r = app.convertSpeed(10, 'imperial');
  assert.equal(r.unit, 'mph');
  assert.ok(Math.abs(r.value - 22.369362921) < 1e-6);
});

test('convertSpeed: handles negative/undefined speed defensively', () => {
  assert.equal(app.convertSpeed(-5, 'metric').value, 18);
  assert.equal(app.convertSpeed(undefined, 'metric').value, 0);
  assert.equal(app.convertSpeed(NaN, 'metric').value, 0);
});

test('convertDistance: metric km, imperial miles', () => {
  assert.ok(Math.abs(app.convertDistance(1000, 'metric').value - 1) < 1e-9);
  assert.ok(Math.abs(app.convertDistance(1609.34, 'imperial').value - 1) < 1e-3);
});

test('convertTemp: celsius passthrough and fahrenheit conversion', () => {
  assert.equal(app.convertTemp(0, 'metric').value, 0);
  assert.equal(app.convertTemp(100, 'imperial').value, 212);
  assert.equal(app.convertTemp(undefined, 'metric'), null);
});

test('getGearText: forward, neutral, reverse', () => {
  assert.equal(app.getGearText(3), '3');
  assert.equal(app.getGearText(0), 'N');
  assert.equal(app.getGearText(-1), 'R');
  assert.equal(app.getGearText(undefined), 'N');
});

test('rpmFraction: clamps into [0,1] and guards div-by-zero', () => {
  assert.equal(app.rpmFraction(4000, 800, 8000), (4000 - 800) / (8000 - 800));
  assert.equal(app.rpmFraction(-100, 800, 8000), 0);
  assert.equal(app.rpmFraction(20000, 800, 8000), 1);
  assert.equal(app.rpmFraction(4000, 0, 0), 0);
});

test('isNearRedline: default 90% threshold', () => {
  assert.equal(app.isNearRedline(7300, 8000), true);
  assert.equal(app.isNearRedline(7000, 8000), false);
  assert.equal(app.isNearRedline(7300, 0), false);
});

test('readEngineInfo: pulls the confirmed engineInfo indices', () => {
  const engineInfo = [];
  engineInfo[0] = 900;   // idle rpm
  engineInfo[1] = 7000;  // redline
  engineInfo[4] = 3500;  // current rpm
  engineInfo[16] = 4;    // gear
  const r = app.readEngineInfo(engineInfo);
  assert.deepEqual(r, { idleRpm: 900, maxRpm: 7000, rpm: 3500, gear: 4 });
});

test('readEngineInfo: defensive default when array missing', () => {
  assert.deepEqual(app.readEngineInfo(undefined), { idleRpm: 0, maxRpm: 0, rpm: 0, gear: 0 });
});

test('isEngineOn: ignitionLevel takes priority, then engineRunning', () => {
  assert.equal(app.isEngineOn({ ignitionLevel: 2 }), true);
  assert.equal(app.isEngineOn({ ignitionLevel: 1 }), false);
  assert.equal(app.isEngineOn({ engineRunning: true }), true);
  assert.equal(app.isEngineOn({}), false);
  assert.equal(app.isEngineOn(null), false);
});

test('readSpeedMps: prefers wheelspeed, falls back to airspeed, then 0', () => {
  assert.equal(app.readSpeedMps({ wheelspeed: 12, airspeed: 20 }), 12);
  assert.equal(app.readSpeedMps({ airspeed: 20 }), 20);
  assert.equal(app.readSpeedMps({}), 0);
  assert.equal(app.readSpeedMps(null), 0);
});

test('formatDuration: mm:ss under an hour, h:mm:ss over', () => {
  assert.equal(app.formatDuration(65), '1:05');
  assert.equal(app.formatDuration(3661), '1:01:01');
  assert.equal(app.formatDuration(-5), '0:00');
});

test('computeAverageSpeedKmh: distance/time, guards zero time', () => {
  assert.ok(Math.abs(app.computeAverageSpeedKmh(10000, 3600) - 10) < 1e-9);
  assert.equal(app.computeAverageSpeedKmh(10000, 0), 0);
});

test('readBoolFlag: number and boolean electrics fields, missing -> null', () => {
  assert.equal(app.readBoolFlag({ lowbeam: 1 }, 'lowbeam'), true);
  assert.equal(app.readBoolFlag({ lowbeam: 0 }, 'lowbeam'), false);
  assert.equal(app.readBoolFlag({ lowbeam: true }, 'lowbeam'), true);
  assert.equal(app.readBoolFlag({}, 'lowbeam'), null);
  assert.equal(app.readBoolFlag(null, 'lowbeam'), null);
});

test('readStatusFlags: reads all known flags defensively', () => {
  const flags = app.readStatusFlags({ lowbeam: 1, hazard_enabled: 0 });
  assert.equal(flags.lowbeam, true);
  assert.equal(flags.hazard, false);
  assert.equal(flags.highbeam, null);
  assert.equal(flags.parkingBrake, null);
});

test('readFuelFraction: clamps 0..1, null when absent', () => {
  assert.equal(app.readFuelFraction({ fuel: 0.5 }), 0.5);
  assert.equal(app.readFuelFraction({ fuel: 1.4 }), 1);
  assert.equal(app.readFuelFraction({}), null);
});

test('formatClock: 24h and 12h formats', () => {
  const d = new Date(2026, 0, 1, 14, 5);
  assert.equal(app.formatClock(d, true), '14:05');
  assert.equal(app.formatClock(d, false), '2:05 PM');
  const midnight = new Date(2026, 0, 1, 0, 9);
  assert.equal(app.formatClock(midnight, false), '12:09 AM');
});

test('resolveDayNight: 6:00-19:59 is day, otherwise night', () => {
  assert.equal(app.resolveDayNight(12), 'day');
  assert.equal(app.resolveDayNight(6), 'day');
  assert.equal(app.resolveDayNight(19), 'day');
  assert.equal(app.resolveDayNight(20), 'night');
  assert.equal(app.resolveDayNight(2), 'night');
});

test('RADIO_STATIONS: every station has playable synth parameters', () => {
  assert.ok(app.RADIO_STATIONS.length > 0);
  for (const s of app.RADIO_STATIONS) {
    assert.ok(typeof s.id === 'string' && s.id.length > 0);
    assert.ok(typeof s.name === 'string' && s.name.length > 0);
    assert.ok(['sine', 'square', 'sawtooth', 'triangle'].includes(s.wave));
    assert.ok(s.baseFreq > 0);
    assert.ok(Array.isArray(s.notes) && s.notes.length > 0);
    assert.ok(s.tempoMs > 0);
    assert.ok(s.gain > 0 && s.gain <= 1);
  }
});

test('nextStationIndex: wraps forward and backward', () => {
  assert.equal(app.nextStationIndex(0, 4, 1), 1);
  assert.equal(app.nextStationIndex(3, 4, 1), 0);
  assert.equal(app.nextStationIndex(0, 4, -1), 3);
});

test('noteFrequency: semitone math (octave up doubles frequency)', () => {
  assert.ok(Math.abs(app.noteFrequency(220, 12) - 440) < 1e-9);
  assert.equal(app.noteFrequency(220, 0), 220);
});
