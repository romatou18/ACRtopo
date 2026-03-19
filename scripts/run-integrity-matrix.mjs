/**
 * Headless check for runUnitTests() matrix + declination rows (node only).
 * Usage: node scripts/run-integrity-matrix.mjs
 */
import fs from "fs";
import vm from "vm";

const sandbox = {
  console,
  Math,
  parseFloat,
  parseInt,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Date,
  RegExp,
  Error,
  Infinity,
  NaN,
  undefined,
  isFinite,
  isNaN,
  Symbol,
  BigInt,
  setTimeout: () => {},
  clearTimeout: () => {},
};
sandbox.window = sandbox;
sandbox.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
};
sandbox.window.addEventListener = () => {};
sandbox.navigator = { userAgent: "node" };
sandbox.localStorage = { getItem: () => null, setItem: () => {} };
sandbox.alert = () => {};

vm.createContext(sandbox);
vm.runInContext(
  fs.readFileSync(new URL("../app.js", import.meta.url), "utf8"),
  sandbox,
);

const NZ_BOUNDS = {
  latMin: -48.0,
  latMax: -34.0,
  lonMin: 164.0,
  lonMax: 179.5,
};
const { flexibleParse, latLonToNZTM, nztmToLatLon, getDeclination } = sandbox;

const src = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function extractConstArray(afterFnName, constName) {
  const fnIdx = src.indexOf(`function ${afterFnName}`);
  if (fnIdx < 0) return null;
  const needle = `const ${constName} = `;
  const start = src.indexOf(needle, fnIdx);
  if (start < 0) return null;
  const litStart = start + needle.length;
  if (src[litStart] !== "[") return null;
  let depth = 0;
  for (let i = litStart; i < src.length; i++) {
    const c = src[i];
    if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) {
        const literal = src.slice(litStart, i + 1);
        return (0, eval)(literal);
      }
    }
  }
  return null;
}

const testMatrix = extractConstArray("runUnitTests", "testMatrix");
if (!testMatrix) {
  console.error("Could not extract testMatrix from app.js");
  process.exit(1);
}

let fails = 0;
for (const row of testMatrix) {
  const [input, label, expLat, expLon, expSwap, inNZ] = row;
  const res = flexibleParse(input);
  let pass = false;
  if (res) {
    const swapPass = res.swapped === expSwap;
    const isInside =
      res.lat >= NZ_BOUNDS.latMin &&
      res.lat <= NZ_BOUNDS.latMax &&
      res.lon >= NZ_BOUNDS.lonMin &&
      res.lon <= NZ_BOUNDS.lonMax;
    const geofencePass = isInside === inNZ;
    const mathPass =
      Math.abs(res.lat - expLat) < 0.1 && Math.abs(res.lon - expLon) < 0.1;
    pass = swapPass && geofencePass && mathPass;
  }
  if (!pass) {
    console.error("FAIL:", label, "| res=", res);
    fails++;
  }
}

const rtLat = -43.543123;
const rtLon = 172.642123;
const toGrid = latLonToNZTM(rtLat, rtLon);
const fromGrid = nztmToLatLon(toGrid.e, toGrid.n);
const rtPass =
  Math.abs(fromGrid.lat - rtLat) < 0.00001 &&
  Math.abs(fromGrid.lon - rtLon) < 0.00001;
if (!rtPass) {
  console.error("FAIL: round-trip", fromGrid, { rtLat, rtLon });
  fails++;
}

const declMatrix = extractConstArray("runDeclinationTest", "testMatrix");
if (!declMatrix) {
  console.error("Could not extract declination testMatrix from app.js");
  process.exit(1);
}
for (const row of declMatrix) {
  const [input, label, expDec, , expectSwap] = row;
  const res = flexibleParse(input);
  let pass = false;
  if (res) {
    const decData = getDeclination(res.lat);
    const decPass = decData.dec === expDec;
    const swapPass =
      expectSwap === undefined || res.swapped === expectSwap;
    pass = decPass && swapPass;
  }
  if (!pass) {
    console.error("FAIL decl:", label, "| res=", res);
    fails++;
  }
}

if (fails) {
  console.error("Total failures:", fails);
  process.exit(1);
}
console.log("OK:", testMatrix.length, "matrix + round-trip +", declMatrix.length, "declination");
