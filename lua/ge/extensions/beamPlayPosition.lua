-- BeamPlay live position stream.
--
-- Registers a custom stream (same mechanism BeamNG's own extensions use,
-- e.g. streams.registerStream) so the UI app can draw a simple live
-- breadcrumb-trail plot of the vehicle's recent world position, plus a
-- heading readout. This is NOT a road map: BeamNG does not expose route
-- or street data to mods, so there is no turn-by-turn navigation here --
-- just "where have I been and which way am I facing," computed from the
-- vehicle object's own position/direction.
--
-- Caveat: `getPosition()`/`getDirectionVector()` are the vehicle-object
-- methods this relies on. Unlike electrics/engineInfo (cross-checked
-- against two independently published BeamNG UI mods), this file's exact
-- method names are not independently verified against a real BeamNG
-- install from this environment. Every call is wrapped in pcall, so a
-- renamed/missing method degrades to `available = false` (the UI shows
-- "Position unavailable") instead of breaking the extension. If BeamNG
-- changes this API, fixing the two pcall'd calls below is the one thing
-- in this mod most likely to need an update.

local M = {}

local function getState()
  local vehOk, veh = pcall(function() return be and be:getPlayerVehicle(0) end)
  if not vehOk or not veh then
    return { available = false }
  end

  local posOk, pos = pcall(function() return veh:getPosition() end)
  local dirOk, dir = pcall(function() return veh:getDirectionVector() end)
  if not posOk or not dirOk or not pos or not dir then
    return { available = false }
  end

  local headingOk, headingDeg = pcall(function()
    local deg = math.deg(math.atan2(dir.x, dir.y))
    if deg < 0 then deg = deg + 360 end
    return deg
  end)

  return {
    available = true,
    x = pos.x,
    y = pos.y,
    heading = headingOk and headingDeg or nil
  }
end

M.getState = getState

M.onExtensionLoaded = function()
  if streams and streams.registerStream then
    streams.registerStream('beamPlayPosition', getState)
  end
end

return M
