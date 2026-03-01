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

// =============================================================================
// GLOBAL STATE
// =============================================================================

/** Target coordinates from last successful parse (lat/lon in decimal degrees). */
let targetLat = null;
let targetLng = null;

/** Current device position from GPS (mobile only). Used for vector distance/bearing. */
let myLat = null;
let myLng = null;

/** Secret logo click counter for debug panel. */
let clickCount = 0;

/** Average magnetic declination for Canterbury (degrees East). Used to convert grid bearing to magnetic for compass use. */
const MAG_DEC = 23.5;

// =============================================================================
// STORAGE KEYS & CONSTANTS (Altitude cache, History)
// =============================================================================

const ALT_CACHE_KEY = 'arc_alt_cache';
const HISTORY_KEY = 'arc_history';
const HISTORY_MAX = 10;

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
        const raw = localStorage.getItem(ALT_CACHE_KEY) || '{}';
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
function addToHistory(entry) {
    let list = getHistory();
    const key = altCacheKey(entry.lat, entry.lng);
    list = [entry].concat(list.filter(e => altCacheKey(e.lat, e.lng) !== key));
    list = list.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    renderHistory();
}

/** Escape string for safe use in HTML (content and attributes). */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Render the history list in #historyList. Clicks handled by delegation on #historyList (reliable offline/mobile). */
function renderHistory() {
    const list = getHistory();
    const el = document.getElementById('historyList');
    if (!el) return;

    if (list.length === 0) {
        el.innerHTML = '<p class="text-slate-500 text-[10px] p-2">No history yet. Generate a report to add entries.</p>';
        return;
    }

    el.innerHTML = list.map((e, i) => {
        const displayCoords = e.originalInput || e.ddd || `${Number(e.lat).toFixed(6)}, ${Number(e.lng).toFixed(6)}`;
        const labelOneLine = displayCoords.replace(/\s+/g, ' ').trim();
        const label = `${labelOneLine} — ${e.alti || '—'}`;
        return `<button type="button" class="history-item text-left w-full p-2 rounded-lg bg-slate-700 hover:bg-slate-600 border border-slate-600 text-[10px] font-mono text-slate-300 truncate" data-index="${i}" title="Tap to restore">${escapeHtml(label)}</button>`;
    }).join('');
}

/** Restore a history entry into the input and run report. Called from delegation or programmatically. */
function restoreHistoryEntry(index) {
    const list = getHistory();
    const entry = list[parseInt(index, 10)];
    if (!entry) return;
    const toRestore = entry.originalInput != null && entry.originalInput !== ''
        ? entry.originalInput
        : (entry.ddd || `${Number(entry.lat).toFixed(6)}, ${Number(entry.lng).toFixed(6)}`);
    const input = document.getElementById('combinedInput');
    if (input) {
        input.value = toRestore;
        input.removeAttribute('readonly');
        processCoordinates();
    }
}

