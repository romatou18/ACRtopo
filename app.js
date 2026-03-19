/**
 * ARC Team Topo Finder - Main Application Script
 * -----------------------------------------------
 * Alpine Rescue Canterbury field tool for coordinate conversion, NZTM2000,
 * elevation (cached for offline), vector/bearing from GPS, and report generation.
 * Designed for use on mobile in remote NZ; load once at base, use offline in the field.
 *
 * Coordinate systems handled:
 *   - NZTM2000 (Easting/Northing) - New Zealand Transverse Mercator
 *   - DDD     - Decimal degrees (e.g. -43.54, 172.64)
 *   - DMS     - Degrees, minutes, seconds
 *   - DDM     - Degrees, decimal minutes
 *
 * Dependencies: none. Expects DOM elements (combinedInput, genBtn, reportContent, etc.).
 */

/** User-visible release label (Index.html help/header placeholders via data-app-version). */
const APP_VERSION_LABEL = "v1.2.1";
const ALT_CACHE_KEY = "arc_alt_cache";
const HISTORY_KEY = "arc_history_v2";
const HISTORY_MAX = 10;
/** Last CounterAPI value for debug footer (triple-logo); survives offline / failed refresh. */
const HIT_COUNT_CACHE_KEY = "arc_hit_count_debug";
const COUNTER_API_HITS_UP =
  "https://api.counterapi.dev/v1/arc-rescue-canterbury/hits/up";

/** Outmap web map zoom (their MapboxMap accepts query zoom 2–24). */
const OUTMAP_WEB_ZOOM = 24;
/** Google Play id — used for Android intent: to prefer native app over embedded browser. */
const OUTMAP_ANDROID_PKG = "com.fxd.Peaks";

/**
 * Build https://outmap.app/map/?lat=&lng=&zoom= (Mapbox center = [lng,lat] from query).
 *
 * Note: Outmap’s Nuxt map mounts before Pinia `defaultMapState` loads; when that arrives,
 * a `watch(mapCenter)` calls `flyTo` to the user’s saved default — which can override the
 * URL position (e.g. jump to Europe). We can’t fix that from here; Android intent may open
 * the native app and behave better; otherwise paste DDD into Outmap search or ask Outmap
 * to respect query until the user moves the map.
 */
function buildOutmapWebUrl(lat, lng, zoom = OUTMAP_WEB_ZOOM) {
  const latS = Number(lat).toFixed(6);
  const lngS = Number(lng).toFixed(6);
  return `https://outmap.app/map/?lat=${latS}&lng=${lngS}&zoom=${zoom}`;
}

/**
 * Android: try VIEW intent into Outmap app (same path/query); falls back to full https URL in Chrome.
 * Other platforms: return true so the anchor’s default navigation runs.
 */
