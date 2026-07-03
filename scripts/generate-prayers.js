#!/usr/bin/env node
/**
 * generate-prayers.js
 * 
 * Runs once daily via GitHub Actions.
 * Loads all mosque data, computes today's prayer times for every mosque,
 * and writes the result as a binary Float32Array to /prayers-today.bin
 * 
 * Output format: Float32Array of length (num_mosques * 5)
 * Each mosque has 5 floats: [fajr, dhuhr, asr, maghrib, isha]
 * Values are hours in local time (0-24). -1 means unavailable (high latitude).
 * This matches exactly what _prayerCache expects in index.html.
 */

const fs = require('fs');
const path = require('path');

// ── Prayer calculation methods (same as in index.html worker) ───────────────
const METHODS = {
  MWL:      { fajr: -18,   isha: { angle: -17 },  asr: 1 },
  ISNA:     { fajr: -15,   isha: { angle: -15 },  asr: 1 },
  Egypt:    { fajr: -19.5, isha: { angle: -17.5 }, asr: 1 },
  Makkah:   { fajr: -18.5, isha: { mins: 90 },    asr: 1 },
  Karachi:  { fajr: -18,   isha: { angle: -18 },  asr: 1 },
  KarachiH: { fajr: -18,   isha: { angle: -18 },  asr: 2 },
  Tehran:   { fajr: -17.7, isha: { angle: -14 },  asr: 1 },
  Jafari:   { fajr: -16,   isha: { angle: -14 },  asr: 1 },
  Diyanet:  { fajr: -18,   isha: { angle: -17 },  asr: 1 },
  Gulf:     { fajr: -19.5, isha: { mins: 90 },    asr: 1 },
  Singapore:{ fajr: -20,   isha: { angle: -18 },  asr: 1 },
  France:   { fajr: -12,   isha: { angle: -12 },  asr: 1 },
  Russia:   { fajr: -16,   isha: { angle: -15 },  asr: 1 },
};

const COUNTRY_METHOD = {
  'Saudi Arabia': 'Makkah',   'Yemen': 'Makkah',     'Kuwait': 'Gulf',
  'UAE': 'Gulf',              'Qatar': 'Gulf',        'Bahrain': 'Gulf',
  'Oman': 'Gulf',             'Egypt': 'Egypt',       'Libya': 'Egypt',
  'Sudan': 'Egypt',           'Somalia': 'Egypt',     'Pakistan': 'Karachi',
  'Afghanistan': 'Karachi',   'Bangladesh': 'KarachiH','India': 'Karachi',
  'Nepal': 'KarachiH',       'Sri Lanka': 'KarachiH','Malaysia': 'MWL',
  'Indonesia': 'MWL',         'Turkey': 'Diyanet',    'Iran': 'Tehran',
  'Singapore': 'Singapore',   'France': 'France',     'Russia': 'Russia',
  'Ukraine': 'Russia',        'United States': 'ISNA','USA': 'ISNA',
  'Canada': 'ISNA',
};

function getMethod(country) {
  return METHODS[COUNTRY_METHOD[country] || 'MWL'];
}

