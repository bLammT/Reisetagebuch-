'use strict';

/*
 * Reisekarte – Prototyp
 *
 * Datenmodell (wird im localStorage gespeichert und als JSON exportiert):
 *   trip  = { title, startDate: 'YYYY-MM-DD', days: [Day] }
 *   Day   = { id, night: Place|null, transit, trips: [Trip] }
 *           night = wo man am Ende dieses Tages schläft
 *           transit = true: die Nacht wird unterwegs verbracht (z. B. Nachtzug)
 *   Trip  = { id, name, from: Place|null, via: [Place], to: Place, roundtrip, mode }
 *           from = null heißt: Start bei der Unterkunft, in der man aufgewacht ist
 *   Place = { name, label, lat, lon }
 *   trip.journal = [Entry]
 *   Entry = { id, dayId, at: ISO-Zeit, text, place: Place|null, photos: [photoId] }
 *           Fotos liegen verkleinert in IndexedDB (zu groß für localStorage).
 */

const STORAGE_KEY = 'reisekarte.trip.v1';
const ROUTE_CACHE_KEY = 'reisekarte.routes.v1';

// Externe Dienste (öffentliche Instanzen, nur für geringe Last gedacht – siehe README).
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const ROUTING = 'https://routing.openstreetmap.de';
const PROFILES = {
  car: { label: 'Auto', path: 'routed-car' },
  bike: { label: 'Fahrrad', path: 'routed-bike' },
  foot: { label: 'Zu Fuß', path: 'routed-foot' },
  // Ohne Routing: werden als direkte Verbindung gezeichnet.
  train: { label: 'Zug', path: null },
  flight: { label: 'Flug', path: null },
};

const DAY_COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#ae3ec9', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];
const TRANSFER_COLOR = '#1d2b33';
const SAME_PLACE_KM = 0.3;

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- Beispiel */

// Beispielreise. Koordinaten sind ungefähre Ortsmitten, nur zur Demonstration.
function sampleTrip() {
  const P = (name, label, lat, lon) => ({ name, label, lat, lon });
  const meran = P('Meran', 'Südtirol, Italien', 46.6713, 11.1525);
  const brixen = P('Brixen', 'Südtirol, Italien', 46.7150, 11.6560);
  const day = (night, trips = []) => ({ id: uid(), night: night && clone(night), trips });
  const trip = (name, to, opts = {}) => ({
    id: uid(), name, from: null, via: [], to, roundtrip: true, mode: 'car', ...opts,
  });
  return {
    title: 'Südtirol im Juni (Beispiel)',
    journal: [],
    startDate: '2026-06-12',
    days: [
      day(meran),
      day(meran, [trip('Wanderung zum Schloss Tirol', P('Schloss Tirol', 'Dorf Tirol, Südtirol', 46.6927, 11.1505), { mode: 'foot' })]),
      day(meran, [trip('Weinstraße und Bozen', P('Bozen', 'Südtirol, Italien', 46.4983, 11.3548), {
        via: [P('Kaltern', 'Kaltern an der Weinstraße', 46.4140, 11.2420)],
      })]),
      day(brixen, [trip('Umzug nach Brixen', clone(brixen), {
        roundtrip: false, via: [P('Klausen', 'Südtirol, Italien', 46.6390, 11.5660)],
      })]),
      day(brixen, [trip('Ausflug ins Grödnertal', P('St. Ulrich', 'Gröden, Südtirol', 46.5770, 11.6720))]),
      day(null, [trip('Spaziergang Kloster Neustift', P('Kloster Neustift', 'Vahrn, Südtirol', 46.7360, 11.6580), { mode: 'foot' })]),
    ],
  };
}

function emptyTrip() {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { title: 'Meine Reise', startDate: iso, days: [{ id: uid(), night: null, trips: [] }], journal: [] };
}

function normalizePlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { name: String(p.name || 'Ort'), label: String(p.label || ''), lat, lon };
}
function normalizeTrip(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.days)) throw new Error('Keine gültige Reisedatei.');
  return {
    title: String(t.title || 'Meine Reise'),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(t.startDate) ? t.startDate : emptyTrip().startDate,
    days: t.days.map((d) => ({
      id: String(d.id || uid()),
      night: normalizePlace(d.night),
      transit: Boolean(d.transit) && !normalizePlace(d.night),
      trips: (Array.isArray(d.trips) ? d.trips : []).map((x) => ({
        id: String(x.id || uid()),
        name: String(x.name || ''),
        from: normalizePlace(x.from),
        via: (Array.isArray(x.via) ? x.via : []).map(normalizePlace).filter(Boolean),
        to: normalizePlace(x.to),
        roundtrip: Boolean(x.roundtrip),
        mode: PROFILES[x.mode] ? x.mode : 'car',
      })).filter((x) => x.to),
    })),
    journal: (Array.isArray(t.journal) ? t.journal : []).map((e) => ({
      id: String(e.id || uid()),
      dayId: String(e.dayId || ''),
      at: String(e.at || new Date().toISOString()),
      text: String(e.text || ''),
      place: normalizePlace(e.place),
      photos: (Array.isArray(e.photos) ? e.photos : []).map(String),
    })),
  };
}

/* ---------------------------------------------------------------- Zustand */

let state;
try {
  const saved = loadJSON(STORAGE_KEY, null);
  state = saved ? normalizeTrip(saved) : sampleTrip();
} catch {
  state = sampleTrip();
}

const ui = {
  focusDay: null, // id des hervorgehobenen Tages
  sel: null, // ausgewähltes Element: 'trip:<id>', 'transfer:<dayId>', 'stay:<dayId>' oder 'entry:<id>'
  draft: null, // { dayId, exId|null, data, error }
  pickers: {}, // key -> { query, results, loading, error, editing }
  mapPick: null, // key des Ortes, der per Kartenklick gesetzt wird
  jdraft: null, // Tagebucheintrag in Bearbeitung: { dayId, entryId|null, data, added, removed, error, busy, locating }
};


function save() {
  saveJSON(STORAGE_KEY, state);
}

const dayIndex = (id) => state.days.findIndex((d) => d.id === id);
const dayById = (id) => state.days.find((d) => d.id === id);
const dayColor = (i) => DAY_COLORS[i % DAY_COLORS.length];
const entriesOf = (dayId) => state.journal.filter((e) => e.dayId === dayId).sort((a, b) => a.at.localeCompare(b.at));

// Tagebucheinträge ohne passenden Tag verwerfen.
state.journal = state.journal.filter((e) => dayById(e.dayId));