function openOutmapLink(ev) {
  const a = ev?.currentTarget;
  if (!a?.href) return true;
  const httpsUrl = a.href;
  if (!/^https:\/\/outmap\.app\/map\//i.test(httpsUrl)) return true;
  const ua = navigator.userAgent || "";
  if (!/android/i.test(ua)) return true;
  if (typeof ev.preventDefault === "function") ev.preventDefault();
  try {
    const u = new URL(httpsUrl);
    const intent = `intent://${u.hostname}${u.pathname}${u.search}#Intent;scheme=https;package=${OUTMAP_ANDROID_PKG};action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
    window.location.href = intent;
  } catch (_) {
    window.open(httpsUrl, "_blank", "noopener,noreferrer");
  }
  return false;
}

/**
 * Features: Dynamic NZ-wide Declination Lookup & National Geofencing
 */

// =============================================================================
// NATIONAL NAVIGATION CONSTANTS
// =============================================================================

/** * NEW: Magnetic Declination Lookup Table (approximate for NZ regions)
 * The app selects the closest match based on Latitude.
 */
const NZ_DECLINATION_TABLE = [
  { latMax: -34.0, dec: 18.5, region: "Northland/Auckland" },
  { latMax: -38.0, dec: 20.0, region: "Central North Island" },
  { latMax: -41.0, dec: 21.5, region: "Wellington/Top of South" },
  { latMax: -43.0, dec: 23.5, region: "Canterbury/Westland" },
  { latMax: -45.0, dec: 24.5, region: "Otago/Southland" },
  { latMax: -46.5, dec: 25.5, region: "Fiordland/Stewart Is" },
];

/**
 * Helper to get declination for a specific latitude (southern hemisphere, negative lat).
 * Table rows are ordered north → south; each row's latMax is that band's southern edge.
 * Band i is (latMax of row i+1, latMax of row i], e.g. Canterbury is (-45, -43].
 */
function getDeclination(lat) {
  const fallback = { dec: 23.5, region: "Canterbury/Westland" };
  for (let i = 0; i < NZ_DECLINATION_TABLE.length; i++) {
    const zone = NZ_DECLINATION_TABLE[i];
    const southEdge =
      i + 1 < NZ_DECLINATION_TABLE.length
        ? NZ_DECLINATION_TABLE[i + 1].latMax
        : -Infinity;
    if (lat > southEdge && lat <= zone.latMax) {
      return zone;
    }
  }
  return fallback;
}

// --- TEAM ID PERSISTENCE ---
function saveTeamId() {
    const id = document.getElementById('teamIdInput').value.trim();
    // Save to localStorage so it's there after a reboot
    localStorage.setItem('arc_team_id', id.toUpperCase());
}

function loadTeamId() {
    const savedId = localStorage.getItem('arc_team_id');
    // Only populate if something was actually saved
    if (savedId && savedId !== "") {
        document.getElementById('teamIdInput').value = savedId;
    }
}

function applyAppVersionLabels() {
    document.querySelectorAll("[data-app-version]").forEach((el) => {
        el.textContent = APP_VERSION_LABEL;
    });
}

function onDomContentLoaded() {
    applyAppVersionLabels();
    loadTeamId();
}

window.addEventListener("DOMContentLoaded", onDomContentLoaded);

// =============================================================================
// GLOBAL STATE
// =============================================================================

/** Target coordinates from last successful parse (lat/lon in decimal degrees). */
let targetLat = null;
let targetLng = null;

/** Current device position from GPS (mobile only). Used for vector distance/bearing. */
let myLat = null;
let myLng = null;

/** Last reported GPS horizontal accuracy (m), for live vector widget. */
let lastGpsAccuracyM = null;

let liveVectorIntervalId = null;
/** Cached vector for compass arrow updates between 10s ticks. */
let liveVectorCachedVector = null;
let liveVectorCompassMode = false;
let liveVectorCompassHeading = null;
let liveVectorOrientationListenerAttached = false;
let liveVectorRafPending = false;

/** Refresh live vector UI on this interval (saves battery vs every GPS tick). */
const LIVE_VECTOR_INTERVAL_MS = 10000;

/** User closed the live vector bar; do not auto-reopen until the next successful report. */
let liveVectorUserDismissed = false;

/** Secret logo click counter for debug panel. */
let clickCount = 0;

// =============================================================================
// STORAGE KEYS & CONSTANTS (Altitude cache, History)
// =============================================================================


// -----------------------------------------------------------------------------
// Altitude cache (localStorage)
// Keys: "lat_lng" rounded to 4 decimals; values: altitude string e.g. "1234m (AMSL)".
// Allows offline display of elevation for previously fetched coordinates.
// -----------------------------------------------------------------------------

/** Build a cache key from lat/lon (4 decimals ≈ 11 m). */
function altCacheKey(lat, lng) {
  return `${Number(lat).toFixed(4)}_${Number(lng).toFixed(4)}`;
}

/** Get cached altitude string for a coordinate, or null if not cached. */
function getAltFromCache(lat, lng) {
  try {
    const raw = localStorage.getItem(ALT_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj[altCacheKey(lat, lng)] ?? null;
  } catch (e) {
    return null;
  }
}

/** Store altitude string for a coordinate (after successful API fetch). */
function setAltCache(lat, lng, altiStr) {
  try {
    const raw = localStorage.getItem(ALT_CACHE_KEY) || "{}";
    const obj = JSON.parse(raw);
    obj[altCacheKey(lat, lng)] = altiStr;
    localStorage.setItem(ALT_CACHE_KEY, JSON.stringify(obj));
  } catch (e) {}
}

// -----------------------------------------------------------------------------
// History (last N coordinates)
// Stored as array of { lat, lng, alti, ddd, originalInput }. originalInput
// keeps the exact user text (format) for display and restore.
// -----------------------------------------------------------------------------

function getHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

/** Add an entry to history; dedupe by same position (4-decimal key), keep last HISTORY_MAX. */
function addToHistory(newEntry) {
  let list = getHistory();
  const newKey = `${altCacheKey(newEntry.lat, newEntry.lng)}`;
  list = [newEntry].concat(
    list.filter((e) => `${altCacheKey(e.lat, e.lng)}` !== newKey),
  );
  list = list.slice(0, HISTORY_MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  renderHistory();
}

/** Escape string for safe use in HTML (content and attributes). */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render the history list in #historyList. Clicks handled by delegation on #historyList (reliable offline/mobile). */
function renderHistory() {
  const list = getHistory();
  const el = document.getElementById("historyList");
  if (!el) return;

  if (list.length === 0) {
    el.innerHTML =
      '<p class="text-slate-500 text-[10px] p-2">No history yet. Generate a report to add entries.</p>';
    return;
  }

  el.innerHTML = list
    .map((e, i) => {
      const displayCoords =
        e.originalInput ||
        e.ddd ||
        `${Number(e.lat).toFixed(6)}, ${Number(e.lng).toFixed(6)}`;
      const labelOneLine = displayCoords.replace(/\s+/g, " ").trim();
      const label = `${labelOneLine} — ${e.alti || "—"} — ${e.generatedTime}`;
      return `<button type="button" class="history-item text-left w-full p-2 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-[10px] font-mono text-slate-300 truncate" data-index="${i}" title="Tap to restore">${escapeHtml(label)}</button>`;
    })
    .join("");
}

/** Restore a history entry into the input and run report. Called from delegation or programmatically. */
function restoreHistoryEntry(index) {
  const list = getHistory();
  const entry = list[parseInt(index, 10)];
  if (!entry) return;
  const toRestore =
    entry.originalInput != null && entry.originalInput !== ""
      ? entry.originalInput
      : entry.ddd ||
        `${Number(entry.lat).toFixed(6)}, ${Number(entry.lng).toFixed(6)}`;
  const input = document.getElementById("combinedInput");
  if (input) {
    input.value = toRestore;
    input.removeAttribute("readonly");
    processCoordinates(entry);
  }
}

/** Attach one click listener to #historyList (event delegation). Survives re-renders and works offline/mobile. */
function setupHistoryDelegation() {
  const el = document.getElementById("historyList");
  if (!el) return;
  el.addEventListener("click", function (ev) {
    const btn =
      ev.target && ev.target.closest && ev.target.closest(".history-item");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    const idx = btn.getAttribute("data-index");
    if (idx != null) restoreHistoryEntry(idx);
  });
}

// =============================================================================
// NZTM2000 COORDINATE CONVERSION (GRS80 Ellipsoid)
// =============================================================================
//
// New Zealand Transverse Mercator 2000 (NZTM2000) is a projection used for
// official NZ mapping. Easting (E) and Northing (N) are in metres.
// Formulae below implement the inverse (E,N → lat,lon) and forward (lat,lon → E,N)
// using the standard Redfearn-type series expansions for the transverse Mercator.
//
// Reference: LINZ Standard for NZTM - GRS80 ellipsoid, central meridian 173°E,
// false easting 1,600,000 m, false northing 10,000,000 m, scale factor 0.9996.
// -----------------------------------------------------------------------------

const NZTM = {
  a: 6378137.0, // GRS80 semi-major axis (m)
  f: 1 / 298.257222101, // GRS80 flattening
  phizero: 0, // Origin latitude (not used in simplified formulae)
  lambdazero: 173.0, // Central meridian (degrees E)
  Nzero: 10000000, // False northing (m)
  Ezero: 1600000, // False easting (m)
  kzero: 0.9996, // Central meridian scale factor
};

/** Earth mean diameter in km (for Haversine distance). */
const EarthDiamKm = 12742;

/** Degrees to radians multiplier. */
const PI_div_180_deg = Math.PI / 180;

// -----------------------------------------------------------------------------
// New Zealand bounds and validation (for rescue ops: reject clearly wrong coords)
// -----------------------------------------------------------------------------
// National scope
// -    Dynamic Safety: In the South Island, you subtract ~24°. In the North Island, you subtract ~19°. The app now handles this transition automatically as teams move between regions or if a National IMT (Incident Management Team) is processing coordinates from different regions.
//-     Region Awareness: The report now explicitly states which declination value was used (e.g., "21.5°E Wellington declination"). This allows a navigator to cross-check the math against their physical Topo50 map sheet notes.
//-     National Geofence: The bounding box protects against data entry errors for the entire NZ Economic Zone, ensuring coordinates aren't accidentally processed for Australia or the Pacific.
/** Approximate mainland NZ + Chathams: lat/lon in decimal degrees. */
// Covers North Island, South Island, and immediate offshore islands
const NZ_BOUNDS = {
  latMin: -48.0,
  latMax: -34.0,
  lonMin: 164.0,
  lonMax: 179.5,
};

/** Christchurch (Canterbury) reference for "within 500 km" check. */
const CHRISTCHURCH = { lat: -43.5321, lon: 172.6362 };

/** Max distance (km) from Christchurch to consider coords plausible for this app. */
const MAX_DISTANCE_KM = 500;

/** Haversine distance between two points (km). */
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * PI_div_180_deg;
  const dLon = (lon2 - lon1) * PI_div_180_deg;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * PI_div_180_deg) *
      Math.cos(lat2 * PI_div_180_deg) *
      Math.sin(dLon / 2) ** 2;
  return EarthDiamKm * 0.5 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True if (lat, lon) is inside the NZ bounds. */
function isInNewZealand(lat, lon) {
  return (
    lat >= NZ_BOUNDS.latMin &&
    lat <= NZ_BOUNDS.latMax &&
    lon >= NZ_BOUNDS.lonMin &&
    lon <= NZ_BOUNDS.lonMax
  );
}

/** True if (lat, lon) is within maxKm of Christchurch. */
function isWithinRangeOfChristchurch(lat, lon, maxKm) {
  return (
    haversineKm(CHRISTCHURCH.lat, CHRISTCHURCH.lon, lat, lon) <=
    (maxKm ?? MAX_DISTANCE_KM)
  );
}

/**
 * Validate coords for rescue use: must be in NZ and within MAX_DISTANCE_KM of Christchurch.
 * @returns {{ ok: boolean, message?: string }}
 */
function validateCoordinates(lat, lon) {
  if (!isInNewZealand(lat, lon)) {
    return {
      ok: false,
      message:
        "Coordinates are outside New Zealand. Check the pasted text (e.g. extra text from a message).",
    };
  }
  if (!isWithinRangeOfChristchurch(lat, lon)) {
    const km = Math.round(
      haversineKm(CHRISTCHURCH.lat, CHRISTCHURCH.lon, lat, lon),
    );
    return {
      ok: false,
      message: `Coordinates are ${km} km from Christchurch (>${MAX_DISTANCE_KM} km). Likely wrong or from another region — check the pasted text.`,
    };
  }
  return { ok: true };
}

/**
 * Initial bearing/distance from your position to the target (great-circle).
 * Declination is taken at the target latitude (same as the printed report).
 * @returns {{ distKm: string, gridBearing: number, magneticBearing: number, dec: number, region: string } | null}
 */
function computeGpsVectorToTarget(fromLat, fromLng, toLat, toLng) {
  if (
    fromLat == null ||
    fromLng == null ||
    toLat == null ||
    toLng == null
  ) {
    return null;
  }
  const declinationData = getDeclination(toLat);
  const currentMagDec = declinationData.dec;
  const dLat = (toLat - fromLat) * PI_div_180_deg;
  const dLon = (toLng - fromLng) * PI_div_180_deg;
  const a_v =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(fromLat * PI_div_180_deg) *
      Math.cos(toLat * PI_div_180_deg) *
      Math.sin(dLon / 2) ** 2;
  const distKm = (
    EarthDiamKm * Math.atan2(Math.sqrt(a_v), Math.sqrt(1 - a_v))
  ).toFixed(2);
  const y_v = Math.sin(dLon) * Math.cos(toLat * PI_div_180_deg);
  const x_v =
    Math.cos(fromLat * PI_div_180_deg) * Math.sin(toLat * PI_div_180_deg) -
    Math.sin(fromLat * PI_div_180_deg) *
      Math.cos(toLat * PI_div_180_deg) *
      Math.cos(dLon);
  const gridBearing = ((Math.atan2(y_v, x_v) * 180) / Math.PI + 360) % 360;
  const magneticBearing = (gridBearing - currentMagDec + 360) % 360;
  return {
    distKm,
    gridBearing,
    magneticBearing,
    dec: currentMagDec,
    region: declinationData.region,
  };
}

/**
 * Convert NZTM2000 Easting and Northing to WGS84 latitude and longitude (decimal degrees).
 *
 * HIGH-LEVEL MATH
 * ---------------
 * Inverse Transverse Mercator: given projected (E, N) in metres, find (φ, λ) on the
 * ellipsoid. The forward TM gives N = N₀ + k₀·(M(φ) + …) and E = E₀ + k₀·(…). Inversion:
 *
 * 1. Recover meridian arc and easting offset:
 *      M = (N − N₀) / k₀,    Eₜ = E − E₀.
 *
 * 2. Footpoint latitude φ': the latitude whose meridian arc is M; i.e. M(φ') = M.
 *    Solve by series: φ' = σ + B·sin(2σ) + C·sin(4σ) + D·sin(6σ), with σ = M/A.
 *    (A is the first-term coefficient from the forward M(φ) series.)
 *
 * 3. At φ' compute ν, ρ, ψ = ν/ρ, t = tan φ'. Then:
 *      φ = φ' − (t·Eₜ²)/(2·ρ·ν·k₀²) + (t·Eₜ⁴)/(24·ρ·ν³·k₀⁴)·(5 + 3t² + 8ψ − 4ψ² − 9ψt²) + …
 *      λ = λ₀ + (Eₜ)/(ν·k₀·cos φ') − (Eₜ³)/(6·ν³·k₀³·cos φ')·(ψ + 2t²) + …
 *
 * So latitude is footpoint minus a series in Eₜ², Eₜ⁴; longitude is λ₀ plus a series in Eₜ, Eₜ³.
 *
 * STEPS
 * --------------------------
 * 1. Ellipsoid constants: e², third flattening n, semi-major axis a.
 * 2. Meridian arc from northing: M = (N − N₀)/k₀. Coefficient A for σ = M/A; then
 *    footpoint φ' = σ + B·sin(2σ) + C·sin(4σ) + D·sin(6σ) (coefficients in n).
 * 3. At φ': compute ρ, ν, ψ = ν/ρ, t = tan φ', Eₜ = E − E₀.
 * 4. Latitude: φ = φ' − Eₜ² term + Eₜ⁴ term; convert to degrees.
 * 5. Longitude: λ = λ₀ + Eₜ term − Eₜ³ term; convert to degrees.
 * 6. Return { lat: φ°, lon: λ° }.
 *
 * @param {number} E - Easting (metres)
 * @param {number} N - Northing (metres)
 * @returns {{ lat: number, lon: number }} - Latitude and longitude in decimal degrees
 */
function nztmToLatLon(E, N) {
  const esq = 2 * NZTM.f - NZTM.f ** 2;
  const n = NZTM.f / (2 - NZTM.f);
  const a = NZTM.a;

  // -------------------------------------------------------------------------
  // Step 2: Recover meridian arc M from northing; then footpoint latitude φ'.
  // M = (N - N₀)/k₀ is the distance along the ellipsoid from equator to the
  // footpoint. We solve φ' from M(φ') = M using the inverse series.
  // -------------------------------------------------------------------------
  // A = first-term coefficient in M(φ) = A·σ + … so that σ ≈ M/A (radians).
  //    a·(1−n)·(1−n²) times the φ-coefficient (1 + n²/4 + n⁴/64 + …) → 1 - n + (5/4)(n²−n³) + (81/64)(n⁴−n⁵).
  const M = (N - NZTM.Nzero) / NZTM.kzero;
  const A =
    a * (1 - n + (5 / 4) * (n ** 2 - n ** 3) + (81 / 64) * (n ** 4 - n ** 5));
  const sigma = M / A;
  // φ' = σ + B·sin(2σ) + C·sin(4σ) + D·sin(6σ). Coefficients (in n) from inverse
  // meridian arc series: B = 3n/2 − 27n³/32, C = 21n²/16 − 55n⁴/32, D = 151n³/96.
  const phip =
    sigma +
    ((3 * n) / 2 - (27 * n ** 3) / 32) * Math.sin(2 * sigma) +
    ((21 * n ** 2) / 16 - (55 * n ** 4) / 32) * Math.sin(4 * sigma) +
    ((151 * n ** 3) / 96) * Math.sin(6 * sigma);

  // -------------------------------------------------------------------------
  // Step 3: At footpoint φ', compute radii of curvature and auxiliaries.
  // Eₜ = easting offset from central meridian (metres).
  // -------------------------------------------------------------------------
  const sin_p = Math.sin(phip),
    cos_p = Math.cos(phip),
    tan_p = Math.tan(phip);
  const rho = (a * (1 - esq)) / Math.pow(1 - esq * sin_p ** 2, 1.5);
  const nu = a / Math.sqrt(1 - esq * sin_p ** 2);
  const psi = nu / rho,
    t = tan_p,
    Et = E - NZTM.Ezero;

  // -------------------------------------------------------------------------
  // Step 4: Latitude φ = φ' − (Eₜ² term) + (Eₜ⁴ term).
  // Eₜ²: (t·Eₜ²)/(2·ρ·ν·k₀²) — main parabolic correction from easting.
  // Eₜ⁴: (t·Eₜ⁴)/(24·ρ·ν³·k₀⁴)·(5 + 3t² + 8ψ − 4ψ² − 9ψt²) — ellipsoid correction.
  // -------------------------------------------------------------------------
  const latTerm1 = (t * Et ** 2) / (2 * rho * nu * NZTM.kzero ** 2);
  const latTerm2 =
    ((t * Et ** 4) / (24 * rho * nu ** 3 * NZTM.kzero ** 4)) *
    (5 + 3 * t ** 2 + 8 * psi - 4 * psi ** 2 - 9 * psi * t ** 2);
  const lat = ((phip - latTerm1 + latTerm2) * 180) / Math.PI;

  // -------------------------------------------------------------------------
  // Step 5: Longitude λ = λ₀ + (Eₜ term) − (Eₜ³ term).
  // Eₜ term: Eₜ/(ν·k₀·cos φ') — arc-to-angle along parallel at φ'.
  // Eₜ³ term: (Eₜ³)/(6·ν³·k₀³·cos φ')·(ψ + 2t²) — cubic correction for conformality.
  // -------------------------------------------------------------------------
  const lonTerm1 = Et / (nu * NZTM.kzero * cos_p);
  const lonTerm2 =
    (Et ** 3 / (6 * nu ** 3 * NZTM.kzero ** 3 * cos_p)) * (psi + 2 * t ** 2);
  const lon = NZTM.lambdazero + ((lonTerm1 - lonTerm2) * 180) / Math.PI;

  return { lat, lon };
}

/**
 * Convert WGS84 latitude and longitude (decimal degrees) to NZTM2000 Easting and Northing.
 *
 * HIGH-LEVEL MATH
 * ---------------
 * Transverse Mercator (TM) projects the ellipsoid onto a cylinder tangent along a
 * central meridian λ₀. Easting E and Northing N are:
 *
 *   E = E₀ + k₀ · [ ν·cos φ · (w + w³/6·(ψ − t²) + …) ]
 *   N = N₀ + k₀ · [ M(φ) + ν·tan φ·cos² φ · (w²/2 + w⁴/24·(5−t²+9ψ+4ψ²) + …) ]
 *
 * where:
 *   φ, λ = lat/lon (radians);  w = λ − λ₀  (longitude from central meridian)
 *   M(φ) = meridian arc from equator to φ
 *   ν = radius of curvature (prime vertical), ρ = radius (meridian), ψ = ν/ρ, t = tan φ
 *   E₀ = 1,600,000 m, N₀ = 10,000,000 m, k₀ = 0.9996  (NZTM2000 constants)
 *
 * STEPS
 * --------------------------
 * 1. Convert lat, lon to radians (φ, λ); define w = λ − λ₀.
 * 2. Compute ellipsoid auxiliaries: e², ν(φ), ρ(φ), ψ = ν/ρ, t = tan φ.
 * 3. Compute third flattening n and meridian arc M(φ) (series in φ, sin 2φ, sin 4φ).
 * 4. Northing: N = N₀ + k₀ · (M + ν·t·cos² φ·w²/2 + ν·t·cos⁴ φ·w⁴/24·(5−t²+9ψ+4ψ²)).
 * 5. Easting:  E = E₀ + k₀ · (ν·cos φ·w + ν·cos³ φ·w³/6·(ψ−t²)).
 * 6. Return { e: round(E), n: round(N) } in metres.
 *
 * @param {number} lat - Latitude (decimal degrees)
 * @param {number} lon - Longitude (decimal degrees)
 * @returns {{ e: number, n: number }} - Easting and Northing in metres (rounded)
 */
function latLonToNZTM(lat, lon) {
  const phi = lat * PI_div_180_deg;
  const lam = lon * PI_div_180_deg;
  const lam0 = NZTM.lambdazero * PI_div_180_deg;
  const esq = 2 * NZTM.f - NZTM.f ** 2;
  const a = NZTM.a;

  // Radius of curvature in the prime vertical (perpendicular to meridian), metres.
  const nu = a / Math.sqrt(1 - esq * Math.sin(phi) ** 2);
  // Radius of curvature in the meridian (along the meridian), metres.
  const rho = (a * (1 - esq)) / Math.pow(1 - esq * Math.sin(phi) ** 2, 1.5);
  const psi = nu / rho; // Ratio used in TM series (often written as η² or similar).
  const t = Math.tan(phi); // Tangent of latitude (recurring in TM formulae).
  const w = lam - lam0; // Longitude difference from central meridian (radians).

  // Semi-minor axis (metres). Third flattening n = (a-b)/(a+b) is used in
  // the meridian-arc series instead of f; it gives simpler coefficients.
  const b = a * (1 - NZTM.f);
  const n = (a - b) / (a + b);

  // -------------------------------------------------------------------------
  // Meridian arc M(φ): distance along the ellipsoid from equator to latitude φ.
  // Formula: M = a * (1-n) * (1-n²) * [ A*φ - B*sin(2φ) + C*sin(4φ) ] (metres).
  // The coefficients A, B, C come from the series expansion of the elliptic
  // integral for meridian arc (e.g. Redfearn / Karney / USGS conventions).
  // -------------------------------------------------------------------------
  //   a * (1-n) * (1-n²)  — scale factor from ellipsoid geometry (n = third flattening).
  //   A = 1 + 9/4*n² + 225/64*n⁴  — coefficient of φ (φ in radians). Higher powers of n
  //       (e.g. n⁶) are negligible for GRS80; 9/4 and 225/64 are the standard series terms.
  //   B = 3/2*n - 27/32*n³  — coefficient of sin(2φ). Corrects for ellipticity in the
  //       first harmonic; 27/32 is the n³ term in the expansion.
  //   C = 15/16*n² - 105/128*n⁴  — coefficient of sin(4φ). Second harmonic; 105/128 is the n⁴ term.
  // Terms in sin(6φ), sin(8φ), ... are omitted (order < 1 mm for NZ latitudes).
  // -------------------------------------------------------------------------
  const M =
    a *
    (1 - n) *
    (1 - n ** 2) *
    ((1 + (9 / 4) * n ** 2 + (225 / 64) * n ** 4) * phi -
      ((3 / 2) * n - (27 / 32) * n ** 3) * Math.sin(2 * phi) +
      ((15 / 16) * n ** 2 - (105 / 128) * n ** 4) * Math.sin(4 * phi));

  // -------------------------------------------------------------------------
  // Northing N (metres). Formula: N = Nzero + k0 * ( M + ΔN ).
  // Nzero = 10,000,000 m (false northing). k0 = 0.9996 (scale on central meridian).
  // ΔN is the transverse Mercator series giving the northward offset from the
  // meridian arc M when we move east/west by angle w. It is a series in w², w⁴, ...
  // -------------------------------------------------------------------------
  //   ΔN ≈ (ν·tan φ·cos² φ) · [ w²/2  +  w⁴/24 · (5 - t² + 9ψ + 4ψ²)  +  O(w⁶) ]
  //
  //   w² term:  ν·t·cos²(φ)·w²/2
  //       — main parabolic correction for moving off the central meridian; 1/2 is from
  //         the Taylor expansion of the TM projection in longitude.
  //
  //   w⁴ term:  ν·t·cos⁴(φ)·w⁴/24 · (5 - t² + 9·ψ + 4·ψ²)
  //       — 1/24: next coefficient in the series (fourth order in w).
  //       — (5 - t² + 9·ψ + 4·ψ²): ellipsoid correction; t = tan φ, ψ = ν/ρ. These
  //         terms keep the projection conformal and accurate to millimetres.
  // -------------------------------------------------------------------------
  const N =
    NZTM.Nzero +
    NZTM.kzero *
      (M +
        nu * t * Math.cos(phi) ** 2 * (w ** 2 / 2) +
        nu *
          t *
          Math.pow(Math.cos(phi), 4) *
          (w ** 4 / 24) *
          (5 - t ** 2 + 9 * psi + 4 * psi ** 2));

  // -------------------------------------------------------------------------
  // Easting E (metres). Formula: E = Ezero + k0 * ΔE.
  // Ezero = 1,600,000 m (false easting). k0 = 0.9996.
  // ΔE is the transverse Mercator series giving the eastward distance from the
  // central meridian for longitude difference w. Series in w, w³, ...
  // -------------------------------------------------------------------------
  //   ΔE ≈ (ν·cos φ) · [ w  +  w³/6 · (ψ - t²)  +  O(w⁵) ]
  //
  //   w term:  ν·cos(φ)·w
  //       — arc length along the parallel at this latitude; ν·cos φ is the radius
  //         of the parallel (converted to metres), w is longitude in radians.
  //
  //   w³ term:  ν·cos³(φ)·w³/6 · (ψ - t²)
  //       — 1/6: third-order series coefficient (from Taylor expansion of TM).
  //       — (ψ - t²): ellipsoid correction (ψ = ν/ρ, t = tan φ) for conformality.
  // -------------------------------------------------------------------------
  const E =
    NZTM.Ezero +
    NZTM.kzero *
      (nu * Math.cos(phi) * w +
        nu * Math.pow(Math.cos(phi), 3) * (w ** 3 / 6) * (psi - t ** 2));

  return { e: Math.round(E), n: Math.round(N) };
}

/**
 * Get the NZ Topo50 map sheet code (e.g. "BX24") from NZTM E/N.
 * Used for radio grid references. Grid is based on 24 km × 36 km cells.
 *
 * @param {number} e - Easting (m)
 * @param {number} n - Northing (m)
 * @returns {string} - Sheet code e.g. "BX24"
 */
function getTopo50Sheet(e, n) {
  const rows = [
    "AS",
    "AT",
    "AU",
    "AV",
    "AW",
    "AX",
    "AY",
    "AZ",
    "BA",
    "BB",
    "BC",
    "BD",
    "BE",
    "BF",
    "BG",
    "BH",
    "BI",
    "BJ",
    "BK",
    "BL",
    "BM",
    "BN",
    "BO",
    "BP",
    "BQ",
    "BR",
    "BS",
    "BT",
    "BU",
    "BV",
    "BW",
    "BX",
    "BY",
    "BZ",
    "CA",
    "CB",
    "CC",
    "CD",
  ];
  const rowIdx = Math.floor((6000000 - n) / 36000);
  const colIdx = Math.floor((e - 1000000) / 24000) + 1;
  const rowLetter = rows[rowIdx] || "??";
  const colNumber = colIdx.toString().padStart(2, "0");
  return `${rowLetter}${colNumber}`;
}

// =============================================================================
// INPUT EXTRACTION (noisy paste from WhatsApp, etc.)
// =============================================================================
//
// When the user pastes a full line, coordinates may be in the middle of text.
// We try to extract a substring that looks like NZTM, DDD, or DMS/DDM and parse that.
// -----------------------------------------------------------------------------

function categorizeCoordinates(inputText) {
  // Regex with Named Capturing Groups for each format
  const regex =
    /(?<DDD>-?\d{1,3}\.\d+,\s*-?[\d\.]+)|(?<DMS>[NSEW]\d{1,3}°\d{1,2}'\d{1,2},?\s*[NSEW]\d{1,3}°\d{1,2}'\d{1,2})|(?<DDM>[NSEW]\d{1,3}\s\d{1,2}\.\d+[NSEW]?,\s*[NSEW]\d{1,3}\s\d{1,2}\.\d+)|(?<NZTM>\b(?:E?\s*)\d{7},\s*(?:N?\s*)\d{7}\b)/gi;

  const results = [];
  let match;

  // Iterate through all matches in the text
  while ((match = regex.exec(inputText)) !== null) {
    // Find which named group was triggered
    const type = Object.keys(match.groups).find(
      (key) => match.groups[key] !== undefined,
    );

    results.push({
      type: type,
      value: match[0].trim(),
    });
  }

  return results;
}

/** Normalize pasted text: trim, collapse whitespace and newlines. */
function normalizeInput(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract and parse coordinates from noisy input. Tries each candidate until one parses.
 * @returns {{ cleaned: string, result: { lat: number, lon: number } | null }}
 */
function extractAndParseCoords(rawUnfilteredText) {
  const trimmed = (
    typeof rawUnfilteredText === "string" ? rawUnfilteredText : ""
  ).trim();
  if (!trimmed) return { cleaned: "", result: null };

  const foundCoords = categorizeCoordinates(rawUnfilteredText);

  for (const f of foundCoords) {
    if (f.type === "NZTM") {
      const result = flexibleParse(f.value);
      if (result != null) return { cleaned: f.value, result };
    }

    if (f.type === "DDD") {
      const result = flexibleParse(f.value);
      if (result != null) return { cleaned: f.value, result };
    }
    if (f.type === "DMS") {
      const result = flexibleParse(f.value);
      if (result != null) return { cleaned: f.value, result };
    }
    if (f.type === "DDM") {
      const result = flexibleParse(f.value);
      if (result != null) return { cleaned: f.value, result };
    }
  }

  return { cleaned: trimmed, result: null };
}

// =============================================================================
// COORDINATE INPUT PARSER (flexible format)
// =============================================================================
//
// Accepts:
//   - NZTM: two large numbers (E > 900000) → nztmToLatLon
//   - DDD:  two decimals e.g. -43.54, 172.64
//   - DMS/DDM: text split in the middle; first half → latitude (degrees, [minutes], [seconds]);
//              second half → longitude. Sign from presence of S/W or minus.
// -----------------------------------------------------------------------------

/**
 * Parse user input into { lat, lon } (decimal degrees).
 * Handles NZTM (two large numbers), DDD (two decimals), or DMS/DDM by splitting
 * the string in the middle and interpreting each half as lat or lon with optional
 * degrees, minutes, seconds (or decimal minutes).
 *
 * @param {string} input - Raw user input (any supported format)
 * @returns {{ lat: number, lon: number } | null} - Parsed coordinates or null if invalid
 */

/**
 * Extracts: NZTM, DDD, DDM, DMS
 * Handles: Symbols (°, ', "), Messy Spaces, and WhatsApp text.
 * 1. Matches NZTM, DMS, DDM, or DDD within noisy text.
 * 2. Extracts coordinate segments based on numeric blocks.
 * 3. Handles symbols (°, ', ") and auto-swaps NZTM.
 *
 * ARC National Parser V6.7 - Capture-Group Edition
 * Uses your specific DMS/DDM logic modified for direct match extraction.
 */
/**
 * ARC National Parser V6.8 - Explicit DDM/DMS Edition
 * Specifically handles Forward/Reverse DDM and DMS via direct Regex Matching.
 */
function flexibleParse(input) {
    if (!input) return null;

    // --- 1. NZTM 2000 (Grid) ---
    const nztmMatch = input.match(
        /\b(?:[Ee]\s*)?(\d{6,7})\b[,\s/]+\b(?:[Nn]\s*)?(\d{6,7})\b/,
    );
    if (nztmMatch) {
        let e = parseFloat(nztmMatch[1]), n = parseFloat(nztmMatch[2]);
        let swapped = false;
        let original = ''
        if (e > 3000000) { 
          [e, n] = [n, e]; 
          swapped = true; 
          original = nztmMatch[2] + ', ' + nztmMatch[1]
        } else {
          original = nztmMatch[1] + ', ' + nztmMatch[2]
        }
        if (e > 1000000 && e < 2100000 && n > 4700000 && n < 6200000) {
            const c = nztmToLatLon(e, n);
            return { ...c, swapped: swapped, coords: original};
        }
    }

    // --- 2. REGEX PATTERN FRAGMENTS ---
    // Groups: 1:Sign, 2:Degrees, 3:Minutes(Decimal), 4:Sign
    const latDDM = /([NS+-]?)\s*(\d{1,2})(?:°|:|\s)\s*(\d{1,2}(?:\.\d+)?)(?:'|\s)?\s*/i;
    const lonDDM = /([EW+-]?)\s*(\d{1,3})(?:°|:|\s)\s*(\d{1,2}(?:\.\d+)?)(?:'|\s)?\s*/i;

    // Groups: 1:Sign, 2:Deg, 3:Min, 4:Sec(Decimal), 5:Sign
    const latDMS = /([NS+-]?)\s*(\d{1,2})(?:°|:|\s)\s*(\d{1,2})(?:'|:|\s)\s*(\d{1,2}(?:\.\d+)?)\"?\s*/i;
    const lonDMS = /([EW+-]?)\s*(\d{1,3})(?:°|:|\s)\s*(\d{1,2})(?:'|:|\s)\s*(\d{1,2}(?:\.\d+)?)\"?\s*/i;

    //Constructing pairs.
    const ddmPair = /([NS+-]?)\s*(\d{1,2})(?:°|:|\s)\s*(\d{1,2}(?:\.\d+)?)(?:'|\s)?\s*(?:,|\s)\s*([EW+-]?)(\d{1,3})(?:°|:|\s)\s*(\d{1,2}(?:\.\d+)?)(?:'|\s)?\s*/i;
    // Require E/W on the lon-first half so we never treat "43 32…" inside "S43 32…" as DDM-rev.
    const ddmRev =
        /([EW])\s*(\d{1,3})(?:°|:|\s)\s*(\d{1,2}(?:\.\d+)?)(?:'|\s)?\s*(?:,|\s)\s*([NS+-]?)(\d{1,2})(?:°|:|\s)\s*(\d{1,2}(?:\.\d+)?)(?:'|\s)?\s*/i;

    const dmsPair = /([NS+-]?)\s*(\d{1,2})(?:°|:|\s)\s*(\d{1,2})(?:'|:|\s)\s*(\d{1,2}(?:\.\d+)?)\"?\s*(?:,|\s)\s*([EW+-]?)\s*(\d{1,3})(?:°|:|\s)\s*(\d{1,2})(?:'|:|\s)\s*(\d{1,2}(?:\.\d+)?)\"?\s*/i;
     const dmsRev = /([EW+-]?)\s*(\d{1,3})(?:°|:|\s)\s*(\d{1,2})(?:'|:|\s)\s*(\d{1,2}(?:\.\d+)?)\"?\s*(?:,|\s)\s*([NS+-]?)\s*(\d{1,2})(?:°|:|\s)\s*(\d{1,2})(?:'|:|\s)\s*(\d{1,2}(?:\.\d+)?)\"?\s*/i;
    // Trailing \\b after each number stops "175.2" from matching as "17" + "5.2".
    // Do not put \\b before optional minus or southern latitudes break.
    const reverseDddPair =
        /(-?\d{1,3}(?:\.\d+)?)\b\s*[,\s/|;]+\s*(-?\d{1,2}(?:\.\d+)?)\b/;
    const dddPair =
        /(-?\d{1,2}(?:\.\d+)?)\b\s*[,\s/|;]+\s*(-?\d{1,3}(?:\.\d+)?)\b/;

    // --- 4. EXECUTE & EXTRACT ---
    let m;

    // CASE: DDM FORWARD
    if ((m = input.match(ddmPair))) {
        const lat = calcDDM(m[2], m[3], m[1]);
        const lon = calcDDM(m[5], m[6], m[4]);
        return { lat, lon, swapped: false, coords: m[0] };
    }
    // CASE: DDM REVERSE
    if ((m = input.match(ddmRev))) {
        const lon = calcDDM(m[2], m[3], m[1]);
        const lat = calcDDM(m[5], m[6], m[4]);
        return { lat, lon, swapped: true, coords: lat + ',' + lon  };
    }
    // CASE: DMS FORWARD
    if ((m = input.match(dmsPair))) {
        const lat = calcDMS(m[2], m[3], m[4], m[1]);
        const lon = calcDMS(m[6], m[7], m[8], m[5]);
        return { lat, lon, swapped: false, coords: m[0]  };
    }
    // CASE: DMS REVERSE
    if ((m = input.match(dmsRev))) {
        const lon = calcDMS(m[2], m[3], m[4], m[1]);
        const lat = calcDMS(m[6], m[7], m[8], m[5]);
        return { lat, lon, swapped: true, coords: lat + ',' + lon };
    }

    // CASE: DDD important keep these 2 if in sequence orderered
    if ((m = input.match(reverseDddPair))) {
        return { lat: parseFloat(m[2]), lon: parseFloat(m[1]), swapped: true, coords:m[0]};
    }
    if ((m = input.match(dddPair))) {
        return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), swapped: false, coords: m[0]};
    }


    return null;
}

/** * Direct Array Value Calculations (No complex logic)
 */
function calcDDM(d, m, s1) {
    let val = parseFloat(d) + (parseFloat(m) / 60);
    if (/[S-]/i.test(s1 || "") || /[W-]/i.test(s1 || "")) val = -val;
    return val;
}

function calcDMS(d, m, s, s1) {
    let val = parseFloat(d) + (parseFloat(m) / 60) + (parseFloat(s) / 3600);
    if (/[S-]/i.test(s1 || "") || /[W-]/i.test(s1 || "")) val = -val;
    return val;
}

/**
 * ARC Offline Solar Engine
 * Calculates Civil Sunrise/Sunset for NZ locations without API access.
 */
function getSunTimes(lat, lng) {
    const now = new Date();
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const zenith = 90.833; // Standard sunrise/sunset zenith
    const D2R = Math.PI / 180;
    const R2D = 180 / Math.PI;

    // 1. Calculate approximate time
    const lnHour = lng / 15;
    const tRise = dayOfYear + ((6 - lnHour) / 24);
    const tSet = dayOfYear + ((18 - lnHour) / 24);

    const compute = (t, isSunrise) => {
        // Mean anomaly
        const M = (0.9856 * t) - 3.289;
        // True longitude
        let L = M + (1.916 * Math.sin(M * D2R)) + (0.020 * Math.sin(2 * M * D2R)) + 282.634;
        L = (L + 360) % 360;
        // Right ascension
        let RA = R2D * Math.atan(0.91764 * Math.tan(L * D2R));
        RA = (RA + 360) % 360;
        // Adjust quadrant
        const Lquad = Math.floor(L / 90) * 90;
        const RAquad = Math.floor(RA / 90) * 90;
        RA = (RA + (Lquad - RAquad)) / 15;
        // Declination
        const sinDec = 0.39782 * Math.sin(L * D2R);
        const cosDec = Math.cos(Math.asin(sinDec));
        // Local hour angle
        const cosH = (Math.cos(zenith * D2R) - (sinDec * Math.sin(lat * D2R))) / (cosDec * Math.cos(lat * D2R));
        
        if (cosH > 1) return "Always Night";
        if (cosH < -1) return "Always Day";

        const H = (isSunrise ? 360 - R2D * Math.acos(cosH) : R2D * Math.acos(cosH)) / 15;
        const T = H + RA - (0.06571 * t) - 6.622;
        let UT = (T - lnHour + 24) % 24;

        // Convert UT to NZ Time (Standard +12, or use Date offset for DST)
        // Note: New Zealand is UTC+12 (Standard) or UTC+13 (Daylight Savings)
        const tzOffset = -now.getTimezoneOffset() / 60;
        const localTime = (UT + tzOffset + 24) % 24;

        const h = Math.floor(localTime);
        const m = Math.round((localTime - h) * 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    };

    return {
        sunrise: compute(tRise, true),
        sunset: compute(tSet, false)
    };
}

// =============================================================================
// MAIN PROCESSOR & REPORT GENERATOR
// =============================================================================

/**
 * Parse input, compute NZTM/sheet/ref, optional vector from GPS, altitude (cache or API),
 * build report text and map links, update DOM and history.
 */

async function processCoordinates(historyEntry) {
  const btn = document.getElementById("genBtn");
  const inputEl = document.getElementById("combinedInput");
  if (!inputEl) return;

  const teamIdValue = document.getElementById('teamIdInput').value.trim();
  const parseRes = flexibleParse(document.getElementById('combinedInput').value);

  if (!parseRes) {
    alert("❌ ERROR: Could not detect valid coordinates.\n\nAccepted formats:\n- NZTM (e.g. 1571000 5178500)\n- DDD (e.g. -43.54, 172.64)\n- DDM (e.g. S43° 32.4', E172° 38.4') - DMS: S43°32'24\", E172°38'24\"");
    return;
  }

  if (parseRes.swapped) {
        alert("⚠️ COORDINATE SWAP DETECTED\n\nThe input appeared to be 'Northing before Easting' or 'Longitude before Latitude'. The app has corrected this for the report.");
    }

  targetLat = parseRes.lat;
  targetLng = parseRes.lon;

  // 1. Determine Header Title based on Team ID presence
  let reportHeader = "";
  if (teamIdValue !== "") {
      reportHeader = `LANDSAR NZ LOCATION REPORT\nTEAM ID : ${teamIdValue.toUpperCase()}\n`;
  } else {
      reportHeader = `NZ LOCATION REPORT\n`;
  }

  // 2. Navigation & Safety Logic
  const decData = getDeclination(targetLat);
  const isInsideNZ = (targetLat >= -48 && targetLat <= -34 && targetLng >= 164 && targetLng <= 179.5);

  let rawInput;
  let timeGenerated;
  if (historyEntry) {
    rawInput = historyEntry.originalInput;
    timeGenerated = historyEntry.generatedTime;
  } else {
    rawInput = inputEl.value.trim();
    const timeStr = new Date().toLocaleString("en-NZ", {
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    // Splits "02/03/26, 18:04:31" into ["02/03/26", "18:04:31"] and reverses it
    const flipped = timeStr.split(", ").reverse().join(",");
    timeGenerated = flipped;
  }

  try {
    if (btn) btn.innerText = "Processing...";

    let validationWarning = "";
    const isInsideNZ =
      targetLat >= NZ_BOUNDS.latMin &&
      targetLat <= NZ_BOUNDS.latMax &&
      targetLng >= NZ_BOUNDS.lonMin &&
      targetLng <= NZ_BOUNDS.lonMax;
    if (!isInsideNZ) {
      validationWarning =
        "⚠️ WARNING: COORDINATES ARE OUTSIDE NEW ZEALAND BOUNDS.\n";
    }
    const swapNotice = parseRes.swapped
      ? "⚠️ ALERT: Grid Northing/Easting were swapped automatically.\n"
      : "";

    // CHANGE: Capture the swap flag
    const cleanedParsedInput = parseRes.coords


    // If we extracted from noisy text, show what we used (optional: replace field so user sees)
    if (
      cleanedParsedInput &&
      cleanedParsedInput !== rawInput &&
      cleanedParsedInput.length < rawInput.length
    ) {
      inputEl.value = cleanedParsedInput;
    }

    const validation = validateCoordinates(targetLat, targetLng);
    if (isInsideNZ)
      validationWarning = validation.ok
        ? ""
        : `\n⚠️ CHECK suspicious values: ${validation.message}\n`;

    if (!validation.ok && typeof alert === "function") {
      alert(
        validation.message +
          "\n\n⚠️Report will still be shown — please check the coordinates, however might be incorrect!",
      );
    }

    const nztm = latLonToNZTM(targetLat, targetLng);
    const topoSheet = getTopo50Sheet(nztm.e, nztm.n);
    const gridRefE = Math.floor((nztm.e % 100000) / 100)
      .toString()
      .padStart(3, "0");
    const gridRefNorth = Math.floor((nztm.n % 100000) / 100)
      .toString()
      .padStart(3, "0");

    // Vector (distance + bearing) from current GPS position to target
    let vectorReport = "VECTOR: No GPS lock (No vector generated)";
    const vecForReport = computeGpsVectorToTarget(
      myLat,
      myLng,
      targetLat,
      targetLng,
    );
    if (vecForReport) {
      vectorReport = `VECTOR: ${vecForReport.distKm}km from you\nBearing: ${Math.round(vecForReport.gridBearing)}°(Grid) | ${Math.round(vecForReport.magneticBearing)}°(Mag)\n(${vecForReport.dec}°E ${vecForReport.region} declination (offset for compass use))`;
    }

    // Altitude: use cache first (offline); else fetch with timeout so we don't hang when offline
    let alti = historyEntry
      ? historyEntry.alti
      : getAltFromCache(targetLat, targetLng);
    if (alti == null) {
      alti = "Checking...";
      try {
        const url = `https://api.open-meteo.com/v1/elevation?latitude=${targetLat}&longitude=${targetLng}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        const data = await r.json();
        alti = data.elevation
          ? `${Math.round(data.elevation[0])}m`
          : "Not found";
        setAltCache(targetLat, targetLng, alti);
      } catch (e) {
        alti = "Offline";
      }
    }

    const latF = targetLat.toFixed(6);
    const lngF = targetLng.toFixed(6);

    const topoUrl = `https://www.topomap.co.nz/NZTopoMap?v=2&ll=${latF},${lngF}&z=15&pin=1`;
    const googleUrl = `https://www.google.com/maps/search/?api=1&query=${latF},${lngF}`;
    const earthUrl = `https://earth.google.com/web/search/${latF},${lngF}`;
    const windyUrl = `https://www.windy.com/${latF}/${lngF}`;
    const zoomEarthUrl = `https://zoom.earth/maps/satellite/#view=${latF},${lngF},10z`;
    const yrNoUrl = `https://www.yr.no/en/forecast/daily-table/${latF},${lngF}`;
    const outmapUrl = buildOutmapWebUrl(targetLat, targetLng, OUTMAP_WEB_ZOOM);

    // 1. Determine Header Title based on Team ID presence
    let reportHeader = "";
    if (teamIdValue !== "") {
        reportHeader = `Team '${teamIdValue.toUpperCase()}' LOCATION REPORT`;
    } else {
        reportHeader = `LOCATION REPORT`;
    }

    // We use a simple calculation or a quick fetch. 
    // For offline reliability, a simple static calculation is best, 
    // but here is the logic for the report:
    const sunData = await getSunTimes(targetLat, targetLng);

    const report = `${reportHeader}
----------------------${validationWarning}${swapNotice}
TIME  :   ${timeGenerated}
ALT   :   ${alti} (AMSL) ${vectorReport}
SUNRISE : ${sunData.sunrise} (NZ time)
SUNSET  : ${sunData.sunset} (NZ time)

--Topo50 GRID Ref+Sheet (For Radio comms):
SHEET: ${topoSheet}  REF: ${gridRefE} ${gridRefNorth}

--COORDINATES:
NZTM2000  :   ${nztm.e}, ${nztm.n}
DDD   :   ${targetLat.toFixed(6)}, ${targetLng.toFixed(6)}
DMS   :   ${toDMS(targetLat, true)}, ${toDMS(targetLng, false)}
DDM   :   ${toDDM(targetLat, true)}, ${toDDM(targetLng, false)}

--LINKS:
NZ TOPO: ${topoUrl}
G.Maps:   ${googleUrl}
G.Earth:  ${earthUrl}
WINDY.com:${windyUrl}
YR.no:   ${yrNoUrl}
Outmap:  ${outmapUrl}`;

    const reportContent = document.getElementById("reportContent");
    if (reportContent) reportContent.innerText = report;
    newEntry = {
      generatedTime: timeGenerated,
      lat: targetLat,
      lng: targetLng,
      alti,
      ddd: `${latF}, ${lngF}`,
      originalInput: cleanedParsedInput,
    };
    addToHistory(newEntry);

    const topoLink = document.getElementById("topoLink");
    const googleLink = document.getElementById("googleLink");
    const earthLink = document.getElementById("earthLink");
    const windyLinkBtn = document.getElementById("windyLinkBtn");
    const yrNoLinkBtn = document.getElementById("yrNoLinkBtn");
    const zoomEarthLink = document.getElementById("zoomEarthLink");
    const outmapLink = document.getElementById("outmapLink");

    if (topoLink) topoLink.href = topoUrl;
    if (googleLink) googleLink.href = googleUrl;
    if (earthLink) earthLink.href = earthUrl;
    if (windyLinkBtn) windyLinkBtn.href = windyUrl;
    if (yrNoLinkBtn) yrNoLinkBtn.href = yrNoUrl;
    if (zoomEarthLink) zoomEarthLink.href = zoomEarthUrl;
    if (outmapLink) outmapLink.href = outmapUrl;

    const resultArea = document.getElementById("resultArea");
    if (resultArea) resultArea.classList.remove("hidden");
    if (btn) btn.innerText = "Generate Report";

    liveVectorUserDismissed = false;
    if (isMobileFieldDevice() && myLat != null && myLng != null) {
      startLiveVectorWidget();
    } else {
      stopLiveVectorWidget();
    }
  } catch (err) {
    if (typeof alert === "function") alert(err.message);
    if (btn) btn.innerText = "Generate Report";
  }
}

