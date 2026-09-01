# BeamPlay — a CarPlay-inspired dash for BeamNG.drive

BeamPlay is a real BeamNG.drive **UI App** mod: a draggable, resizable
on-screen widget (the same mechanism the game uses for its built-in
speedometer, map, and fuel gauge apps) styled like a phone mounted on the
dash, CarPlay/Android-Auto style. It's built entirely on BeamNG's public UI
modding API — no game files are patched and no third-party audio/map assets
are bundled.

![BeamPlay icon](ui/modules/apps/BeamPlay/app.png)

## What it actually does

Everything below is live, backed by BeamNG's `StreamsManager`
(`electrics` / `engineInfo` streams) or by data BeamPlay computes itself —
nothing is a static mockup:

- **Dashboard** — live digital speed, gear, an RPM bar that flags red near
  redline, fuel %, water/oil temp (temperature and fuel tiles show `--`
  gracefully on a vehicle/version that doesn't expose those fields, instead
  of a fake reading).
- **Trip computer** — session distance, elapsed time, average speed and top
  speed, all computed client-side from the vehicle's `electrics.trip`
  odometer and a wall-clock timer, with a reset button.
- **Status** — low/high beam, hazards and parking-brake indicators.
- **BeamPlay Radio** — a real, playable "radio" with four stations. There
  are no bundled MP3s (avoids bloat and licensing issues) — each station is
  a small generative synth sequence rendered live with the browser's Web
  Audio API, which is exactly the tech BeamNG's own CEF-based UI runs on.
  Play/pause, next/prev station and a volume slider all work.
- **Settings** — metric/imperial toggle and 12h/24h clock, persisted with
  `localStorage` so they survive restarts.
- A real-world clock and an automatic day/night colour theme in the status
  bar, like an actual CarPlay unit.