function kmBetween(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const samePlace = (a, b) => Boolean(a && b && kmBetween(a, b) < SAME_PLACE_KM);

// Wo startet man an Tag i? In der Unterkunft der Vornacht, am Anreisetag in der eigenen.
function stayPlaceFor(i) {
  return (i > 0 && state.days[i - 1].night) || state.days[i].night || null;
}
function waypoints(i, ex) {
  const start = ex.from || stayPlaceFor(i);
  if (!start || !ex.to) return [];
  const pts = [start, ...ex.via.filter(Boolean), ex.to];
  if (ex.roundtrip) pts.push(start);
  return pts;
}
// Ortswechsel: neue Unterkunft, und kein einfacher Ausflug des Tages endet schon dort.
function transferFor(i) {
  if (i === 0) return null;
  const a = state.days[i - 1].night, b = state.days[i].night;
  if (!a || !b || samePlace(a, b)) return null;
  const covered = state.days[i].trips.some((ex) => !ex.roundtrip && samePlace(ex.to, b));
  return covered ? null : { from: a, to: b };
}
// Aufeinanderfolgende Nächte am selben Ort zusammenfassen.
function stayGroups() {
  const groups = [];
  state.days.forEach((d, i) => {
    if (!d.night) return;
    const last = groups[groups.length - 1];
    if (last && last.to === i - 1 && samePlace(last.place, d.night)) last.to = i;
    else groups.push({ place: d.night, from: i, to: i });
  });
  return groups;
}
// Für die Karte: alle Aufenthalte am selben Ort in einem Pin (z. B. N7–8, 12–13).
function stayPins() {
  const pins = [];
  stayGroups().forEach((g) => {
    const pin = pins.find((p) => samePlace(p.place, g.place));
    if (pin) pin.ranges.push(g); else pins.push({ place: g.place, ranges: [g] });
  });
  return pins;
}

/* ---------------------------------------------------------------- Datum */

const dateFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
function dateOf(i) {
  const [y, m, d] = state.startDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + i));
}
const fmtDate = (i) => dateFmt.format(dateOf(i));
function todayIndex() {
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const i = Math.round((today - dateOf(0).getTime()) / 86400000);
  return i >= 0 && i < state.days.length ? i : -1;
}
const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });

/* ---------------------------------------------------------------- Routing */

const routeCache = loadJSON(ROUTE_CACHE_KEY, {});
const routeQueue = [];
const routePending = new Set();
let routePumping = false;

const routeKey = (mode, pts) => `${mode}|${pts.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(';')}`;

// Liefert eine fertige Route aus dem Cache, sonst null und stellt die Abfrage in die Warteschlange.
function getRoute(mode, pts) {
  if (!PROFILES[mode].path) return { direct: true };
  const key = routeKey(mode, pts);
  const hit = routeCache[key];
  if (hit) return hit;
  if (!routePending.has(key)) {
    routePending.add(key);
    routeQueue.push({ key, mode, pts });
    pumpRoutes();
  }
  return null;
}

async function pumpRoutes() {
  if (routePumping) return;
  routePumping = true;
  while (routeQueue.length) {
    const job = routeQueue.shift();
    try {
      const coords = job.pts.map((p) => `${p.lon},${p.lat}`).join(';');
      const url = `${ROUTING}/${PROFILES[job.mode].path}/route/v1/driving/${coords}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error(data.code || 'keine Route');
      const r = data.routes[0];
      routeCache[job.key] = {
        coords: r.geometry.coordinates.map(([lon, lat]) => [+lat.toFixed(5), +lon.toFixed(5)]),
        distance: r.distance,
        duration: r.duration,
      };
    } catch (err) {
      console.warn('Route nicht verfügbar:', err.message);
      routeCache[job.key] = { failed: true };
    }
    routePending.delete(job.key);
    persistRoutes();
    scheduleRedraw();
    await sleep(350);
  }
  routePumping = false;
}

function persistRoutes() {
  const ok = Object.fromEntries(Object.entries(routeCache).filter(([, v]) => v.coords));
  if (!saveJSON(ROUTE_CACHE_KEY, ok)) {
    try { localStorage.removeItem(ROUTE_CACHE_KEY); } catch { /* Speicher nicht verfügbar */ }
  }
}

// Neu geladene Routen zeichnen. Ist gerade ein Popup offen, warten wir, bis es zu ist,
// sonst würde das Neuzeichnen es sofort wieder schließen.
let redrawQueued = false;
let popupOpen = false;
let redrawAfterPopup = false;
function scheduleRedraw() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    redrawQueued = false;
    updateStats();
    if (popupOpen) { redrawAfterPopup = true; return; }
    drawMap(false);
  });
}

/* ---------------------------------------------------------------- Kennzahlen */

function legStats(mode, pts) {
  if (pts.length < 2) return null;
  const r = getRoute(mode, pts);
  if (r && r.coords) return { m: r.distance, s: r.duration, approx: false };
  if (r && r.direct) return { m: airMeters(pts), s: null, approx: true, direct: true };
  return { m: airMeters(pts), s: null, approx: true, pending: !r };
}
function airMeters(pts) {
  let km = 0;
  for (let k = 1; k < pts.length; k++) km += kmBetween(pts[k - 1], pts[k]);
  return km * 1000;
}
const exStats = (i, ex) => legStats(ex.mode, waypoints(i, ex));
function transferStats(i) {
  const t = transferFor(i);
  return t ? legStats('car', [t.from, t.to]) : null;
}

function fmtKm(m) {
  const km = m / 1000;
  return `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} km`;
}
function fmtDur(s) {
  const min = Math.round(s / 60);
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')} h`;
}
function fmtStats(st) {
  if (!st) return '';
  if (st.direct) return `≈ ${fmtKm(st.m)} direkt`;
  if (st.approx) return `≈ ${fmtKm(st.m)} Luftlinie${st.pending ? ' · Route lädt…' : ''}`;
  return `${fmtKm(st.m)} · ${fmtDur(st.s)}`;
}

function updateStats() {
  document.querySelectorAll('[data-stat]').forEach((el) => {
    const [kind, a, b] = el.dataset.stat.split(':');
    const i = dayIndex(a);
    if (i < 0) return;
    if (kind === 'ex') {
      const ex = state.days[i].trips.find((x) => x.id === b);
      el.textContent = ex ? fmtStats(exStats(i, ex)) : '';
    } else if (kind === 'transfer') {
      el.textContent = fmtStats(transferStats(i));
    } else if (kind === 'day') {
      const parts = [transferStats(i), ...state.days[i].trips.map((ex) => exStats(i, ex))].filter(Boolean);
      if (!parts.length) { el.textContent = ''; return; }
      const m = parts.reduce((sum, p) => sum + p.m, 0);
      el.textContent = `${parts.some((p) => p.approx) ? '≈ ' : ''}${fmtKm(m)}`;
    }
  });
}

/* ---------------------------------------------------------------- Fotos */

const photoStore = (() => {
  let dbPromise;
  const open = () => (dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('reisekarte', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen (Speicher voll?)'));
    });
  };
  return {
    put: (id, blob) => run('readwrite', (st) => st.put(blob, id)),
    get: (id) => run('readonly', (st) => st.get(id)),
    del: (id) => run('readwrite', (st) => st.delete(id)).catch(() => {}),
  };
})();

const photoURLs = new Map();
async function photoURL(id) {
  if (photoURLs.has(id)) return photoURLs.get(id);
  const blob = await photoStore.get(id).catch(() => null);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  photoURLs.set(id, url);
  return url;
}
function forgetPhoto(id) {
  const url = photoURLs.get(id);
  if (url) URL.revokeObjectURL(url);
  photoURLs.delete(id);
  photoStore.del(id);
}
function hydratePhotos(root = document) {
  root.querySelectorAll('img[data-photo-img]').forEach(async (img) => {
    if (img.getAttribute('src')) return;
    const url = await photoURL(img.dataset.photoImg);
    if (url) img.src = url;
    else img.closest('.thumb')?.classList.add('is-missing');
  });
}

// Fotos auf höchstens 1600 px verkleinern und als JPEG speichern.
function shrinkImage(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht umgewandelt werden.'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`${file.name}: Dieses Bildformat kann der Browser nicht öffnen.`));
    };
    img.src = url;
  });
}