// =============================================================================
// COORDINATE FORMAT HELPERS (decimal degrees → DMS / DDM strings)
// =============================================================================

/**
 * Convert decimal degrees to Degrees Minutes Seconds string (e.g. "S 43° 32' 24.0\"").
 * @param {number} dec - Angle in decimal degrees
 * @param {boolean} isLat - True for latitude (N/S), false for longitude (E/W)
 */
function toDMS(dec, isLat) {
  const abs = Math.abs(dec);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d - m / 60) * 3600).toFixed(1);
  const hem = isLat ? (dec < 0 ? "S" : "N") : dec < 0 ? "W" : "E";
  return `${hem} ${d}° ${m}' ${s}"`;
}

/**
 * Convert decimal degrees to Degrees Decimal Minutes string (e.g. "S 43° 32.400'").
 * @param {number} dec - Angle in decimal degrees
 * @param {boolean} isLat - True for latitude, false for longitude
 */
function toDDM(dec, isLat) {
  const abs = Math.abs(dec);
  const d = Math.floor(abs);
  const m = ((abs - d) * 60).toFixed(3);
  const hem = isLat ? (dec < 0 ? "S" : "N") : dec < 0 ? "W" : "E";
  return `${hem} ${d}° ${m}'`;
}

// =============================================================================
// GPS INIT & UI ACTIONS
// =============================================================================

