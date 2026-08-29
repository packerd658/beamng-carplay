const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../ui/modules/apps/BeamPlay/app.js');

const luaPath = path.join(__dirname, '..', 'lua', 'ge', 'extensions', 'beamPlayServer.lua');
const luaSource = fs.readFileSync(luaPath, 'utf8');

function extractCompanionHtml(source) {
  const match = source.match(/\[====\[([\s\S]*?)\]====\]/);
  assert.ok(match, 'companionHtml long-bracket string not found in beamPlayServer.lua');
  return match[1];
}

function extractInlineScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'inline <script> block not found in companion page');
  return match[1];
}

test('beamPlayServer.lua exists and wires up the expected extension API', () => {
  assert.match(luaSource, /local socket = require\('socket\.socket'\)/);
  assert.match(luaSource, /M\.start = start/);
  assert.match(luaSource, /M\.stop = stop/);
  assert.match(luaSource, /M\.onUpdate = update/);
  assert.match(luaSource, /function M\.setData\(/);
  assert.match(luaSource, /function M\.getInfo\(\)/);
  assert.match(luaSource, /function M\.getPendingCommand\(\)/);
  assert.match(luaSource, /function M\.clearPendingCommand\(\)/);
});

test('beamPlayServer.lua routes the paths the companion page and app.js expect', () => {
  assert.match(luaSource, /path == '' or path == 'index\.html'/);
  assert.match(luaSource, /path == 'data\.json'/);
  assert.match(luaSource, /path == 'command\/reset-trip'/);
});

test('companion page inline script is syntactically valid JS', () => {
  const html = extractCompanionHtml(luaSource);
  const js = extractInlineScript(html);
  assert.doesNotThrow(() => new Function(js), 'inline <script> failed to parse');
});

test('companion page only reads fields that buildCompanionPayload actually sends', () => {
  const html = extractCompanionHtml(luaSource);
  const js = extractInlineScript(html);

  const payload = app.buildCompanionPayload({ status: {} });
  const payloadKeys = new Set(Object.keys(payload));

  const used = new Set();
  // Negative lookbehind excludes the literal '/data.json' route string --
  // only a bare `data.field` variable reference should count.
  const re = /(?<![/\w])data\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    used.add(m[1]);
  }

  assert.ok(used.size > 0, 'expected the companion page to reference at least one data.* field');
  for (const key of used) {
    assert.ok(
      payloadKeys.has(key),
      `companion page reads data.${key}, but buildCompanionPayload doesn't produce that field`
    );
  }
});

test('companion page fetches the same routes the Lua server exposes', () => {
  const html = extractCompanionHtml(luaSource);
  const js = extractInlineScript(html);
  assert.match(js, /fetch\('\/data\.json'\)/);
  assert.match(js, /fetch\('\/command\/' \+ name\)/);
});

test('buildCompanionPayload: shape and defensive defaults', () => {
  const empty = app.buildCompanionPayload();
  assert.equal(empty.speedValue, 0);
  assert.equal(empty.speedUnit, 'km/h');
  assert.equal(empty.gearText, 'N');
  assert.equal(empty.unitMode, 'metric');
  assert.deepEqual(empty.status, {});
  assert.equal(empty.stations, app.RADIO_STATIONS);

  const full = app.buildCompanionPayload({
    engineOn: true,
    speedValue: 87,
    speedUnit: 'mph',
    gearText: '4',
    rpmPct: 62,
    nearRedline: true,
    fuelPctText: '55%',
    waterTempText: '92°C',
    oilTempText: '90°C',
    status: { lowbeam: true },
    tripDistanceText: '12.3 km',
    tripDurationText: '5:00',
    tripAvgSpeedText: '60.0 km/h',
    topSpeedText: '110.0 km/h',
    unitMode: 'imperial'
  });
  assert.equal(full.engineOn, true);
  assert.equal(full.speedValue, 87);
  assert.equal(full.unitMode, 'imperial');
  assert.equal(full.status.lowbeam, true);
});

test('parseCommand: trims, empty/non-string -> null', () => {
  assert.equal(app.parseCommand('reset-trip'), 'reset-trip');
  assert.equal(app.parseCommand('  reset-trip  '), 'reset-trip');
  assert.equal(app.parseCommand(''), null);
  assert.equal(app.parseCommand('   '), null);
  assert.equal(app.parseCommand(undefined), null);
  assert.equal(app.parseCommand(null), null);
  assert.equal(app.parseCommand(42), null);
});