/** Attach one click listener to #historyList (event delegation). Survives re-renders and works offline/mobile. */
function setupHistoryDelegation() {
    const el = document.getElementById('historyList');
    if (!el) return;
    el.addEventListener('click', function (ev) {
        const btn = ev.target && ev.target.closest && ev.target.closest('.history-item');
        if (!btn) return;
        ev.preventDefault();
        ev.stopPropagation();
        const idx = btn.getAttribute('data-index');
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
    a: 6378137.0,              // GRS80 semi-major axis (m)
    f: 1 / 298.257222101,      // GRS80 flattening
    phizero: 0,                // Origin latitude (not used in simplified formulae)
    lambdazero: 173.0,        // Central meridian (degrees E)
    Nzero: 10000000,           // False northing (m)
    Ezero: 1600000,            // False easting (m)
    kzero: 0.9996              // Central meridian scale factor
};

/** Earth mean diameter in km (for Haversine distance). */
const EarthDiamKm = 12742;

/** Degrees to radians multiplier. */
const PI_div_180_deg = Math.PI / 180;

// -----------------------------------------------------------------------------
// New Zealand bounds and validation (for rescue ops: reject clearly wrong coords)
// -----------------------------------------------------------------------------

/** Approximate mainland NZ + Chathams: lat/lon in decimal degrees. */
const NZ_BOUNDS = {
    latMin: -47.5,
    latMax: -33.9,
    lonMin: 166.2,
    lonMax: 178.9
};

/** Christchurch (Canterbury) reference for "within 500 km" check. */
const CHRISTCHURCH = { lat: -43.5321, lon: 172.6362 };

/** Max distance (km) from Christchurch to consider coords plausible for this app. */
const MAX_DISTANCE_KM = 500;

/** Haversine distance between two points (km). */
function haversineKm(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * PI_div_180_deg;
    const dLon = (lon2 - lon1) * PI_div_180_deg;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * PI_div_180_deg) * Math.cos(lat2 * PI_div_180_deg) * Math.sin(dLon / 2) ** 2;
    return EarthDiamKm * 0.5 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True if (lat, lon) is inside the NZ bounds. */
function isInNewZealand(lat, lon) {
    return lat >= NZ_BOUNDS.latMin && lat <= NZ_BOUNDS.latMax && lon >= NZ_BOUNDS.lonMin && lon <= NZ_BOUNDS.lonMax;
}

/** True if (lat, lon) is within maxKm of Christchurch. */
function isWithinRangeOfChristchurch(lat, lon, maxKm) {
    return haversineKm(CHRISTCHURCH.lat, CHRISTCHURCH.lon, lat, lon) <= (maxKm ?? MAX_DISTANCE_KM);
}

/**
 * Validate coords for rescue use: must be in NZ and within MAX_DISTANCE_KM of Christchurch.
 * @returns {{ ok: boolean, message?: string }}
 */
function validateCoordinates(lat, lon) {
    if (!isInNewZealand(lat, lon)) {
        return { ok: false, message: "Coordinates are outside New Zealand. Check the pasted text (e.g. extra text from a message)." };
    }
    if (!isWithinRangeOfChristchurch(lat, lon)) {
        const km = Math.round(haversineKm(CHRISTCHURCH.lat, CHRISTCHURCH.lon, lat, lon));
        return { ok: false, message: `Coordinates are ${km} km from Christchurch (>${MAX_DISTANCE_KM} km). Likely wrong or from another region — check the pasted text.` };
    }
    return { ok: true };
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
    const A = a * (1 - n + (5/4) * (n**2 - n**3) + (81/64) * (n**4 - n**5));
    const sigma = M / A;
    // φ' = σ + B·sin(2σ) + C·sin(4σ) + D·sin(6σ). Coefficients (in n) from inverse
    // meridian arc series: B = 3n/2 − 27n³/32, C = 21n²/16 − 55n⁴/32, D = 151n³/96.
    const phip = sigma +
        (3*n/2 - 27*n**3/32) * Math.sin(2*sigma) +
        (21*n**2/16 - 55*n**4/32) * Math.sin(4*sigma) +
        (151*n**3/96) * Math.sin(6*sigma);

    // -------------------------------------------------------------------------
    // Step 3: At footpoint φ', compute radii of curvature and auxiliaries.
    // Eₜ = easting offset from central meridian (metres).
    // -------------------------------------------------------------------------
    const sin_p = Math.sin(phip), cos_p = Math.cos(phip), tan_p = Math.tan(phip);
    const rho = a * (1 - esq) / Math.pow(1 - esq * sin_p**2, 1.5);
    const nu = a / Math.sqrt(1 - esq * sin_p**2);
    const psi = nu / rho, t = tan_p, Et = E - NZTM.Ezero;

    // -------------------------------------------------------------------------
    // Step 4: Latitude φ = φ' − (Eₜ² term) + (Eₜ⁴ term).
    // Eₜ²: (t·Eₜ²)/(2·ρ·ν·k₀²) — main parabolic correction from easting.
    // Eₜ⁴: (t·Eₜ⁴)/(24·ρ·ν³·k₀⁴)·(5 + 3t² + 8ψ − 4ψ² − 9ψt²) — ellipsoid correction.
    // -------------------------------------------------------------------------
    const latTerm1 = (t * Et**2) / (2 * rho * nu * NZTM.kzero**2);
    const latTerm2 = (t * Et**4) / (24 * rho * nu**3 * NZTM.kzero**4) * (5 + 3*t**2 + 8*psi - 4*psi**2 - 9*psi*t**2);
    const lat = (phip - latTerm1 + latTerm2) * 180 / Math.PI;

    // -------------------------------------------------------------------------
    // Step 5: Longitude λ = λ₀ + (Eₜ term) − (Eₜ³ term).
    // Eₜ term: Eₜ/(ν·k₀·cos φ') — arc-to-angle along parallel at φ'.
    // Eₜ³ term: (Eₜ³)/(6·ν³·k₀³·cos φ')·(ψ + 2t²) — cubic correction for conformality.
    // -------------------------------------------------------------------------
    const lonTerm1 = Et / (nu * NZTM.kzero * cos_p);
    const lonTerm2 = (Et**3) / (6 * nu**3 * NZTM.kzero**3 * cos_p) * (psi + 2*t**2);
    const lon = NZTM.lambdazero + (lonTerm1 - lonTerm2) * 180 / Math.PI;

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
    const nu = a / Math.sqrt(1 - esq * Math.sin(phi)**2);
    // Radius of curvature in the meridian (along the meridian), metres.
    const rho = a * (1 - esq) / Math.pow(1 - esq * Math.sin(phi)**2, 1.5);
    const psi = nu / rho;           // Ratio used in TM series (often written as η² or similar).
    const t = Math.tan(phi);        // Tangent of latitude (recurring in TM formulae).
    const w = lam - lam0;           // Longitude difference from central meridian (radians).

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
    const M = a * (1 - n) * (1 - n**2) * (
        (1 + 9/4*n**2 + 225/64*n**4) * phi -
        (3/2*n - 27/32*n**3) * Math.sin(2*phi) +
        (15/16*n**2 - 105/128*n**4) * Math.sin(4*phi)
    );

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
    const N = NZTM.Nzero + NZTM.kzero * (
        M
        + (nu * t * Math.cos(phi)**2) * (w**2 / 2)
        + (nu * t * Math.pow(Math.cos(phi), 4)) * (w**4 / 24) * (5 - t**2 + 9*psi + 4*psi**2)
    );

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
    const E = NZTM.Ezero + NZTM.kzero * (
        (nu * Math.cos(phi)) * w
        + (nu * Math.pow(Math.cos(phi), 3)) * (w**3 / 6) * (psi - t**2)
    );

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
    const rows = ["AS","AT","AU","AV","AW","AX","AY","AZ","BA","BB","BC","BD","BE","BF","BG","BH","BI","BJ","BK","BL","BM","BN","BO","BP","BQ","BR","BS","BT","BU","BV","BW","BX","BY","BZ","CA","CB","CC","CD"];
    const rowIdx = Math.floor((6000000 - n) / 36000);
    const colIdx = Math.floor((e - 1000000) / 24000) + 1;
    const rowLetter = rows[rowIdx] || "??";
    const colNumber = colIdx.toString().padStart(2, '0');
    return `${rowLetter}${colNumber}`;
}

// =============================================================================
// INPUT EXTRACTION (noisy paste from WhatsApp, etc.)
// =============================================================================
//
// When the user pastes a full line, coordinates may be in the middle of text.
// We try to extract a substring that looks like NZTM, DDD, or DMS/DDM and parse that.
// -----------------------------------------------------------------------------

/** Normalize pasted text: trim, collapse whitespace and newlines. */
function normalizeInput(raw) {
    if (typeof raw !== 'string') return '';
    return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+/g, ' ').trim();
}

/**
 * Return candidate substrings that might contain coordinates.
 * Tries: NZTM pair, DDD pair in NZ range, two-number span, then full normalized string.
 */
function getCoordinateCandidates(raw) {
    const norm = normalizeInput(raw);
    const candidates = [];

    // 1. NZTM: E 1,000,000–1,800,000 ; N 4,700,000–6,200,000 (approx)
    const nztmRe = /\b(1[0-7]\d{5,6})\s*[,;\s]+\s*(4[7-9]\d{5}|5\d{6}|6[0-2]\d{5})\b/;
    const nztmMatch = norm.match(nztmRe);
    if (nztmMatch) candidates.push(nztmMatch[1] + ' ' + nztmMatch[2]);

    // 2. DDD for NZ: lat -33 to -48, lon 166–179
    const dddRe = /(-?(?:3[3-9]|4[0-8])\.\d+)\s*[,;\s]+\s*(1[6-7][0-9]\.\d+)/;
    const dddMatch = norm.match(dddRe);
    if (dddMatch) candidates.push(dddMatch[1] + ', ' + dddMatch[2]);

    // 3. Any two numbers that could be lat,lon
    const twoNumRe = /(-?\d{1,3}\.?\d*)\s*[,;\s]+\s*(-?\d{1,3}\.?\d*)/;
    const twoNumMatch = norm.match(twoNumRe);
    if (twoNumMatch) candidates.push(twoNumMatch[1] + ', ' + twoNumMatch[2]);

    // 4. Minimal span: first two number-like tokens (e.g. "text 1571000 5178500 more")
    const numTokenRe = /[-+]?\d+\.?\d*/g;
    const numbers = [];
    let m;
    while ((m = numTokenRe.exec(norm)) !== null) numbers.push({ start: m.index, end: m.index + m[0].length });
    if (numbers.length >= 2) {
        candidates.push(norm.substring(numbers[0].start, numbers[1].end));
    }

    // 5. Span from first to last number
    if (numbers.length >= 2) {
        const span = norm.substring(numbers[0].start, numbers[numbers.length - 1].end);
        if (!candidates.includes(span)) candidates.push(span);
    }

    if (norm.length > 0 && !candidates.includes(norm)) candidates.push(norm);
    return candidates;
}

/**
 * Extract and parse coordinates from noisy input. Tries each candidate until one parses.
 * @returns {{ cleaned: string, result: { lat: number, lon: number } | null }}
 */
function extractAndParse(raw) {
    const trimmed = (typeof raw === 'string' ? raw : '').trim();
    if (!trimmed) return { cleaned: '', result: null };
    const candidates = getCoordinateCandidates(trimmed);
    for (const c of candidates) {
        const result = flexibleParse(c);
        if (result != null) return { cleaned: c, result };
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
function flexibleParse(input) {
    const clean = input.trim();
    const nums = clean.match(/[-+]?\d*\.?\d+/g);
    if (!nums || nums.length < 2) return null;

    // Two numbers only and first > 900000 → treat as NZTM E, N
    if (nums.length === 2 && parseFloat(nums[0]) > 900000) {
        return nztmToLatLon(parseFloat(nums[0]), parseFloat(nums[1]));
    }

    // Split numeric array and string in half: first half = lat, second = lon
    const midIndex = Math.floor(nums.length / 2);
    const stringHalfIndex = Math.floor(clean.length / 2);
    const part1 = clean.substring(0, stringHalfIndex);
    const part2 = clean.substring(stringHalfIndex);

    /** Convert one half (array of 1–3 numbers) to decimal degrees; sign from raw text (S/W or minus). */
    function convertSegmentToDec(arr, rawText) {
        let d = Math.abs(parseFloat(arr[0] || 0));
        let m = (parseFloat(arr[1] || 0)) / 60;
        let s = (parseFloat(arr[2] || 0)) / 3600;
        let res = d + m + s;
        if (rawText.includes('-') || /[SwW]/.test(rawText)) res = -res;
        return res;
    }

    return {
        lat: convertSegmentToDec(nums.slice(0, midIndex), part1),
        lon: convertSegmentToDec(nums.slice(midIndex), part2)
    };
}

// =============================================================================
// MAIN PROCESSOR & REPORT GENERATOR
// =============================================================================

/**
 * Parse input, compute NZTM/sheet/ref, optional vector from GPS, altitude (cache or API),
 * build report text and map links, update DOM and history.
 */
async function processCoordinates() {
    const btn = document.getElementById('genBtn');
    const inputEl = document.getElementById('combinedInput');
    if (!inputEl) return;
    try {
        if (btn) btn.innerText = "Processing...";

        const rawInput = inputEl.value.trim();
        const { cleaned, result: res } = extractAndParse(rawInput);
        if (!res) throw new Error("Could not find valid coordinates in the pasted text. Try pasting only the numbers (e.g. -43.54, 172.64 or NZTM E N).");
        targetLat = res.lat;
        targetLng = res.lon;

        // If we extracted from noisy text, show what we used (optional: replace field so user sees)
        if (cleaned && cleaned !== rawInput && cleaned.length < rawInput.length) {
            inputEl.value = cleaned;
        }

        const validation = validateCoordinates(targetLat, targetLng);
        const validationWarning = validation.ok ? '' : `\n⚠ CHECK: ${validation.message}\n`;
        if (!validation.ok && typeof alert === 'function') {
            alert(validation.message + "\n\nReport will still be shown — please check the coordinates.");
        }

        const nztm = latLonToNZTM(targetLat, targetLng);
        const sheet = getTopo50Sheet(nztm.e, nztm.n);
        const gE = Math.floor((nztm.e % 100000) / 100).toString().padStart(3, '0');
        const gN = Math.floor((nztm.n % 100000) / 100).toString().padStart(3, '0');

        // Vector (distance + bearing) from current GPS position to target
        let vectorReport = "";
        if (myLat != null && myLng != null) {
            const dLat = (targetLat - myLat) * PI_div_180_deg;
            const dLon = (targetLng - myLng) * PI_div_180_deg;
            const a_v = Math.sin(dLat/2)**2 + Math.cos(myLat*PI_div_180_deg)*Math.cos(targetLat*PI_div_180_deg)*Math.sin(dLon/2)**2;
            const dist = (EarthDiamKm * Math.atan2(Math.sqrt(a_v), Math.sqrt(1 - a_v))).toFixed(2);

            const y_v = Math.sin(dLon) * Math.cos(targetLat*PI_div_180_deg);
            const x_v = Math.cos(myLat*PI_div_180_deg)*Math.sin(targetLat*PI_div_180_deg) - Math.sin(myLat*PI_div_180_deg)*Math.cos(targetLat*PI_div_180_deg)*Math.cos(dLon);
            const gridBrg = (Math.atan2(y_v, x_v) * 180 / Math.PI + 360) % 360;
            const magBrg = (gridBrg - MAG_DEC + 360) % 360;

            vectorReport = `\nVECTOR:   ${dist}km from you\nBearing   :   ${Math.round(gridBrg)}°(Grid/ True North) | ${Math.round(magBrg)}°Magnetic (${MAG_DEC}°E Canterbury declination offset for compass use)`;
        }

        // Altitude: use cache first (offline); else fetch with timeout so we don't hang when offline
        let alti = getAltFromCache(targetLat, targetLng);
        if (alti == null) {
            alti = "Checking...";
            try {
                const url = `https://api.open-meteo.com/v1/elevation?latitude=${targetLat}&longitude=${targetLng}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 6000);
                const r = await fetch(url, { signal: controller.signal });
                clearTimeout(timeoutId);
                const data = await r.json();
                alti = data.elevation ? `${Math.round(data.elevation[0])}m (AMSL)` : "Not found";
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
        const yrNoUrl   = `https://www.yr.no/en/forecast/daily-table/${latF},${lngF}`;

        const report = `ARC LOCATION REPORT
----------------------${validationWarning}
TIME  :   ${new Date().toLocaleString('en-NZ', { hour12: false })}
ALT   :   ${alti}${vectorReport}

--Topo50 GRID Ref+Sheet (For Radio comms):
SHEET: ${sheet}  REF: ${gE} ${gN}

--COORDINATES:
NZTM2000  :   E${nztm.e} N${nztm.n}
DDD   :   ${targetLat.toFixed(6)}, ${targetLng.toFixed(6)}
DMS   :   ${toDMS(targetLat, true)} ${toDMS(targetLng, false)}
DDM   :   ${toDDM(targetLat, true)} ${toDDM(targetLng, false)}

--LINKS:
NZ TOPO: ${topoUrl}
G.Maps:   ${googleUrl}
G.Earth:  ${earthUrl}
WINDY.com:${windyUrl}
YR.no:   ${yrNoUrl}`;

        const reportContent = document.getElementById('reportContent');
        if (reportContent) reportContent.innerText = report;
        addToHistory({ lat: targetLat, lng: targetLng, alti, ddd: `${latF}, ${lngF}`, originalInput: rawInput });

        const topoLink = document.getElementById('topoLink');
        const googleLink = document.getElementById('googleLink');
        const earthLink = document.getElementById('earthLink');
        const windyLinkBtn = document.getElementById('windyLinkBtn');
        const yrNoLinkBtn = document.getElementById('yrNoLinkBtn');
        const zoomEarthLink = document.getElementById('zoomEarthLink');

        if (topoLink) topoLink.href = topoUrl;
        if (googleLink) googleLink.href = googleUrl;
        if (earthLink) earthLink.href = earthUrl;
        if (windyLinkBtn) windyLinkBtn.href = windyUrl;
        if (yrNoLinkBtn) yrNoLinkBtn.href = yrNoUrl;
        if (zoomEarthLink) zoomEarthLink.href = zoomEarthUrl;

        const resultArea = document.getElementById('resultArea');
        if (resultArea) resultArea.classList.remove('hidden');
        if (btn) btn.innerText = "Generate Report";

    } catch (err) {
        if (typeof alert === 'function') alert(err.message);
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
    const s = ((abs - d - m/60) * 3600).toFixed(1);
    const hem = isLat ? (dec < 0 ? 'S' : 'N') : (dec < 0 ? 'W' : 'E');
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
    const hem = isLat ? (dec < 0 ? 'S' : 'N') : (dec < 0 ? 'W' : 'E');
    return `${hem} ${d}° ${m}'`;
}

// =============================================================================
// GPS INIT & UI ACTIONS
// =============================================================================

/** Show or hide the instructions modal. */
function toggleModal(show) {
    const modal = document.getElementById('instModal');
    if (modal) {
        show ? modal.classList.remove('hidden') : modal.classList.add('hidden');
    }
}

/**
 * Initialize GPS on mobile: try getCurrentPosition (5s timeout), then watchPosition to keep coords updated.
 * On PC, leaves vector disabled and shows a message.
 */
function initGPS() {
    const statusBox = document.getElementById('gpsStatus');
    if (!statusBox) return;

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

    if (!isMobile) {
        statusBox.innerHTML = '<span class="text-slate-500">● PC Detected: GPS Vector Disabled</span>';
        return;
    }

    if (!navigator.geolocation) {
        statusBox.innerHTML = '<span class="text-red-500">● GPS Not Supported</span>';
        return;
    }

    statusBox.innerHTML = 'GPS: Acquiring satellite lock (5s max)...';

    navigator.geolocation.getCurrentPosition(
        (pos) => {
            myLat = pos.coords.latitude;
            myLng = pos.coords.longitude;
            statusBox.innerHTML = `<span class="text-emerald-500">● GPS Active (Acc: ${Math.round(pos.coords.accuracy)}m)</span>`;
            navigator.geolocation.watchPosition(
                (wPos) => {
                    myLat = wPos.coords.latitude;
                    myLng = wPos.coords.longitude;
                    statusBox.innerHTML = `<span class="text-emerald-500">● GPS Active (Acc: ${Math.round(wPos.coords.accuracy)}m)</span>`;
                },
                () => {},
                { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
            );
        },
        (err) => {
            statusBox.innerHTML = '<span class="text-amber-500">● GPS Timeout/No Fix. Vector skipped.</span>';
            myLat = null;
            myLng = null;
        },
        { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
}

/** Fill input with current GPS position (DDD) and run report. Mobile only. */
function getCurrentLocation() {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (!isMobile) {
        alert("GPS is disabled on PC. Please type coordinates manually.");
        return;
    }
    if (myLat == null || myLng == null) {
        alert("No GPS fix acquired. The vector/location features will be skipped.");
        return;
    }
    document.getElementById('combinedInput').value = `${myLat.toFixed(6)}, ${myLng.toFixed(6)}`;
    processCoordinates();
}

/** Clear the coordinate input and hide the result area. */
function clearAll() {
    const input = document.getElementById('combinedInput');
    const resultArea = document.getElementById('resultArea');
    if (input) input.value = '';
    if (resultArea) resultArea.classList.add('hidden');
}

function copyToClipboard() {
    const report = document.getElementById('reportContent');
    if (report) {
        navigator.clipboard.writeText(report.innerText);
        alert("Copied to clipboard");
    }
}

function saveAsPDF() {
    window.print();
}

function shareReport() {
    const report = document.getElementById('reportContent');
    if (navigator.share && report) {
        navigator.share({ title: 'ARC Report', text: report.innerText });
    }
}

// -----------------------------------------------------------------------------
// Debug: triple-click logo reveals footer and runs projection unit tests
// -----------------------------------------------------------------------------

function handleLogoClick() {
    clickCount++;
    if (clickCount === 3) {
        const footer = document.getElementById('secretFooter');
        if (footer) footer.classList.remove('hidden');
        runUnitTests();
        fetch('https://api.counterapi.dev/v1/arc-rescue-canterbury/hits/up')
            .then(r => r.json())
            .then(d => {
                const el = document.getElementById('visitCount');
                if (el) el.innerText = d.count;
            })
            .catch(() => {
                const el = document.getElementById('visitCount');
                if (el) el.innerText = "Err";
            });
    }
    setTimeout(() => { clickCount = 0; }, 2000);
}

function runUnitTests() {
    const out = document.getElementById('testOutput');
    if (!out) return;
    out.innerHTML = "ENGINE PROJECTION TESTS:<br>";
    const tests = [
        { i: "1571000 5178500", label: "NZTM -> DDD", expected: -43.54 },
        { i: "-43.54, 172.64", label: "DDD -> NZTM", expected: 1571000 }
    ];
    tests.forEach(test => {
        const res = flexibleParse(test.i);
        const val = test.label.includes("DDD") ? res.lat : latLonToNZTM(res.lat, res.lon).e;
        const pass = Math.abs(val - test.expected) < 5;
        out.innerHTML += `${pass ? '✅' : '❌'} ${test.label} | Res: ${val.toFixed(2)}<br>`;
    });
}