function isMobileFieldDevice() {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent || "",
  );
}

function detachLiveVectorCompass() {
  if (liveVectorOrientationListenerAttached) {
    window.removeEventListener(
      "deviceorientation",
      onLiveVectorDeviceOrientation,
      true,
    );
    liveVectorOrientationListenerAttached = false;
  }
  liveVectorCompassHeading = null;
}

function stopLiveVectorWidget() {
  if (liveVectorIntervalId != null) {
    clearInterval(liveVectorIntervalId);
    liveVectorIntervalId = null;
  }
  detachLiveVectorCompass();
  liveVectorCompassMode = false;
  liveVectorCachedVector = null;
  const w = document.getElementById("liveVectorWidget");
  if (w) w.classList.add("hidden");
  const btn = document.getElementById("liveVectorCompassBtn");
  if (btn) btn.textContent = "Compass-relative arrow";
  const label = document.getElementById("liveVectorModeLabel");
  if (label) label.textContent = "Grid N↑";
}

function applyLiveVectorArrowRotation() {
  const wrap = document.getElementById("liveVectorArrowWrap");
  if (!wrap || !liveVectorCachedVector) return;
  let deg;
  if (
    liveVectorCompassMode &&
    liveVectorCompassHeading != null &&
    !Number.isNaN(liveVectorCompassHeading)
  ) {
    deg = liveVectorCachedVector.magneticBearing - liveVectorCompassHeading;
  } else {
    deg = liveVectorCachedVector.gridBearing;
  }
  deg = ((deg % 360) + 360) % 360;
  wrap.style.transform = `rotate(${deg}deg)`;
}