- **Phone companion** (new) — flip "Phone companion" on in Settings and
  BeamPlay starts a small local web server; open the URL it shows you in
  your phone's browser (same WiFi network as your PC) for a second,
  CarPlay-styled screen mirroring live telemetry, with its own independent
  radio and a working "Reset trip" button that reaches back into the game.
  See [Phone companion](#phone-companion) below.

### Not actual Apple CarPlay

This mirrors CarPlay's *look*, not Apple's protocol. Real CarPlay requires
either MFi hardware certification (to appear as a receiver/head unit) or an
Apple-granted CarPlay entitlement for a narrow set of app categories
(audio, navigation, messaging, EV charging, etc.) to appear as an app
inside someone else's CarPlay — neither is realistic for a game mod, and
both would be a separate iOS project unrelated to this one. The phone
companion below gets you the "second screen in your hand" experience over
your own WiFi instead, with no Apple gatekeeping involved.

## Install (2 minutes)

BeamNG UI apps live in the game's `ui/modules/apps/` folder, and this mod's
optional server-side piece (used only by the phone companion feature) lives
in `lua/ge/extensions/`. The quickest way to try BeamPlay is to drop both
folders straight into your BeamNG install:

1. Locate your BeamNG install folder, e.g. on Windows:
   `C:\Program Files (x86)\Steam\steamapps\common\BeamNG.drive\`
   (or wherever Steam/the standalone installer put it).
2. Copy this repo's `ui/modules/apps/BeamPlay` folder into
   `<install>\ui\modules\apps\`, so you end up with
   `...\BeamNG.drive\ui\modules\apps\BeamPlay\app.json` etc.
3. Copy this repo's `lua/ge/extensions/beamPlayServer.lua` into
   `<install>\lua\ge\extensions\beamPlayServer.lua`. (You can skip this
   file if you don't want the phone companion feature — everything else
   works without it.)
4. Launch BeamNG, load into a vehicle, open the **Apps** menu (top-right
   gear/grid icon in the driving UI) and drag **BeamPlay** onto your
   screen.

### Installing as a `mods/` package instead

If you'd rather install it the same way downloaded mods work (via
`Documents/BeamNG.drive/<version>/mods/`), zip up the `ui/` and `lua/`
folders here (so the zip's root contains both `ui/modules/apps/BeamPlay/...`
and `lua/ge/extensions/beamPlayServer.lua`, matching the game's own folder
layout) into e.g. `BeamPlay.zip`, then drop that zip into
`Documents/BeamNG.drive/<version>/mods/`. BeamNG mounts mod zips without
unpacking them, and the app will show up in the in-game Apps menu exactly
the same way.

```
# from the repo root:
zip -r BeamPlay.zip ui lua
# -> BeamPlay.zip, ready to drop in the mods/ folder
```

## Phone companion

1. In-game, open BeamPlay's **Settings** screen and tap "Phone companion"
   to turn it on. BeamPlay loads `beamPlayServer.lua` and starts a small
   HTTP server (default port `23515`, LAN-only — it's not exposed to the
   internet).
2. Settings then shows a URL. BeamNG's Lua sandbox doesn't reliably expose
   a way to auto-detect your PC's own network address (this has failed in
   practice, not just in theory), so **don't count on the auto-detected
   address working** — Settings also shows a text field for your PC's LAN
   IP. Find it yourself (`ipconfig` on Windows, look for "IPv4 Address";
   `ip addr` or `ifconfig` on Linux/macOS) and type it in; the shown URL
   updates immediately and a manually-entered IP always takes priority
   over auto-detection.
3. Open that exact URL in your phone's browser, as long as the phone is on
   the **same WiFi network** as your PC. Windows Firewall may prompt to
   allow the connection the first time — allow it.
4. The phone page polls `/data.json` once a second for live telemetry, and
   plays its own independent synth radio locally (not audio streamed from
   the PC — no round trip needed for that). The Trip screen's **Reset
   trip** button is a real round trip: it hits `/command/reset-trip` on
   the server, which the game polls and acts on within half a second.

Turning "Phone companion" back off in Settings stops the server. It's also
stopped automatically if you remove the BeamPlay widget from your HUD.

## Verifying it works

This repo can't launch BeamNG itself, so verification is split two ways:

1. **Automated** — every piece of logic that doesn't need the game (unit
   conversion, gear-text formatting, RPM-bar math, trip-time formatting,
   status-flag parsing, radio station cycling, note-frequency math, the
   phone-companion payload shape) is a plain, dependency-free JS function,
   unit tested with Node's built-in test runner:

   ```
   npm test
   ```

   36 tests cover the math/formatting BeamPlay's UI displays, plus checks
   that the companion page (embedded as a string in the Lua server) is
   syntactically valid JS and only reads fields the payload builder
   actually sends — so the two can't silently drift apart.

2. **Manual, in-game** (do this after installing, to confirm the Angular/
   BeamNG-glue and Lua halves that can't run outside the game):
   - [ ] App appears in the in-game Apps picker and can be dragged onto the HUD.
   - [ ] Home screen shows five app icons; tapping each opens its screen and
         "‹ Home" returns to the grid.
   - [ ] With the engine running, Dashboard speed/gear/RPM bar track the
         vehicle in real time.
   - [ ] Trip screen's distance/timer increase while driving; **Reset
         trip** zeroes them.
   - [ ] Status screen's low-beam/hazard/parking-brake tiles light up when
         you toggle those in-game.
   - [ ] Radio: tapping ▶ produces audible synth audio; ⏮/⏭ change station
         and the audio changes; the volume slider changes loudness.
   - [ ] Settings: switching Metric/Imperial changes the units shown on
         Dashboard/Trip; the choice survives closing and reopening the app.
   - [ ] Settings: enabling "Phone companion" shows a URL; that URL loads
         a matching CarPlay-styled page on a phone on the same WiFi.
   - [ ] On the phone page: Dashboard/Trip/Status tiles update live; Radio
         plays audio on the phone itself; **Reset trip** on the phone
         zeroes the in-game trip screen too.

## Why the file layout looks like this

```
.
├── ui/modules/apps/BeamPlay/    ← the UI app (mirrors BeamNG's own folder layout)
│   ├── app.json                 ← manifest: name, default size/position, directive
│   ├── app.html                 ← AngularJS template (home grid + 5 screens)
│   ├── app.css                  ← styling
│   ├── app.js                   ← pure logic (Node-testable) + the Angular directive
│   └── app.png                  ← app-picker icon
├── lua/ge/extensions/
│   └── beamPlayServer.lua       ← optional local HTTP server for the phone companion
├── generate_icon.py             ← regenerates app.png (Pillow); not needed at runtime
├── tests/
│   ├── logic.test.js            ← Node test-runner suite for the pure logic in app.js
│   └── companion-page.test.js   ← validates the Lua-embedded companion page's JS
├── package.json                 ← `npm test` entry point
└── README.md
```

`ui/modules/apps/BeamPlay/` and `lua/ge/extensions/` are exactly the paths
BeamNG expects inside its own install folder or inside a mod zip — that's
why they're nested instead of flattened.

## Notes on the underlying BeamNG UI API

BeamPlay follows the same pattern used by other published BeamNG UI-app
mods (cross-checked against two independently maintained ones):

- Apps register as AngularJS directives on `angular.module('beamng.apps')`,
  with `templateUrl`/`domElement` wired up in `app.json`.
- Live telemetry comes from `StreamsManager.add([...])` plus a
  `$scope.$on('streamsUpdate', function (event, streams) { ... })`
  listener, cleaned up on `$scope.$on('$destroy', ...)`.
- Speed reads `electrics.wheelspeed` (falling back to `electrics.airspeed`);
  gear and RPM read fixed indices of the `engineInfo` array (`[16]` gear,
  `[4]` current RPM, `[1]` redline, `[0]` idle RPM) — the same indices used
  by other published gauge mods.
- Optional fields (`fuel`, `watertemp`, `oiltemp`, `lowbeam`, `highbeam`,
  `signal_L`/`signal_R`, `hazard_enabled`, `parkingbrake`) are read
  defensively: if a vehicle/BeamNG version doesn't expose one, BeamPlay
  shows a neutral "n/a"/`--` instead of guessing.
- The phone companion's server (`lua/ge/extensions/beamPlayServer.lua`) is
  a GE extension: `extensions.load("beamPlayServer")` from the UI app,
  then `M.onUpdate` (BeamNG's per-frame extension hook) drives a
  non-blocking LuaSocket TCP accept/receive loop, matching the approach
  another published BeamNG mod uses for its own local web endpoint. The UI
  app pushes a JSON snapshot into the server via
  `bngApi.engineLua('extensions.beamPlayServer.setData(...)')`; the server
  itself does no telemetry reading of its own, it only stores and re-serves
  that string, plus a tiny one-item command queue for the phone's
  "Reset trip" button.