async function addPhotos(files) {
  const jd = ui.jdraft;
  if (!jd || !files.length) return;
  jd.busy = true; jd.error = null;
  render();
  for (const file of files) {
    try {
      const blob = await shrinkImage(file);
      const id = `ph_${Date.now().toString(36)}_${uid()}`;
      await photoStore.put(id, blob);
      jd.added.push(id);
      jd.data.photos.push(id);
    } catch (err) {
      jd.error = `Ein Foto wurde nicht gespeichert. ${err.message}`;
    }
  }
  jd.busy = false;
  render();
}

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

/* ---------------------------------------------------------------- Karte */

const map = L.map('map', { zoomControl: true }).setView([47.3, 11], 6);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende · Routen: <a href="https://routing.openstreetmap.de/">FOSSGIS</a>',
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);

// Flüge als leichter Bogen, damit sie sich von Straßen unterscheiden.
function arc(a, b) {
  const [lat1, lon1] = a, [lat2, lon2] = b;
  const dx = lon2 - lon1, dy = lat2 - lat1;
  const cx = (lon1 + lon2) / 2 - dy * 0.2, cy = (lat1 + lat2) / 2 + dx * 0.2;
  const out = [];
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const u = 1 - t;
    out.push([u * u * lat1 + 2 * u * t * cy + t * t * lat2, u * u * lon1 + 2 * u * t * cx + t * t * lon2]);
  }
  return out;
}
function legLatLngs(mode, pts, r) {
  if (r && r.coords) return r.coords;
  const ll = pts.map((p) => [p.lat, p.lon]);
  if (mode === 'flight') return ll.slice(1).flatMap((b, k) => arc(ll[k], b));
  return ll;
}
const DASH = { flight: '1 9', train: '12 6' };

// level: 'normal', 'selected' (angeklickt), 'soft' (gleicher Tag, nicht angeklickt), 'faded' (anderer Tag)
const LINE_OPACITY = { normal: 0.95, selected: 1, soft: 0.4, faded: 0.2 };
function drawLine(latlngs, color, { level = 'normal', approx, weight, tooltip, dash }) {
  const w = level === 'selected' ? weight + 3 : weight;
  L.polyline(latlngs, { color: '#ffffff', weight: w + 4, opacity: LINE_OPACITY[level] * 0.9, interactive: false }).addTo(routeLayer);
  const line = L.polyline(latlngs, {
    color, weight: w, opacity: LINE_OPACITY[level],
    dashArray: dash || (approx ? '6 9' : null), lineCap: 'round', lineJoin: 'round',
  }).addTo(routeLayer);
  if (level === 'selected') line.bringToFront();
  if (tooltip) line.bindTooltip(tooltip, { sticky: true });
}

let selMarkerNow = null; // Pin des ausgewählten Elements in der aktuellen Zeichnung

function drawMap(fit) {
  redrawAfterPopup = false; // wird gerade ohnehin komplett neu gezeichnet
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  const all = [];
  const focus = [];
  const fi = ui.focusDay ? dayIndex(ui.focusDay) : -1;
  const sel = ui.sel;
  const selPts = [];
  let selMarker = null;
  // Stufe eines Elements: angeklickt, gleicher Tag wie das Angeklickte, anderer Tag oder nichts ausgewählt.
  const levelOf = (i, key) => {
    if (sel === key) return 'selected';
    if (fi >= 0 && fi !== i) return 'faded';
    if (sel && fi === i) return 'soft';
    return 'normal';
  };
  const MARKER_OPACITY = { normal: 1, selected: 1, soft: 0.5, faded: 0.3 };

  state.days.forEach((d, i) => {
    const collect = (ll, key) => {
      all.push(...ll);
      if (fi === i) focus.push(...ll);
      if (sel === key) selPts.push(...ll);
    };
    const color = dayColor(i);

    const t = transferFor(i);
    if (t) {
      const key = `transfer:${d.id}`;
      const r = getRoute('car', [t.from, t.to]);
      const ll = r && r.coords ? r.coords : [[t.from.lat, t.from.lon], [t.to.lat, t.to.lon]];
      drawLine(ll, TRANSFER_COLOR, { level: levelOf(i, key), approx: !(r && r.coords), weight: 5, tooltip: `Tag ${i + 1}: Ortswechsel ${esc(t.from.name)} → ${esc(t.to.name)}` });
      collect(ll, key);
    }

    d.trips.forEach((ex) => {
      const pts = waypoints(i, ex);
      if (pts.length < 2) return;
      const key = `trip:${ex.id}`;
      const level = levelOf(i, key);
      const r = getRoute(ex.mode, pts);
      const ll = legLatLngs(ex.mode, pts, r);
      drawLine(ll, color, {
        level, approx: !(r && r.coords), weight: 4, dash: DASH[ex.mode],
        tooltip: `Tag ${i + 1}: ${esc(tripTitle(ex))} (${PROFILES[ex.mode].label})`,
      });
      collect(ll, key);

      const op = MARKER_OPACITY[level];
      const big = level === 'selected' ? 2 : 0;
      const stops = [...ex.via.filter(Boolean), ex.to];
      stops.forEach((p, k) => {
        const isGoal = k === stops.length - 1;
        L.circleMarker([p.lat, p.lon], {
          radius: (isGoal ? 7 : 5) + big, color: '#ffffff', weight: 2,
          fillColor: color, fillOpacity: op, opacity: op,
        }).bindTooltip(`${esc(p.name)}<br><small>Tag ${i + 1} · ${isGoal ? 'Ziel' : 'Zwischenstopp'}</small>`).addTo(markerLayer);
      });
      if (ex.from) {
        L.circleMarker([ex.from.lat, ex.from.lon], {
          radius: 6 + big, color, weight: 3, fillColor: '#ffffff', fillOpacity: 1, opacity: op,
        }).bindTooltip(`${esc(ex.from.name)}<br><small>Tag ${i + 1} · Start</small>`).addTo(markerLayer);
      }
    });
  });

  const selStayPlace = sel?.startsWith('stay:') ? dayById(sel.slice(5))?.night : null;

  stayPins().forEach((pin) => {
    const isSel = samePlace(pin.place, selStayPlace);
    const relevant = isSel || (fi >= 0 && pin.ranges.some((g) => fi >= g.from && fi <= g.to + 1));
    // Bei Ausflug oder Ortswechsel bleibt die Unterkunft des Tages sichtbar, bei Unterkunft/Eintrag nur das Angeklickte.
    const pinOnly = Boolean(sel) && (sel.startsWith('stay:') || sel.startsWith('entry:'));
    const faded = (fi >= 0 && !relevant) || (pinOnly && !isSel);
    const nights = pin.ranges.reduce((n, g) => n + g.to - g.from + 1, 0);
    const nightsTxt = 'N' + pin.ranges.map((g) => (g.from === g.to ? `${g.from + 1}` : `${g.from + 1}–${g.to + 1}`)).join(', ');
    const icon = L.divIcon({
      className: 'stay-icon',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
      html: `<div class="pin${isSel ? ' is-selected' : faded ? ' is-faded' : ''}"><span class="pin-ico">⌂</span><span class="pin-name">${esc(pin.place.name)}</span><span class="pin-n">${nightsTxt}</span></div>`,
    });
    const periods = pin.ranges.map((g) => `${fmtDate(g.from)} bis ${fmtDate(g.to + 1)}`).join('<br>');
    const marker = L.marker([pin.place.lat, pin.place.lon], { icon, zIndexOffset: isSel ? 3000 : relevant ? 2000 : 1000 })
      .bindPopup(`<strong>${esc(pin.place.name)}</strong><br>${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}<br>${periods}${pin.place.label ? `<br><small>${esc(pin.place.label)}</small>` : ''}`)
      .addTo(markerLayer);
    all.push([pin.place.lat, pin.place.lon]);
    if (relevant) focus.push([pin.place.lat, pin.place.lon]);
    if (isSel) { selPts.push([pin.place.lat, pin.place.lon]); selMarker = marker; }
  });

  state.journal.forEach((e) => {
    if (!e.place) return;
    const i = dayIndex(e.dayId);
    const level = levelOf(i, `entry:${e.id}`);
    const icon = L.divIcon({
      className: 'stay-icon', iconSize: [0, 0], iconAnchor: [0, 0],
      html: `<div class="jpin${level === 'selected' ? ' is-selected' : level === 'faded' || level === 'soft' ? ' is-faded' : ''}" style="--day:${dayColor(i)}">✎</div>`,
    });
    const excerpt = e.text.length > 220 ? `${e.text.slice(0, 220)}…` : e.text;
    const marker = L.marker([e.place.lat, e.place.lon], { icon, zIndexOffset: level === 'selected' ? 3500 : 1500 })
      .bindPopup(`<div class="jpop"><strong>Tag ${i + 1} · ${fmtDate(i)}</strong><br><small>${esc(e.place.name)} · ${timeFmt.format(new Date(e.at))}</small>${excerpt ? `<p>${esc(excerpt)}</p>` : ''}${e.photos[0] ? `<img class="jpop-img" data-photo-img="${e.photos[0]}" alt="Foto">` : ''}</div>`, { maxWidth: 260 })
      .addTo(markerLayer);
    all.push([e.place.lat, e.place.lon]);
    if (fi === i) focus.push([e.place.lat, e.place.lon]);
    if (level === 'selected') { selPts.push([e.place.lat, e.place.lon]); selMarker = marker; }
  });

  selMarkerNow = selMarker;
  if (fit) {
    const pts = selPts.length ? selPts : fi >= 0 && focus.length ? focus : all;
    if (pts.length === 1) map.setView(pts[0], selPts.length ? Math.max(map.getZoom(), 14) : 12);
    else if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 14 });
    // Nach dem Zoomen das Popup des angeklickten Pins öffnen.
    const key = sel;
    if (selMarker) setTimeout(() => { if (ui.sel === key && selMarkerNow) selMarkerNow.openPopup(); }, 350);
  }
}