function onLiveVectorDeviceOrientation(ev) {
  if (!liveVectorCompassMode) return;
  if (
    ev.webkitCompassHeading != null &&
    !Number.isNaN(ev.webkitCompassHeading)
  ) {
    liveVectorCompassHeading = ev.webkitCompassHeading;
  } else if (ev.alpha != null && !Number.isNaN(ev.alpha)) {
    liveVectorCompassHeading = (360 - ev.alpha + 360) % 360;
  } else {
    return;
  }
  if (liveVectorRafPending) return;
  liveVectorRafPending = true;
  requestAnimationFrame(() => {
    liveVectorRafPending = false;
    applyLiveVectorArrowRotation();
  });
}

function updateLiveVectorWidget() {
  const widget = document.getElementById("liveVectorWidget");
  if (!widget || widget.classList.contains("hidden")) return;
  if (targetLat == null || targetLng == null) {
    stopLiveVectorWidget();
    return;
  }

  const distEl = document.getElementById("liveVectorDist");
  const gridEl = document.getElementById("liveVectorGridDeg");
  const magEl = document.getElementById("liveVectorMagDeg");
  const metaEl = document.getElementById("liveVectorMeta");

  if (myLat == null || myLng == null) {
    liveVectorCachedVector = null;
    if (distEl) distEl.textContent = "…";
    if (gridEl) gridEl.textContent = "—";
    if (magEl) magEl.textContent = "—";
    if (metaEl) {
      metaEl.textContent =
        "Waiting for GPS fix. Open sky helps. Vector updates every 10s.";
    }
    return;
  }

  const v = computeGpsVectorToTarget(
    myLat,
    myLng,
    targetLat,
    targetLng,
  );
  liveVectorCachedVector = v;
  if (!v) return;

  if (distEl) distEl.textContent = `${v.distKm} km`;
  if (gridEl) gridEl.textContent = String(Math.round(v.gridBearing));
  if (magEl) magEl.textContent = String(Math.round(v.magneticBearing));
  const acc =
    lastGpsAccuracyM != null ? `±${Math.round(lastGpsAccuracyM)} m` : "—";
  if (metaEl) {
    metaEl.textContent = `GPS ${acc} · ${v.dec}°E ${v.region} · 10s refresh`;
  }
  applyLiveVectorArrowRotation();
}