function julianDay(y, m, d) {
  if (m <= 2) { y--; m += 12; }
  const A = Math.floor(y / 100), B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

function sunPosition(jdn) {
  const D = jdn - 2451545;
  const g = Math.PI / 180 * (357.529 + 0.98560028 * D);
  const q = 280.459 + 0.98564736 * D;
  const L = Math.PI / 180 * (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = Math.PI / 180 * (23.439 - 3.6e-7 * D);
  const RA = 180 / Math.PI * Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / 15;
  const dec = 180 / Math.PI * Math.asin(Math.sin(e) * Math.sin(L));
  return { dec, eqt: q / 15 - ((RA % 24) + 24) % 24 };
}

function calcPrayers(lat, lon, tz, date, country) {
  const M = getMethod(country || '');
  const jdn = julianDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  const { dec, eqt } = sunPosition(jdn);
  const lr = lat * Math.PI / 180, dr = dec * Math.PI / 180;
  const noon = 12 - eqt + (tz - lon / 15);

  function ha(angle) {
    const c = (Math.sin(angle * Math.PI / 180) - Math.sin(lr) * Math.sin(dr)) /
              (Math.cos(lr) * Math.cos(dr));
    return (c < -1 || c > 1) ? NaN : 180 / Math.PI * Math.acos(c) / 15;
  }

  const asrAngle = Math.atan(1 / (M.asr + Math.tan(Math.abs((lat - dec) * Math.PI / 180)))) * 180 / Math.PI;
  const fajr    = noon - ha(M.fajr);
  const dhuhr   = noon + 0.017;
  const asr     = noon + ha(asrAngle);
  const maghrib = noon + ha(-0.833);
  const isha    = M.isha.mins ? maghrib + M.isha.mins / 60 : noon + ha(M.isha.angle);

  return { fajr, dhuhr, asr, maghrib, isha };
}

// ── Load mosque data ─────────────────────────────────────────────────────────
// Expects mosques_min.js or the mobile chunks in the repo root
// We'll load the mobile chunks: mosques_mobile_1.js through mosques_mobile_15.js

function loadMosqueChunks(repoRoot) {
  const allMosques = [];
  for (let i = 1; i <= 15; i++) {
    const filePath = path.join(repoRoot, `mosques_mobile_${i}.js`);
    if (!fs.existsSync(filePath)) {
      console.warn(`Missing: ${filePath}`);
      continue;
    }
    // Each file contains: var MOSQUES_MOBILE_N = [[lat,lon,tz,name,country],...];
    const src = fs.readFileSync(filePath, 'utf8');
    // Extract the array
    const match = src.match(/=\s*(\[[\s\S]*\])\s*;?\s*$/);
    if (!match) {
      console.warn(`Could not parse chunk ${i}`);
      continue;
    }
    const chunk = JSON.parse(match[1]);
    for (const m of chunk) {
      allMosques.push({
        lat: m[0],
        lon: m[1],
        tz:  m[2],
        country: m[4] || m[3] || '',
      });
    }
    process.stdout.write(`\rLoaded chunk ${i}/15 — ${allMosques.length.toLocaleString()} mosques`);
  }
  console.log('');
  return allMosques;
}

// ── Main ─────────────────────────────────────────────────────────────────────
function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const outputPath = path.join(repoRoot, 'prayers-today.bin');

  console.log(`Date: ${new Date().toISOString().slice(0, 10)} UTC`);
  console.log('Loading mosque data...');
  const mosques = loadMosqueChunks(repoRoot);
  console.log(`Total mosques: ${mosques.length.toLocaleString()}`);

  console.log('Computing prayer times...');
  const date = new Date();
  const cache = new Float32Array(mosques.length * 5);
  const prayers = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];

  for (let i = 0; i < mosques.length; i++) {
    const m = mosques[i];
    const times = calcPrayers(m.lat, m.lon, m.tz, date, m.country);
    for (let j = 0; j < 5; j++) {
      const t = times[prayers[j]];
      cache[i * 5 + j] = (isNaN(t) ? -1 : ((t % 24) + 24) % 24);
    }
    if (i % 50000 === 0) {
      process.stdout.write(`\r  ${((i / mosques.length) * 100).toFixed(1)}%`);
    }
  }
  console.log('\r  100.0%');

  // Write as raw binary
  const buffer = Buffer.from(cache.buffer);
  fs.writeFileSync(outputPath, buffer);

  const sizeKB = (buffer.length / 1024).toFixed(0);
  console.log(`Written: prayers-today.bin (${sizeKB} KB, ${mosques.length.toLocaleString()} mosques × 5 prayers)`);

  // Also write a metadata file so the browser knows the date of the cache
  const meta = {
    date: date.toISOString().slice(0, 10),
    mosques: mosques.length,
    generated: date.toISOString(),
  };
  fs.writeFileSync(path.join(repoRoot, 'prayers-today.json'), JSON.stringify(meta));
  console.log('Written: prayers-today.json');
}

main();