map.on('popupopen', (e) => {
  popupOpen = true;
  hydratePhotos(e.popup.getElement());
});
map.on('popupclose', () => {
  popupOpen = false;
  if (redrawAfterPopup) setTimeout(() => { if (redrawAfterPopup && !popupOpen) drawMap(false); }, 0);
});

map.on('click', (e) => {
  if (!ui.mapPick) return;
  const key = ui.mapPick;
  const { lat, lng } = e.latlng;
  const place = { name: `Punkt ${lat.toFixed(4)}, ${lng.toFixed(4)}`, label: 'Auf der Karte gewählt', lat, lon: lng };
  ui.mapPick = null;
  setPlace(key, place);
  reverseGeocode(place);
});

/* ---------------------------------------------------------------- Ortssuche */

let lastNominatim = 0;
async function nominatimFetch(path) {
  // Nominatim erlaubt höchstens eine Anfrage pro Sekunde.
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const res = await fetch(`${NOMINATIM}${path}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseCoords(q) {
  const m = q.match(/^\s*(-?\d{1,2}(?:[.]\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:[.]\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: `Punkt ${lat.toFixed(4)}, ${lon.toFixed(4)}`, label: 'Koordinaten', lat, lon };
}

async function searchPlace(key) {
  const p = picker(key);
  const q = p.query.trim();
  if (!q) { p.error = 'Gib einen Ortsnamen ein.'; render(); return; }
  const coords = parseCoords(q);
  if (coords) { p.results = [coords]; p.error = null; render(); focusFirstResult(key); return; }
  p.loading = true; p.error = null; p.results = [];
  render();
  try {
    const data = await nominatimFetch(`/search?format=jsonv2&limit=5&accept-language=de&q=${encodeURIComponent(q)}`);
    p.results = data.map((r) => ({
      name: r.name || String(r.display_name).split(',')[0],
      label: r.display_name,
      lat: Number(r.lat),
      lon: Number(r.lon),
    }));
    if (!p.results.length) p.error = 'Nichts gefunden. Versuch es genauer, z. B. mit Ort und Land.';
  } catch (err) {
    console.warn('Ortssuche fehlgeschlagen:', err.message);
    p.error = 'Die Ortssuche ist gerade nicht erreichbar. Wähle den Ort über „Karte“ oder gib Koordinaten ein (z. B. 46.67, 11.15).';
  }
  p.loading = false;
  render();
  focusFirstResult(key);
}

function focusFirstResult(key) {
  const btn = document.querySelector(`[data-action="pick-result"][data-key="${CSS.escape(key)}"]`);
  if (btn) btn.focus();
}

async function reverseGeocode(place) {
  try {
    const r = await nominatimFetch(`/reverse?format=jsonv2&zoom=14&accept-language=de&lat=${place.lat}&lon=${place.lon}`);
    const a = r.address || {};
    const name = r.name || a.village || a.town || a.city || a.hamlet || a.suburb || String(r.display_name || '').split(',')[0];
    if (!name) return;
    place.name = name;
    place.label = r.display_name || place.label;
    save();
    render();
    drawMap(false);
  } catch {
    // Name bleibt bei den Koordinaten; der Ort ist trotzdem gesetzt.
  }
}

function picker(key) {
  if (!ui.pickers[key]) ui.pickers[key] = { query: '', results: [], loading: false, error: null, editing: false };
  return ui.pickers[key];
}

function placeRef(key) {
  const [kind, a, b] = key.split(':');
  if (kind === 'night') {
    const d = dayById(a);
    return { get: () => d?.night ?? null, set: (v) => { if (d) { d.night = v; if (v) d.transit = false; } }, persist: true };
  }
  if (kind === 'jdraft') {
    const jd = ui.jdraft?.data;
    return { get: () => jd?.place ?? null, set: (v) => { if (jd) jd.place = v; }, persist: false };
  }
  const data = ui.draft?.data;
  if (!data) return { get: () => null, set: () => {}, persist: false };
  if (a === 'via') return { get: () => data.via[Number(b)] ?? null, set: (v) => { data.via[Number(b)] = v; }, persist: false };
  return { get: () => data[a] ?? null, set: (v) => { data[a] = v; }, persist: false };
}

function setPlace(key, place) {
  const ref = placeRef(key);
  ref.set(place);
  delete ui.pickers[key];
  if (ref.persist) save();
  render();
  drawMap(false);
  if (place) map.panTo([place.lat, place.lon]);
}

/* ---------------------------------------------------------------- Seitenleiste */

function tripTitle(ex) {
  if (ex.name) return ex.name;
  return ex.roundtrip ? `Rundtour nach ${ex.to.name}` : `Nach ${ex.to.name}`;
}

function pickerHTML(key, place, placeholder = 'Ort suchen, z. B. Meran') {
  const p = picker(key);
  if (place && !p.editing) {
    return `<div class="place">
      <div class="place-text"><span class="place-name">${esc(place.name)}</span><span class="place-label">${esc(place.label || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`)}</span></div>
      <button class="link-btn" data-action="edit-place" data-key="${key}">Ändern</button>
      <button class="icon-btn" data-action="clear-place" data-key="${key}" aria-label="Ort entfernen" title="Ort entfernen">×</button>
    </div>`;
  }
  const inputId = `pk-${key.replace(/[^a-z0-9]/gi, '-')}`;
  return `<div class="picker">
    <div class="picker-row">
      <input id="${inputId}" type="search" data-picker="${key}" value="${esc(p.query)}" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="${esc(placeholder)}">
      <button class="btn" data-action="search" data-key="${key}" ${p.loading ? 'disabled' : ''}>${p.loading ? 'Sucht…' : 'Suchen'}</button>
      <button class="btn${ui.mapPick === key ? ' is-active' : ''}" data-action="map-pick" data-key="${key}" title="Ort auf der Karte anklicken">Karte</button>
      ${place ? `<button class="icon-btn" data-action="cancel-edit-place" data-key="${key}" aria-label="Ändern abbrechen" title="Abbrechen">×</button>` : ''}
    </div>
    ${p.error ? `<p class="picker-msg">${esc(p.error)}</p>` : ''}
    ${p.results.length ? `<ul class="results">${p.results.map((r, idx) => `<li><button data-action="pick-result" data-key="${key}" data-idx="${idx}"><span class="place-name">${esc(r.name)}</span><span class="place-label">${esc(r.label)}</span></button></li>`).join('')}</ul>` : ''}
  </div>`;
}

function exHTML(d, i, ex) {
  const start = ex.from || stayPlaceFor(i);
  const names = [start ? start.name : '?', ...ex.via.map((p) => p.name), ex.to.name];
  if (ex.roundtrip) names.push(start ? start.name : '?');
  const key = `trip:${ex.id}`;
  return `<div class="ex selectable${ui.sel === key ? ' is-selected' : ''}" data-action="select" data-sel="${key}" data-day="${d.id}" role="button" tabindex="0" aria-pressed="${ui.sel === key}">
    <div class="ex-body">
      <div class="ex-title">${esc(tripTitle(ex))}</div>
      <div class="ex-route">${names.map(esc).join(' → ')}</div>
      <div class="ex-meta">
        <span class="chip">${ex.roundtrip ? 'Rundtour' : 'Einfache Strecke'}</span>
        <span class="chip">${PROFILES[ex.mode].label}</span>
        <span class="ex-stat" data-stat="ex:${d.id}:${ex.id}"></span>
      </div>
    </div>
    <div class="ex-actions">
      <button class="link-btn" data-action="edit-ex" data-day="${d.id}" data-ex="${ex.id}">Bearbeiten</button>
      <button class="link-btn" data-action="delete-ex" data-day="${d.id}" data-ex="${ex.id}">Löschen</button>
    </div>
  </div>`;
}

function editorHTML(d, i) {
  const { data, error, exId } = ui.draft;
  const stay = stayPlaceFor(i);
  return `<div class="editor">
    <p class="editor-title">${exId ? 'Ausflug bearbeiten' : 'Neuer Ausflug'}</p>
    <label class="text-field">Name (optional)
      <input id="draft-name" type="text" data-draft="name" value="${esc(data.name)}" placeholder="z. B. Wanderung zum See">
    </label>
    <div>
      <div class="field-label">Start</div>
      <div class="seg" role="radiogroup" aria-label="Startort">
        <label><input id="draft-from-stay" type="radio" name="draft-from" data-draft="fromMode" value="stay" ${data.fromMode === 'stay' ? 'checked' : ''}>Unterkunft${stay ? ` (${esc(stay.name)})` : ' (noch keine)'}</label>
        <label><input id="draft-from-custom" type="radio" name="draft-from" data-draft="fromMode" value="custom" ${data.fromMode === 'custom' ? 'checked' : ''}>Anderer Ort</label>
      </div>
      ${data.fromMode === 'custom' ? pickerHTML('draft:from', data.from, 'Startort suchen') : ''}
    </div>
    <div>
      <div class="field-label">Zwischenstopps</div>
      <div class="vias">
        ${data.via.map((p, k) => `<div class="via-item"><div>${pickerHTML(`draft:via:${k}`, p, `Stopp ${k + 1} suchen`)}</div><button class="icon-btn" data-action="remove-via" data-idx="${k}" aria-label="Stopp entfernen" title="Stopp entfernen">−</button></div>`).join('')}
        <button class="link-btn" data-action="add-via" style="justify-self:start">+ Zwischenstopp</button>
      </div>
    </div>
    <div>
      <div class="field-label">Ziel</div>
      ${pickerHTML('draft:to', data.to, 'Ziel suchen')}
    </div>
    <label class="check"><input id="draft-roundtrip" type="checkbox" data-draft="roundtrip" ${data.roundtrip ? 'checked' : ''}>Rundtour: am Ende zurück zum Start</label>
    <label class="text-field">Unterwegs mit
      <select id="draft-mode" data-draft="mode">
        ${Object.entries(PROFILES).map(([k, v]) => `<option value="${k}" ${data.mode === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
    </label>
    ${error ? `<p class="editor-error">${esc(error)}</p>` : ''}
    <div class="editor-actions">
      <button class="btn primary" data-action="save-ex">Ausflug speichern</button>
      <button class="btn ghost" data-action="cancel-ex">Abbrechen</button>
    </div>
  </div>`;
}

function thumbsHTML(ids, removable) {
  if (!ids.length) return '';
  return `<div class="thumbs">${ids.map((id) => `<div class="thumb">
      <button class="thumb-open" data-action="open-photo" data-photo="${id}" aria-label="Foto vergrößern"><img data-photo-img="${id}" alt="Foto"></button>
      ${removable ? `<button class="thumb-del" data-action="remove-photo" data-photo="${id}" aria-label="Foto entfernen" title="Foto entfernen">×</button>` : ''}
    </div>`).join('')}</div>`;
}

function entryHTML(e) {
  const key = `entry:${e.id}`;
  return `<article class="entry selectable${ui.sel === key ? ' is-selected' : ''}" data-action="select" data-sel="${key}" data-day="${e.dayId}" role="button" tabindex="0" aria-pressed="${ui.sel === key}">
    <div class="entry-head">
      <span class="entry-time">${timeFmt.format(new Date(e.at))}</span>
      ${e.place ? `<span class="entry-place">${esc(e.place.name)}</span>` : ''}
      <span class="entry-actions">
        <button class="link-btn" data-action="edit-entry" data-entry="${e.id}">Bearbeiten</button>
        <button class="link-btn" data-action="delete-entry" data-entry="${e.id}">Löschen</button>
      </span>
    </div>
    ${e.text ? `<p class="entry-text">${esc(e.text)}</p>` : ''}
    ${thumbsHTML(e.photos, false)}
  </article>`;
}

function entryEditorHTML() {
  const jd = ui.jdraft;
  return `<div class="editor">
    <p class="editor-title">${jd.entryId ? 'Eintrag bearbeiten' : 'Neuer Tagebucheintrag'}</p>
    <label class="text-field">Text
      <textarea id="jdraft-text" data-jdraft="text" rows="6" placeholder="Was hast du heute erlebt?">${esc(jd.data.text)}</textarea>
    </label>
    <div>
      <div class="field-label">Fotos</div>
      ${thumbsHTML(jd.data.photos, true)}
      <label class="btn file-btn${jd.busy ? ' is-busy' : ''}">${jd.busy ? 'Fotos werden gespeichert…' : 'Fotos hinzufügen'}
        <input id="jdraft-photos" type="file" accept="image/*" multiple ${jd.busy ? 'disabled' : ''}>
      </label>
    </div>
    <div>
      <div class="field-label">Ort (optional)</div>
      ${pickerHTML('jdraft:place', jd.data.place, 'Ort suchen, z. B. Restaurant')}
      ${jd.data.place ? '' : `<button class="link-btn locate-btn" data-action="my-location" ${jd.locating ? 'disabled' : ''}>${jd.locating ? 'Standort wird ermittelt…' : 'Mein Standort verwenden'}</button>`}
    </div>
    ${jd.error ? `<p class="editor-error">${esc(jd.error)}</p>` : ''}
    <div class="editor-actions">
      <button class="btn primary" data-action="save-entry" ${jd.busy ? 'disabled' : ''}>Eintrag speichern</button>
      <button class="btn ghost" data-action="cancel-entry">Abbrechen</button>
    </div>
  </div>`;
}

function journalHTML(d) {
  const jd = ui.jdraft && ui.jdraft.dayId === d.id ? ui.jdraft : null;
  const entries = entriesOf(d.id);
  return `<div class="journal">
    <div class="field-label">Tagebuch</div>
    <div class="entries">
      ${entries.map((e) => (jd && jd.entryId === e.id ? entryEditorHTML() : entryHTML(e))).join('')}
      ${jd && !jd.entryId ? entryEditorHTML() : ''}
      ${jd ? '' : `<button class="add-btn" data-action="add-entry" data-day="${d.id}">+ Tagebucheintrag</button>`}
    </div>
  </div>`;
}

function dayHTML(d, i) {
  const morning = i > 0 ? state.days[i - 1].night : null;
  const afterTransit = i > 0 && state.days[i - 1].transit;
  const focused = ui.focusDay === d.id;
  const draftHere = ui.draft && ui.draft.dayId === d.id;
  const t = transferFor(i);
  const lastDay = i === state.days.length - 1;
  const isToday = i === todayIndex();
  return `<section id="day-${d.id}" class="day${focused ? ' is-focused' : ''}" style="--day:${dayColor(i)}">
    <div class="day-head">
      <button class="day-toggle" data-action="focus-day" data-day="${d.id}" aria-pressed="${focused}" title="Auf der Karte hervorheben">
        <span class="day-n">Tag ${i + 1}</span><span class="day-date">${fmtDate(i)}</span>${isToday ? '<span class="chip today-chip">Heute</span>' : ''}
      </button>
      <span class="day-stat" data-stat="day:${d.id}"></span>
      <button class="icon-btn" data-action="remove-day" data-day="${d.id}" aria-label="Tag ${i + 1} löschen" title="Tag löschen">×</button>
    </div>
    ${morning ? `<p class="day-morning">Morgens in <strong>${esc(morning.name)}</strong></p>` : afterTransit ? '<p class="day-morning">Ankunft nach einer Nacht unterwegs</p>' : i === 0 ? '<p class="day-morning">Anreisetag</p>' : ''}
    ${t ? `<p class="day-morning selectable transfer-row${ui.sel === `transfer:${d.id}` ? ' is-selected' : ''}" data-action="select" data-sel="transfer:${d.id}" data-day="${d.id}" role="button" tabindex="0">Ortswechsel nach <strong>${esc(t.to.name)}</strong> · <span data-stat="transfer:${d.id}"></span></p>` : ''}
    <div class="ex-list">
      ${d.trips.map((ex) => (draftHere && ui.draft.exId === ex.id ? editorHTML(d, i) : exHTML(d, i, ex))).join('')}
      ${draftHere && !ui.draft.exId ? editorHTML(d, i) : ''}
      ${draftHere ? '' : `<button class="add-btn" data-action="add-ex" data-day="${d.id}">+ Ausflug</button>`}
    </div>
    <div>
      <div class="field-label">Übernachtung${lastDay && !d.night && !d.transit ? ' (leer lassen am Abreisetag)' : ''}</div>
      ${d.transit
        ? `<div class="place"><div class="place-text"><span class="place-name">Nacht unterwegs</span><span class="place-label">z. B. Nachtzug, Nachtbus oder Flug</span></div><button class="link-btn" data-action="toggle-transit" data-day="${d.id}">Unterkunft eintragen</button></div>`
        : `${d.night && !picker(`night:${d.id}`).editing
          ? `<div class="selectable stay-select${ui.sel === `stay:${d.id}` ? ' is-selected' : ''}" data-action="select" data-sel="stay:${d.id}" data-day="${d.id}" role="button" tabindex="0">${pickerHTML(`night:${d.id}`, d.night)}</div>`
          : pickerHTML(`night:${d.id}`, d.night, 'Unterkunft oder Ort suchen')}${d.night ? '' : `<button class="link-btn transit-btn" data-action="toggle-transit" data-day="${d.id}">Diese Nacht bin ich unterwegs</button>`}`}
    </div>
    ${journalHTML(d)}
  </section>`;
}

function render() {
  const title = $('#trip-title');
  if (document.activeElement !== title) title.value = state.title;
  $('#start-date').value = state.startDate;
  $('#days').innerHTML = state.days.map(dayHTML).join('');

  const nights = state.days.filter((d) => d.night || d.transit).length;
  const stays = stayPins().length;
  const trips = state.days.reduce((n, d) => n + d.trips.length, 0);
  $('#trip-summary').textContent = `${state.days.length} Tage · ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'} · ${stays} ${stays === 1 ? 'Unterkunft' : 'Unterkünfte'} · ${trips} ${trips === 1 ? 'Ausflug' : 'Ausflüge'}`;

  $('#today-btn').hidden = todayIndex() < 0;
  $('#pick-banner').hidden = !ui.mapPick;
  $('#map').classList.toggle('is-picking', Boolean(ui.mapPick));
  updateStats();
  hydratePhotos($('#days'));
}

function scrollToDay(id) {
  document.getElementById(`day-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function newEntryDraft(dayId, entry) {
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('jdraft:')));
  if (ui.mapPick?.startsWith('jdraft:')) ui.mapPick = null;
  ui.jdraft = {
    dayId,
    entryId: entry ? entry.id : null,
    data: entry
      ? { text: entry.text, place: clone(entry.place), photos: [...entry.photos] }
      : { text: '', place: null, photos: [] },
    added: [], removed: [], error: null, busy: false, locating: false,
  };
}
function closeEntryDraft(keepPhotos) {
  if (ui.jdraft && !keepPhotos) ui.jdraft.added.forEach(forgetPhoto);
  ui.jdraft = null;
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('jdraft:')));
  if (ui.mapPick?.startsWith('jdraft:')) ui.mapPick = null;
}

/* ---------------------------------------------------------------- Aktionen */

function newDraft(dayId, ex) {
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('draft:')));
  if (ui.mapPick?.startsWith('draft:')) ui.mapPick = null;
  ui.draft = {
    dayId,
    exId: ex ? ex.id : null,
    error: null,
    data: ex
      ? { name: ex.name, fromMode: ex.from ? 'custom' : 'stay', from: clone(ex.from), via: clone(ex.via), to: clone(ex.to), roundtrip: ex.roundtrip, mode: ex.mode }
      : { name: '', fromMode: 'stay', from: null, via: [], to: null, roundtrip: true, mode: 'car' },
  };
}
function closeDraft() {
  ui.draft = null;
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('draft:')));
  if (ui.mapPick?.startsWith('draft:')) ui.mapPick = null;
}

const actions = {
  'focus-day'(el) {
    ui.focusDay = ui.focusDay === el.dataset.day && !ui.sel ? null : el.dataset.day;
    ui.sel = null;
    render();
    drawMap(true);
  },
  select(el) {
    if (window.getSelection()?.toString()) return; // Text wird markiert, nicht angeklickt
    const key = el.dataset.sel;
    if (ui.sel === key) {
      ui.sel = null;
    } else {
      ui.sel = key;
      ui.focusDay = el.dataset.day;
      if ($('.app').classList.contains('map-hidden')) actions['toggle-map']();
    }
    map.closePopup();
    render();
    drawMap(true);
  },
  'remove-day'(el) {
    const i = dayIndex(el.dataset.day);
    const d = state.days[i];
    if (state.days.length === 1) return;
    const entries = entriesOf(d.id);
    if ((d.night || d.trips.length || entries.length) && !confirm(`Tag ${i + 1} mit Unterkunft, Ausflügen${entries.length ? ` und ${entries.length} Tagebucheintrag/-einträgen` : ''} löschen?`)) return;
    entries.forEach((e) => e.photos.forEach(forgetPhoto));
    state.journal = state.journal.filter((e) => e.dayId !== d.id);
    if (ui.jdraft?.dayId === d.id) closeEntryDraft();
    state.days.splice(i, 1);
    if (ui.draft?.dayId === d.id) closeDraft();
    if (ui.focusDay === d.id) { ui.focusDay = null; ui.sel = null; }
    save(); render(); drawMap(false);
  },
  'add-day'() {
    const last = state.days[state.days.length - 1];
    state.days.push({ id: uid(), night: last?.night ? clone(last.night) : null, transit: false, trips: [] });
    save(); render(); drawMap(false);
    $('#days').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  'toggle-transit'(el) {
    const d = dayById(el.dataset.day);
    d.transit = !d.transit;
    if (d.transit) d.night = null;
    save(); render(); drawMap(false);
  },
  'add-ex'(el) {
    newDraft(el.dataset.day, null);
    render();
    document.querySelector('[data-picker="draft:to"]')?.focus();
  },
  'edit-ex'(el) {
    const ex = dayById(el.dataset.day).trips.find((x) => x.id === el.dataset.ex);
    newDraft(el.dataset.day, ex);
    render();
  },
  'delete-ex'(el) {
    const d = dayById(el.dataset.day);
    d.trips = d.trips.filter((x) => x.id !== el.dataset.ex);
    if (ui.sel === `trip:${el.dataset.ex}`) ui.sel = null;
    save(); render(); drawMap(false);
  },
  'cancel-ex'() { closeDraft(); render(); },
  'save-ex'() {
    const { dayId, exId, data } = ui.draft;
    const i = dayIndex(dayId);
    if (!data.to) { ui.draft.error = 'Wähle ein Ziel für den Ausflug.'; render(); return; }
    if (data.fromMode === 'custom' && !data.from) { ui.draft.error = 'Wähle einen Startort oder starte bei der Unterkunft.'; render(); return; }
    if (data.fromMode === 'stay' && !stayPlaceFor(i)) {
      ui.draft.error = 'Für diesen Tag gibt es noch keine Unterkunft. Trag eine Übernachtung ein oder wähle „Anderer Ort“ als Start.';
      render(); return;
    }
    const ex = {
      id: exId || uid(),
      name: data.name.trim(),
      from: data.fromMode === 'custom' ? data.from : null,
      via: data.via.filter(Boolean),
      to: data.to,
      roundtrip: data.roundtrip,
      mode: data.mode,
    };
    const d = state.days[i];
    const pos = d.trips.findIndex((x) => x.id === ex.id);
    if (pos >= 0) d.trips[pos] = ex; else d.trips.push(ex);
    closeDraft();
    save(); render(); drawMap(false);
  },
  'add-via'() {
    ui.draft.data.via.push(null);
    render();
    document.querySelector(`[data-picker="draft:via:${ui.draft.data.via.length - 1}"]`)?.focus();
  },
  'remove-via'(el) {
    ui.draft.data.via.splice(Number(el.dataset.idx), 1);
    ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('draft:via:')));
    if (ui.mapPick?.startsWith('draft:via:')) ui.mapPick = null;
    render();
  },
  search(el) { searchPlace(el.dataset.key); },
  'pick-result'(el) {
    const p = picker(el.dataset.key);
    const r = p.results[Number(el.dataset.idx)];
    if (r) setPlace(el.dataset.key, { name: r.name, label: r.label, lat: r.lat, lon: r.lon });
  },
  'edit-place'(el) {
    const p = picker(el.dataset.key);
    const place = placeRef(el.dataset.key).get();
    p.editing = true; p.query = place ? place.name : ''; p.results = []; p.error = null;
    render();
    document.querySelector(`[data-picker="${CSS.escape(el.dataset.key)}"]`)?.select();
  },
  'cancel-edit-place'(el) {
    delete ui.pickers[el.dataset.key];
    if (ui.mapPick === el.dataset.key) ui.mapPick = null;
    render();
  },
  'clear-place'(el) { setPlace(el.dataset.key, null); },
  'map-pick'(el) {
    ui.mapPick = ui.mapPick === el.dataset.key ? null : el.dataset.key;
    render();
  },
  'cancel-map-pick'() { ui.mapPick = null; render(); },
  'fit-all'() { ui.focusDay = null; ui.sel = null; map.closePopup(); render(); drawMap(true); },
  'retry-routes'() {
    Object.keys(routeCache).forEach((k) => { if (routeCache[k].failed) delete routeCache[k]; });
    drawMap(false); updateStats();
  },
  'add-entry'(el) {
    if (ui.jdraft) closeEntryDraft();
    newEntryDraft(el.dataset.day, null);
    render();
    $('#jdraft-text')?.focus();
  },
  'edit-entry'(el) {
    const entry = state.journal.find((e) => e.id === el.dataset.entry);
    if (!entry) return;
    if (ui.jdraft) closeEntryDraft();
    newEntryDraft(entry.dayId, entry);
    render();
  },
  'delete-entry'(el) {
    const entry = state.journal.find((e) => e.id === el.dataset.entry);
    if (!entry || !confirm('Diesen Tagebucheintrag mit allen Fotos löschen?')) return;
    entry.photos.forEach(forgetPhoto);
    state.journal = state.journal.filter((e) => e !== entry);
    if (ui.sel === `entry:${entry.id}`) ui.sel = null;
    save(); render(); drawMap(false);
  },
  'cancel-entry'() { closeEntryDraft(); render(); },
  'save-entry'() {
    const jd = ui.jdraft;
    if (jd.busy) return;
    const text = jd.data.text.trim();
    if (!text && !jd.data.photos.length && !jd.data.place) {
      jd.error = 'Schreib etwas, füge ein Foto hinzu oder wähle einen Ort.';
      render(); return;
    }
    const old = state.journal.find((e) => e.id === jd.entryId);
    const entry = {
      id: old ? old.id : uid(),
      dayId: jd.dayId,
      at: old ? old.at : new Date().toISOString(),
      text,
      place: jd.data.place,
      photos: jd.data.photos,
    };
    jd.removed.forEach(forgetPhoto);
    if (old) state.journal[state.journal.indexOf(old)] = entry; else state.journal.push(entry);
    closeEntryDraft(true);
    save(); render(); drawMap(false);
  },
  'remove-photo'(el) {
    const jd = ui.jdraft;
    const id = el.dataset.photo;
    jd.data.photos = jd.data.photos.filter((p) => p !== id);
    if (jd.added.includes(id)) { jd.added = jd.added.filter((p) => p !== id); forgetPhoto(id); } else jd.removed.push(id);
    render();
  },
  'my-location'() {
    const jd = ui.jdraft;
    if (!navigator.geolocation) { jd.error = 'Dein Browser kann den Standort nicht abfragen. Wähle den Ort über „Karte“.'; render(); return; }
    jd.locating = true; jd.error = null;
    render();
    navigator.geolocation.getCurrentPosition((pos) => {
      if (ui.jdraft !== jd) return;
      jd.locating = false;
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      const place = { name: 'Mein Standort', label: `Genauigkeit ca. ${Math.round(accuracy)} m`, lat, lon };
      setPlace('jdraft:place', place);
      reverseGeocode(place);
    }, (err) => {
      if (ui.jdraft !== jd) return;
      jd.locating = false;
      jd.error = err.code === 1
        ? 'Der Standortzugriff wurde nicht erlaubt. Erlaube ihn in den Browser-Einstellungen oder wähle den Ort über „Karte“.'
        : 'Der Standort konnte nicht ermittelt werden. Wähle den Ort über „Karte“.';
      render();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  },
  async 'open-photo'(el) {
    const url = await photoURL(el.dataset.photo);
    if (!url) return;
    $('#lightbox-img').src = url;
    $('#lightbox').hidden = false;
  },
  'close-photo'() { $('#lightbox').hidden = true; $('#lightbox-img').removeAttribute('src'); },
  today() {
    const i = todayIndex();
    if (i < 0) return;
    const id = state.days[i].id;
    ui.focusDay = id; ui.sel = null;
    render(); drawMap(true);
    scrollToDay(id);
  },
  'toggle-map'() {
    const hidden = $('.app').classList.toggle('map-hidden');
    $('#map-toggle').textContent = hidden ? 'Karte zeigen' : 'Karte ausblenden';
    if (!hidden) setTimeout(() => map.invalidateSize(), 50);
  },
  async export() {
    const btn = $('[data-action="export"]');
    btn.disabled = true; btn.textContent = 'Sicherung wird erstellt…';
    try {
      const photos = {};
      for (const id of state.journal.flatMap((e) => e.photos)) {
        const blob = await photoStore.get(id).catch(() => null);
        if (blob) photos[id] = await blobToDataURL(blob);
      }
      const data = { ...state, exportedAt: new Date().toISOString(), photos };
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const slug = state.title.toLowerCase().replace(/[^a-z0-9äöüß]+/gi, '-').replace(/^-|-$/g, '') || 'reise';
      a.download = `${slug}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (err) {
      alert(`Export fehlgeschlagen: ${err.message}`);
    } finally {
      btn.disabled = false; btn.textContent = 'Exportieren';
    }
  },
  sample() {
    if (!confirm('Die aktuelle Reise inklusive Tagebuch durch die Beispielreise ersetzen? Exportiere sie vorher, wenn du sie behalten willst.')) return;
    state.journal.flatMap((e) => e.photos).forEach(forgetPhoto);
    state = sampleTrip(); closeDraft(); closeEntryDraft(); ui.focusDay = null; ui.sel = null;
    save(); render(); drawMap(true);
  },
  'clear-all'() {
    if (!confirm('Alle Tage und das Tagebuch löschen und eine leere Reise beginnen? Exportiere vorher, wenn du sie behalten willst.')) return;
    state.journal.flatMap((e) => e.photos).forEach(forgetPhoto);
    state = emptyTrip(); closeDraft(); closeEntryDraft(); ui.focusDay = null; ui.sel = null;
    save(); render(); drawMap(true);
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  actions[el.dataset.action](el);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.picker) picker(t.dataset.picker).query = t.value;
  else if (t.dataset.draft === 'name' && ui.draft) ui.draft.data.name = t.value;
  else if (t.dataset.jdraft === 'text' && ui.jdraft) ui.jdraft.data.text = t.value;
  else if (t.id === 'trip-title') { state.title = t.value; save(); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.draft && ui.draft) {
    const field = t.dataset.draft;
    if (field === 'roundtrip') ui.draft.data.roundtrip = t.checked;
    else if (field === 'mode') ui.draft.data.mode = t.value;
    else if (field === 'fromMode') {
      ui.draft.data.fromMode = t.value;
      render();
      if (t.value === 'custom') document.querySelector('[data-picker="draft:from"]')?.focus();
    }
  } else if (t.id === 'start-date' && t.value) {
    state.startDate = t.value; save(); render(); drawMap(false);
  } else if (t.id === 'jdraft-photos' && t.files.length) {
    const files = [...t.files];
    t.value = '';
    addPhotos(files);
  } else if (t.id === 'import-file' && t.files[0]) {
    importFile(t.files[0]).finally(() => { t.value = ''; });
  }
});

async function importFile(file) {
  try {
    const raw = JSON.parse(await file.text());
    const next = normalizeTrip(raw);
    const dayIds = new Set(next.days.map((d) => d.id));
    // Reiseplan ohne Tagebuch importiert: vorhandenes Tagebuch behalten, soweit die Tage noch existieren.
    if (!next.journal.length && state.journal.length) {
      const keep = state.journal.filter((e) => dayIds.has(e.dayId));
      const lost = state.journal.length - keep.length;
      if (!confirm(`Reiseplan importieren? Dein Tagebuch bleibt erhalten${lost ? `, aber ${lost} Eintrag/Einträge gehören zu Tagen, die es in der Datei nicht gibt, und werden entfernt` : ''}.`)) return;
      next.journal = keep;
    } else if (state.journal.length && !confirm('Import ersetzt deine aktuelle Reise inklusive Tagebuch. Fortfahren?')) {
      return;
    }
    next.journal = next.journal.filter((e) => dayIds.has(e.dayId));
    if (raw.photos && typeof raw.photos === 'object') {
      for (const [id, dataUrl] of Object.entries(raw.photos)) {
        const blob = await (await fetch(dataUrl)).blob();
        await photoStore.put(id, blob);
        photoURLs.delete(id);
      }
    }
    state = next;
    closeDraft(); closeEntryDraft(true); ui.focusDay = null; ui.sel = null; ui.sel = null;
    save(); render(); drawMap(true);
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.action === 'select') {
    e.preventDefault();
    actions.select(e.target);
  } else if (e.key === 'Enter' && e.target.dataset?.picker) {
    e.preventDefault();
    searchPlace(e.target.dataset.picker);
  } else if (e.key === 'Escape' && !$('#lightbox').hidden) {
    actions['close-photo']();
  } else if (e.key === 'Escape' && ui.mapPick) {
    ui.mapPick = null; render();
  }
});

render();
drawMap(true);

// Auf dem Handy direkt zum heutigen Tag springen.
if (todayIndex() >= 0) setTimeout(() => scrollToDay(state.days[todayIndex()].id), 300);

// Browser bitten, die Daten nicht automatisch zu löschen (wird nicht überall gewährt).
navigator.storage?.persist?.().catch(() => {});

// Offline-Start und Installation auf dem Startbildschirm.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service Worker:', err.message));
}