function startLiveVectorWidget() {
  stopLiveVectorWidget();
  const widget = document.getElementById("liveVectorWidget");
  if (!widget) return;
  widget.classList.remove("hidden");
  updateLiveVectorWidget();
  liveVectorIntervalId = window.setInterval(
    updateLiveVectorWidget,
    LIVE_VECTOR_INTERVAL_MS,
  );
}

function maybeStartLiveVectorAfterGpsUpdate() {
  if (!isMobileFieldDevice() || liveVectorUserDismissed) return;
  const ra = document.getElementById("resultArea");
  if (!ra || ra.classList.contains("hidden")) return;
  if (targetLat == null || targetLng == null) return;
  if (myLat == null || myLng == null) return;
  if (liveVectorIntervalId != null) return;
  startLiveVectorWidget();
}

async function toggleLiveVectorCompassMode() {
  const btn = document.getElementById("liveVectorCompassBtn");
  if (liveVectorCompassMode) {
    liveVectorCompassMode = false;
    detachLiveVectorCompass();
    if (btn) btn.textContent = "Compass-relative arrow";
    const label = document.getElementById("liveVectorModeLabel");
    if (label) label.textContent = "Grid N↑";
    applyLiveVectorArrowRotation();
    return;
  }
  if (
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function"
  ) {
    try {
      const st = await DeviceOrientationEvent.requestPermission();
      if (st !== "granted") {
        if (typeof alert === "function") {
          alert("Compass permission was not granted.");
        }
        return;
      }
    } catch (e) {
      if (typeof alert === "function") {
        alert("Compass is not available on this device.");
      }
      return;
    }
  }
  liveVectorCompassMode = true;
  window.addEventListener(
    "deviceorientation",
    onLiveVectorDeviceOrientation,
    true,
  );
  liveVectorOrientationListenerAttached = true;
  if (btn) btn.textContent = "Use grid-N arrow";
  const label = document.getElementById("liveVectorModeLabel");
  if (label) label.textContent = "Compass";
  applyLiveVectorArrowRotation();
}

