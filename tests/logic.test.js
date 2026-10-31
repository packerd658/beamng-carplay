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

test('updatePositionTrail: appends, throttles by distance, trims to maxPoints', () => {
  let trail = [];
  trail = app.updatePositionTrail(trail, { x: 0, y: 0 }, 5);
  assert.deepEqual(trail, [{ x: 0, y: 0 }]);

  // Sub-threshold move: not appended.
  trail = app.updatePositionTrail(trail, { x: 0.1, y: 0 }, 5);
  assert.equal(trail.length, 1);

  // Past the 0.5m threshold: appended.
  trail = app.updatePositionTrail(trail, { x: 1, y: 0 }, 5);
  assert.equal(trail.length, 2);
  assert.deepEqual(trail[1], { x: 1, y: 0 });

  // Trims to maxPoints, keeping the most recent.
  for (let i = 2; i <= 10; i++) {
    trail = app.updatePositionTrail(trail, { x: i, y: 0 }, 5);
  }
  assert.equal(trail.length, 5);
  assert.deepEqual(trail[trail.length - 1], { x: 10, y: 0 });
});

test('updatePositionTrail: ignores a point with non-finite coordinates', () => {
  const trail = app.updatePositionTrail([{ x: 0, y: 0 }], { x: NaN, y: 5 }, 10);
  assert.equal(trail.length, 1);
});

test('buildTrailView: empty/single-point trail has no path, centers the dot', () => {
  const empty = app.buildTrailView([], 100, 60);
  assert.equal(empty.path, '');
  assert.equal(empty.hasData, false);
  assert.equal(empty.currentX, 50);
  assert.equal(empty.currentY, 30);

  const single = app.buildTrailView([{ x: 5, y: 5 }], 100, 60);
  assert.equal(single.path, '');
  assert.equal(single.hasData, true);
});

test('buildTrailView: multi-point trail produces an SVG path and a current-position dot', () => {
  const trail = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
  const view = app.buildTrailView(trail, 100, 100, 10);
  assert.ok(view.hasData);
  assert.match(view.path, /^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/);
  // Current point is the trail's last entry -- furthest "up" (max y) and
  // right (max x), so after the Y-flip it should land near the top-right.
  assert.ok(view.currentX > 50);
  assert.ok(view.currentY < 50);
});

test('headingToCompass: cardinal/ordinal directions and wraparound', () => {
  assert.equal(app.headingToCompass(0), 'N');
  assert.equal(app.headingToCompass(45), 'NE');
  assert.equal(app.headingToCompass(90), 'E');
  assert.equal(app.headingToCompass(180), 'S');
  assert.equal(app.headingToCompass(359), 'N');
  assert.equal(app.headingToCompass(-45), 'NW');
  assert.equal(app.headingToCompass(undefined), '--');
  assert.equal(app.headingToCompass(NaN), '--');
});

test('buildStatusTicker: joins only the fields that are present', () => {
  const full = app.buildStatusTicker({
    speedValue: 58, speedUnit: 'mph', gearText: '4', rpmPct: 62,
    fuelPctText: '58%', waterTempText: '89°C'
  });
  assert.equal(full, '58 mph  ·  Gear 4  ·  62% RPM  ·  Fuel 58%  ·  89°C water');

  assert.equal(app.buildStatusTicker({}), '');
  assert.equal(app.buildStatusTicker({ fuelPctText: '--', waterTempText: '--' }), '');
  assert.equal(app.buildStatusTicker(), '');
});