function onLiveVectorClose() {
  liveVectorUserDismissed = true;
  stopLiveVectorWidget();
}

function setupLiveVectorWidgetUi() {
  const closeBtn = document.getElementById("liveVectorClose");
  if (closeBtn) {
    closeBtn.addEventListener("click", onLiveVectorClose);
  }
  const cBtn = document.getElementById("liveVectorCompassBtn");
  if (cBtn) {
    cBtn.addEventListener("click", () => toggleLiveVectorCompassMode());
  }
}

/** Show or hide the instructions modal. */
function toggleModal(show) {
  const modal = document.getElementById("instModal");
  if (modal) {
    show ? modal.classList.remove("hidden") : modal.classList.add("hidden");
  }
}

/**
 * Initialize GPS on mobile: try getCurrentPosition (5s timeout), then watchPosition to keep coords updated.
 * On PC, leaves vector disabled and shows a message.
 */
function initGPS() {
  const statusBox = document.getElementById("gpsStatus");
  if (!statusBox) return;

  if (!isMobileFieldDevice()) {
    statusBox.innerHTML =
      '<span class="text-slate-500">● PC Detected: GPS Vector Disabled</span>';
    return;
  }

  if (!navigator.geolocation) {
    statusBox.innerHTML =
      '<span class="text-red-500">● GPS Not Supported</span>';
    return;
  }

  statusBox.innerHTML = "GPS: Acquiring satellite lock (5s max)...";

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLat = pos.coords.latitude;
      myLng = pos.coords.longitude;
      lastGpsAccuracyM = pos.coords.accuracy;
      statusBox.innerHTML = `<span class="text-emerald-500">● GPS Active (Acc: ${Math.round(pos.coords.accuracy)}m)</span>`;
      navigator.geolocation.watchPosition(
        (wPos) => {
          myLat = wPos.coords.latitude;
          myLng = wPos.coords.longitude;
          lastGpsAccuracyM = wPos.coords.accuracy;
          statusBox.innerHTML = `<span class="text-emerald-500">● GPS Active (Acc: ${Math.round(wPos.coords.accuracy)}m)</span>`;
          maybeStartLiveVectorAfterGpsUpdate();
        },
        () => {},
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
      );
      maybeStartLiveVectorAfterGpsUpdate();
    },
    (err) => {
      statusBox.innerHTML =
        '<span class="text-amber-500">● GPS Timeout/No Fix. Vector skipped.</span>';
      myLat = null;
      myLng = null;
      lastGpsAccuracyM = null;
    },
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 },
  );
}

/** Fill input with current GPS position (DDD) and run report. Mobile only. */
function getCurrentLocation() {
  if (!isMobileFieldDevice()) {
    alert("GPS is disabled on PC. Please type coordinates manually.");
    return;
  }
  if (myLat == null || myLng == null) {
    alert("No GPS fix acquired. The vector/location features will be skipped.");
    return;
  }
  document.getElementById("combinedInput").value =
    `${myLat.toFixed(6)}, ${myLng.toFixed(6)}`;
  processCoordinates(null);
}

/** Clear the coordinate input and hide the result area. */
function clearAll() {
  stopLiveVectorWidget();
  liveVectorUserDismissed = false;
  targetLat = null;
  targetLng = null;
  const input = document.getElementById("combinedInput");
  const resultArea = document.getElementById("resultArea");
  if (input) input.value = "";
  if (resultArea) resultArea.classList.add("hidden");
}

function copyToClipboard() {
  const report = document.getElementById("reportContent");
  if (report) {
    navigator.clipboard.writeText(report.innerText);
    alert("Copied to clipboard");
  }
}

function saveAsPDF() {
  window.print();
}

function shareReport() {
  const report = document.getElementById("reportContent");
  if (navigator.share && report) {
    navigator.share({ title: "ARC Report", text: report.innerText });
  }
}

// -----------------------------------------------------------------------------
// Debug: triple-click logo reveals footer and runs projection unit tests
// -----------------------------------------------------------------------------

function handleLogoClick() {
  clickCount++;
  if (clickCount === 3) {
    const footer = document.getElementById("secretFooter");
    if (footer) footer.classList.remove("hidden");
    runUnitTests();
    const el = document.getElementById("visitCount");
    let cached = null;
    try {
      cached = localStorage.getItem(HIT_COUNT_CACHE_KEY);
    } catch (_) {
      /* private mode / quota */
    }
    if (el) {
      if (cached != null && cached !== "") el.textContent = cached;
    }
    fetch(COUNTER_API_HITS_UP, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        const n = d && d.count;
        if (!el) return;
        if (n != null && n !== "") {
          const s = String(n);
          el.textContent = s;
          try {
            localStorage.setItem(HIT_COUNT_CACHE_KEY, s);
          } catch (_) {
            /* ignore */
          }
        } else {
          el.textContent = cached != null && cached !== "" ? cached : "—";
        }
      })
      .catch(() => {
        if (!el) return;
        el.textContent =
          cached != null && cached !== "" ? cached : "Err";
      });
  }
  setTimeout(() => {
    clickCount = 0;
  }, 2000);
}

// =============================================================================
// COMPREHENSIVE UNIT TESTS (16-Point Matrix)
//==============================================================================
// -Testing for The "Null Island" Protection:
// If a team member enters 0, 0
//  or accidentally clears the field and hits generate,
//  the report will warn "OUTSIDE NEW ZEALAND BOUNDS."

// -Mistyped NZTM: If they miss the first digit of a Northing (typing 178500 instead of 5178500),
//  the conversion will place them near the equator.
//  The validation step will immediately flag this as an error.

// -Automatic Correction vs. Awareness:
// By highlighting both the NZTM Swap and the Geofence,
// you ensure the tool is smart enough to fix common errors
// but transparent enough that the user double-checks the source data.
// =============================================================================
function runDeclinationTest() {
  let htmlOut = "";

  htmlOut =
    "<b class='text-emerald-400 font-bold text-xs'>NATIONAL LANDSAR TEST SUITE:</b><br>";

  const testMatrix = [
    // Format: [Input, Label, ExpectedDec, RegionSubstring?, expectSwap?]
    ["-35.0, 173.0", "Northland Test", 18.5, "Northland"],
    ["-43.5, 172.6", "Canterbury Test", 23.5, "Canterbury"],
    ["-46.8, 167.0", "Fiordland Test", 25.5, "Fiordland"],
    ["5178500,,,1571000", "NZTM Swap Check", 23.5, "Canterbury", true],
  ];

  testMatrix.forEach(([input, label, expDec, expRegion, expectSwap]) => {
    const res = flexibleParse(input);
    let pass = false;
    let info = "ERR";

    if (res) {
      const decData = getDeclination(res.lat);
      const decPass = decData.dec === expDec;
      const swapPass =
        expectSwap === undefined || res.swapped === expectSwap;

      pass = decPass && swapPass;
      info = `${decData.dec}°E (${decData.region})`;
    }

    htmlOut += `
            <div class="flex justify-between text-[9px] border-b border-slate-700 py-1">
                <span class="${pass ? "text-emerald-400" : "text-red-500"} font-bold">
                    ${pass ? "✓" : "✗"} ${label}
                </span>
                <span class="font-mono text-slate-400">${info}</span>
            </div>`;
  });

  return htmlOut;
}

function runUnitTests() {
  const out = document.getElementById("coordExample");
  if (!out) return;

  out.innerHTML =
    "<b class='text-emerald-400 font-bold'>INTEGRITY MATRIX (parser + geofence):</b><br>";

  /**
   * Test Case Format: [Input String, Label, ExpectedLat, ExpectedLon, ExpectedSwap, ShouldBeInNZ]
   * Reference Point (Chch): Lat -43.543, Lon 172.642
   * Rows match current flexibleParse behaviour (reverse-DDD is tried before forward-DDD).
   */
  const testMatrix = [
    // --- Bounds testing
    ["1571000 5178500", "NZTM Clean", -43.5431, 172.6421, false, true],
    ["5178500,,,1571000", "NZTM Swapped", -43.5431, 172.6421, true, true],
    [
      "S43° 32.5', E172° 38.5'",
      "DDM Canterbury",
      -43.541,
      172.641,
      false,
      true,
    ],
    // reverse-DDD matches first → swapped true for symmetric null island
    ["0.00, 0.00", "DDD Out-of-Bounds", 0.0, 0.0, true, false],
    ["-37.8, 175.2", "DDD Waikato", -37.8, 175.2, false, true],
    // --- Messy syntax tests
    ["1571000,5178500", "NZTM no letters", -43.54, 172.64, false, true],
    ["E1571000,N5178500", "NZTM with letters", -43.54, 172.64, false, true],
    ["-43.54, 172.64", "DDD", -43.54, 172.64, false, true],
    ["S43°32'24, E172°38'24", "DMS", -43.54, 172.64, false, true],
    [
      "Some random text here... Location 1 (DDD): -43.54, 172.64. Then we have a DMS ",
      "DDD",
      -43.54,
      172.64,
      false,
      true,
    ],
    [
      "Then we have a DMS: S43°32'24, E172°38'24 and a DDM:",
      "DMS",
      -43.54,
      172.64,
      false,
      true,
    ],
    [
      "and a DDM: S43° 32.4', E172° 38.4'. Finally, NZTM",
      "DDM in text",
      -43.54,
      172.64,
      false,
      true,
    ],
    [
      "Finally, NZTM: 1571000, 5178500 amidst some noise 12345.",
      "DDD",
      -43.54,
      172.64,
      false,
      true,
    ],

    // --- NZTM TESTS ---
    ["1571000 5178500", "NZTM Clean", -43.54, 172.64, false, true],
    ["5178500,,,1571000", "NZTM Messy/Swap", -43.54, 172.64, true, true],
    ["E1571000 N5178500", "NZTM Labels", -43.54, 172.64, false, true],
    ["Grid: 1571000/5178500", "NZTM Text-Extract", -43.54, 172.64, false, true],

    // --- DDM (subset that matches current ddmPair / ddmRev patterns)
    ["-43 32.58 172 38.52", "DDM Negative", -43.54, 172.64, false, true],

    // --- DDD TESTS ---
    ["-43.5431, 172.6421", "DDD Clean", -43.54, 172.64, false, true],
    [
      "Target: -43.543 172.642 Over",
      "DDD Extract",
      -43.54,
      172.64,
      false,
      true,
    ],
    ["-43.543;;;172.642", "DDD Semicolon", -43.54, 172.64, false, true],
    ["172.6421 -43.5431", "DDD Lon-First", -43.54, 172.64, true, true],

    // DDM - SYMBOLS (The specific ones you noted)
    ["S43° 32.4', E172° 38.4'", "DDM with Symbols", -43.54, 172.64, false, true],
    ["S43 32.4, E172 38.4", "DDM with Spaces", -43.54, 172.64, false, true],
    
    // NZTM - TEXT NOISE
    ["The target is at 1571000 5178500 in the bush", "NZTM in Text", -43.54, 172.64, false, true],
    ["5178500 / 1571000", "NZTM Swapped/Slashed", -43.54, 172.64, true, true],

    // GEOWARNING (same as DDD Integer OOB above; kept as explicit regression)
    ["0, 0", "Out of Bounds Test", 0, 0, true, false],
  ];

  testMatrix.forEach(([input, label, expLat, expLon, expSwap, inNZ]) => {
    const res = flexibleParse(input);
    let pass = false;
    let oobStatus = "";

    if (res) {
      // 1. Check Swap Accuracy
      const swapPass = res.swapped === expSwap;

      // 2. Check Geofence Accuracy
      const isInside =
        res.lat >= NZ_BOUNDS.latMin &&
        res.lat <= NZ_BOUNDS.latMax &&
        res.lon >= NZ_BOUNDS.lonMin &&
        res.lon <= NZ_BOUNDS.lonMax;
      const geofencePass = isInside === inNZ;
      oobStatus = isInside ? "" : " [OOB]";

      // 3. Check Math Accuracy (Inverse/Forward)
      const mathPass =
        Math.abs(res.lat - expLat) < 0.1 && Math.abs(res.lon - expLon) < 0.1;

      pass = swapPass && geofencePass && mathPass;
    }

    out.innerHTML += `
            <div class="flex justify-between text-[9px] border-b border-slate-700 py-1">
                <span class="${pass ? "text-emerald-400" : "text-red-500"} font-bold">
                    ${pass ? "✓" : "✗"} ${label}
                </span>
                <span class="font-mono text-slate-400">
                    ${res ? res.lat.toFixed(2) : "ERR"}${oobStatus}
                </span>
            </div>`;
  });

  // --- RESTORED: MATH ROUND-TRIP INTEGRITY ---
  const rtLat = -43.543123;
  const rtLon = 172.642123;
  const toGrid = latLonToNZTM(rtLat, rtLon);
  const fromGrid = nztmToLatLon(toGrid.e, toGrid.n);
  const rtPass =
    Math.abs(fromGrid.lat - rtLat) < 0.00001 &&
    Math.abs(fromGrid.lon - rtLon) < 0.00001;

  out.innerHTML += `
        <div class="mt-2 p-2 bg-slate-900 rounded border ${rtPass ? "border-emerald-900" : "border-red-900"}">
            <div class="text-[9px] font-bold ${rtPass ? "text-emerald-500" : "text-red-500"}">
                ROUND-TRIP: ${rtPass ? "VERIFIED (<1m Drift)" : "FAILED"}
            </div>
        </div>`;

  out.innerHTML += runDeclinationTest();
}
