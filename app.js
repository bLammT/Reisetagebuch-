'use strict';

/*
 * Reisekarte – Prototyp
 *
 * Datenmodell (wird im localStorage gespeichert und als JSON exportiert):
 *   trip  = { title, startDate: 'YYYY-MM-DD', preNight: Night|null, days: [Day] }
 *           preNight = optionale Nacht vor dem ersten Tag
 *   Day   = { id, ...Night, trips: [Trip] }
 *           die Nacht eines Tages ist die Nacht nach ihm (zwischen diesem und dem nächsten Tag);
 *           beim letzten Tag ist sie optional
 *   Night = { night: Place|null, transit, journey: Journey|null }
 *           night = wo man schläft; transit = true: die Nacht wird unterwegs verbracht (z. B. Nachtzug)
 *   Journey = { from: Place|null, to: Place|null, mode }  nur bei transit
 *           from = null heißt: Abfahrt dort, wo man morgens aufgewacht ist
 *   Trip  = { id, name, from: Place|null, via: [Place], end: 'start'|'night'|'place', to: Place|null, mode }
 *           Start → Stopps (via) → Ende; from = null heißt: Start dort, wo man aufgewacht ist.
 *           end: 'start' = zurück zum Start (Ausflug), 'night' = zur Unterkunft der Nacht (Weiterreise), 'place' = zu „to“
 *   Place = { name, label, lat, lon, note? }  note = was man dort macht (nur bei Stopps)
 *   trip.journal = [Entry]
 *   Entry = { id, dayId, tripId?, at: ISO-Zeit, text, place: Place|null, photos: [photoId], links: [url] }
 *           tripId = Eintrag gehört zu diesem Trip (Ausflug/Weiterreise) und steht in der Liste darunter;
 *           fehlt der Trip, steht er wieder im Tagebuch des Tages
 *           Fotos liegen verkleinert in IndexedDB (zu groß für localStorage),
 *           mit Online-Sync zusätzlich auf dem Server (Tabelle photos, Schlüssel = photoId).
 *
 * Link zum Ansehen (…?server=…&trip=…&key=…): Die Reise wird ohne Konto nur angezeigt (Gastansicht).
 * Eigene Reise, Online-Sync und Anmeldung auf diesem Gerät bleiben dabei unberührt.
 */

const APP_VERSION = '2026-10-28.1';
const STORAGE_KEY = 'reisekarte.trip.v1';
const ROUTE_CACHE_KEY = 'reisekarte.routes.v1';

// Externe Dienste (öffentliche Instanzen, nur für geringe Last gedacht – siehe README).
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const PHOTON = 'https://photon.komoot.io';
const ROUTING = 'https://routing.openstreetmap.de';
const PROFILES = {
  car: { label: 'Auto', path: 'routed-car' },
  bike: { label: 'Fahrrad', path: 'routed-bike' },
  foot: { label: 'Zu Fuß', path: 'routed-foot' },
  bus: { label: 'Bus', path: 'routed-car' },
  // Ohne Routing: werden als direkte Verbindung gezeichnet.
  train: { label: 'Zug', path: null },
  flight: { label: 'Flug', path: null },
  ferry: { label: 'Fähre', path: null },
};
// Verkehrsmittel für eine Nacht unterwegs.
const JOURNEY_MODES = ['train', 'bus', 'ferry', 'flight', 'car'];

const DAY_COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#ae3ec9', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];
const TRANSFER_COLOR = '#1d2b33';
const SAME_PLACE_KM = 0.3;

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Kurze Meldung unten am Bildschirm (Fehler bleiben länger stehen).
let toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.toggle('is-error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 9000 : 4000);
}
window.addEventListener('error', (e) => { if (e.message) showToast(`Da ist etwas schiefgegangen: ${e.message}`, true); });
window.addEventListener('unhandledrejection', (e) => showToast(`Da ist etwas schiefgegangen: ${e.reason?.message || e.reason}`, true));

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
  const day = (night, trips = []) => ({ id: uid(), night: night && clone(night), transit: false, journey: null, trips });
  const trip = (name, via, opts = {}) => ({
    id: uid(), name, from: null, via, end: 'start', to: null, mode: 'car', ...opts,
  });
  return {
    title: 'Südtirol im Juni (Beispiel)',
    journal: [],
    startDate: '2026-06-12',
    preNight: null,
    days: [
      day(meran),
      day(meran, [trip('Wanderung zum Schloss Tirol', [P('Schloss Tirol', 'Dorf Tirol, Südtirol', 46.6927, 11.1505)], { mode: 'foot' })]),
      day(meran, [trip('Weinstraße und Bozen', [
        { ...P('Kaltern', 'Kaltern an der Weinstraße', 46.4140, 11.2420), note: 'Weinprobe am See' },
        P('Bozen', 'Südtirol, Italien', 46.4983, 11.3548),
      ])]),
      day(brixen, [trip('Weiter nach Brixen', [{ ...P('Klausen', 'Südtirol, Italien', 46.6390, 11.5660), note: 'Mittagessen in der Altstadt' }], { end: 'night' })]),
      day(brixen, [trip('Ausflug ins Grödnertal', [P('St. Ulrich', 'Gröden, Südtirol', 46.5770, 11.6720)])]),
      day(null, [trip('Spaziergang Kloster Neustift', [P('Kloster Neustift', 'Vahrn, Südtirol', 46.7360, 11.6580)], { mode: 'foot' })]),
    ],
  };
}

function emptyTrip() {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { title: 'Meine Reise', startDate: iso, preNight: null, days: [{ id: uid(), night: null, transit: false, journey: null, trips: [] }], journal: [] };
}

function normalizePlace(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const out = { name: String(p.name || 'Ort'), label: String(p.label || ''), lat, lon };
  const note = String(p.note || '').trim().slice(0, 200);
  if (note) out.note = note;
  return out;
}
function normalizeJourney(j) {
  const o = j && typeof j === 'object' ? j : {};
  return { from: normalizePlace(o.from), to: normalizePlace(o.to), mode: JOURNEY_MODES.includes(o.mode) ? o.mode : 'train' };
}
const isWebLink = (u) => /^https?:\/\/\S+$/i.test(String(u));
function normalizeNight(n) {
  const o = n && typeof n === 'object' ? n : {};
  const night = normalizePlace(o.night);
  const transit = Boolean(o.transit) && !night;
  return { night, transit, journey: transit ? normalizeJourney(o.journey) : null };
}
const TRIP_ENDS = ['start', 'night', 'place'];
function normalizeEx(x) {
  const via = (Array.isArray(x.via) ? x.via : []).map(normalizePlace).filter(Boolean);
  let to = normalizePlace(x.to);
  let end = TRIP_ENDS.includes(x.end) ? x.end : null;
  if (!end) {
    // Altes Format: Ziel + Rundtour ja/nein. Bei einer Rundtour ist das Ziel der letzte Stopp.
    end = x.roundtrip ? 'start' : 'place';
    if (x.roundtrip && to) { via.push(to); to = null; }
  }
  if (end !== 'place') to = null;
  return { id: String(x.id || uid()), name: String(x.name || ''), from: normalizePlace(x.from), via, end, to, mode: PROFILES[x.mode] ? x.mode : 'car' };
}
const exValid = (x) => (x.end === 'place' ? Boolean(x.to) : x.end === 'start' ? x.via.length > 0 : true);
function normalizeTrip(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.days)) throw new Error('Keine gültige Reisedatei.');
  return {
    title: String(t.title || 'Meine Reise'),
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(t.startDate) ? t.startDate : emptyTrip().startDate,
    preNight: t.preNight ? normalizeNight(t.preNight) : null,
    days: t.days.map((d) => ({
      id: String(d.id || uid()),
      ...normalizeNight(d),
      trips: (Array.isArray(d.trips) ? d.trips : []).map(normalizeEx).filter(exValid),
    })),
    journal: (Array.isArray(t.journal) ? t.journal : []).map((e) => ({
      id: String(e.id || uid()),
      dayId: String(e.dayId || ''),
      ...(e.tripId ? { tripId: String(e.tripId) } : {}),
      at: String(e.at || new Date().toISOString()),
      text: String(e.text || ''),
      place: normalizePlace(e.place),
      photos: (Array.isArray(e.photos) ? e.photos : []).map(String),
      links: (Array.isArray(e.links) ? e.links : []).map(String).filter(isWebLink),
    })),
  };
}

/* ---------------------------------------------------------------- Zustand */

// Gastansicht über einen Link zum Ansehen; der zuletzt geladene Stand liegt für offline getrennt von der eigenen Reise.
const GUEST_KEY = 'reisekarte.guest.v1';
const guest = (() => {
  const p = new URLSearchParams(location.search);
  const trip = p.get('trip'), key = p.get('key'), server = p.get('server');
  if (!trip || !key || !server) return null;
  try {
    const u = new URL(server);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) return null;
    return { url: u.origin, trip, key, pb: null, updated: null, error: null, offline: false };
  } catch {
    return null;
  }
})();
const guestCache = () => {
  const c = guest && loadJSON(GUEST_KEY, null);
  return c && c.trip === guest.trip ? c : null;
};

let state;
try {
  const saved = guest ? guestCache()?.data : loadJSON(STORAGE_KEY, null);
  state = saved ? normalizeTrip(saved) : guest ? emptyTrip() : sampleTrip();
  if (guest) guest.updated = guestCache()?.updated || null;
} catch {
  state = guest ? emptyTrip() : sampleTrip();
}

const ui = {
  focus: null, // hervorgehobener Tag oder hervorgehobene Nacht: 'day:<dayId>' oder 'night:<nightId>'
  sel: null, // ausgewähltes Element: 'trip:<id>', 'transfer:<dayId>', 'stay:<dayId>' oder 'entry:<id>'
  draft: null, // { dayId, exId|null, data, error }
  pickers: {}, // key -> { query, results, loading, error, editing }
  mapPick: null, // key des Ortes, der per Kartenklick gesetzt wird
  jdraft: null, // Tagebucheintrag in Bearbeitung: { dayId, entryId|null, data, added, removed, error, busy, locating }
  openNight: null, // Nacht nach dem letzten Tag, die gerade eingetragen wird
  journeyOpen: new Set(), // Nächte unterwegs, deren Felder trotz vollständiger Angaben offen sind
  collapsed: new Set(loadJSON('reisekarte.collapsed.v1', [])), // eingeklappte Tage (nur auf diesem Gerät)
};
function saveCollapsed() {
  if (guest) return; // gehört zur eigenen Reise
  ui.collapsed.forEach((id) => { if (!dayById(id)) ui.collapsed.delete(id); }); // gelöschte Tage vergessen
  saveJSON('reisekarte.collapsed.v1', [...ui.collapsed]);
}

// Online-Sync (siehe Abschnitt weiter unten). Gespeichert wird nur die Verknüpfung, die Anmeldung hält das PocketBase-SDK.
const SYNC_KEY = 'reisekarte.sync.v1';
const syncCfg = { url: '', tripId: null, tripTitle: '', remoteUpdated: null, dirty: false, role: 'owner', ...loadJSON(SYNC_KEY, {}) };
// Mit dir nur zum Lesen geteilt: Die App zeigt alles, ändert aber nichts.
const readOnly = () => Boolean(guest) || (Boolean(syncCfg.tripId) && syncCfg.role === 'viewer');
const sync = {
  pb: null, // PocketBase-Client, sobald eine Server-Adresse eingetragen ist
  methods: null, // Anmeldearten des Servers
  trips: null, // Liste der Online-Reisen zur Auswahl
  error: null, offline: false, busy: false, pushing: false, pushAgain: false, timer: null,
  version: 0, // zählt lokale Änderungen, damit eine Änderung während des Hochladens nicht verloren geht
};
// Fotos der verknüpften Reise auf dem Server: Schlüssel = Foto-ID der App.
const photoSync = {
  records: null, // Map key -> Datensatz, null = noch nicht geladen
  loading: null, loadedAt: 0,
  unsupported: false, // Server ohne Tabelle photos (Add-on älter als 0.2.0)
  uploading: false, pending: 0, error: null,
  downloads: new Map(), // laufende oder kürzlich fehlgeschlagene Downloads
  token: null, tokenAt: 0,
};

function save() {
  if (guest) return; // Gastansicht: nichts speichern, die eigene Reise bleibt, wie sie ist
  saveJSON(STORAGE_KEY, state);
  markDirty();
}

const dayIndex = (id) => state.days.findIndex((d) => d.id === id);
const dayById = (id) => state.days.find((d) => d.id === id);
const dayColor = (i) => DAY_COLORS[i % DAY_COLORS.length];
const entriesOf = (dayId) => state.journal.filter((e) => e.dayId === dayId).sort((a, b) => a.at.localeCompare(b.at));
// Trip, zu dem ein Eintrag (oder Entwurf) gehört, falls es ihn an diesem Tag noch gibt.
const entryTrip = (dayId, tripId) => (tripId && dayById(dayId)?.trips.some((x) => x.id === tripId) ? tripId : null);

// Tagebucheinträge ohne passenden Tag verwerfen.
state.journal = state.journal.filter((e) => dayById(e.dayId));

function kmBetween(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const samePlace = (a, b) => Boolean(a && b && kmBetween(a, b) < SAME_PLACE_KM);

// Nächte: Index k = Nacht nach Tag k; k = -1 ist die optionale Nacht vor dem ersten Tag.
const PRE = 'pre';
const nightAt = (k) => (k < 0 ? state.preNight : state.days[k]) || null;
const nightId = (k) => (k < 0 ? PRE : state.days[k].id);
const nightIndex = (id) => (id === PRE ? -1 : dayIndex(id));
const nightById = (id) => (id === PRE ? state.preNight : dayById(id));
// Nummer der Nacht in der Reise (die Nacht vor Tag 1 ist Nacht 1).
const nightNo = (k) => k + 1 + (state.preNight ? 1 : 0);
// Zeitposition für die Karte: Nacht vor Tag 1 = 0, Tag i = 2i+1, Nacht nach Tag k = 2k+2.
const dayPos = (i) => 2 * i + 1;
const nightPos = (k) => 2 * k + 2;
function focusPos() {
  const [type, id] = (ui.focus || '').split(':');
  if (type === 'day') { const i = dayIndex(id); return i >= 0 ? dayPos(i) : -1; }
  if (type === 'night') {
    const k = nightIndex(id);
    return (k < 0 && (id !== PRE || !state.preNight)) ? -1 : nightPos(k);
  }
  return -1;
}
const hasNight = (n) => Boolean(n && (n.night || n.transit));

// Wo wacht man an Tag i auf? In der Unterkunft der Vornacht oder nach einer Nacht unterwegs am Ankunftsort.
function morningPlace(i) {
  const prev = nightAt(i - 1);
  return prev?.night || (prev?.transit && prev.journey?.to) || null;
}
// Wo startet man an Tag i? Wo man aufgewacht ist, am Anreisetag in der eigenen Unterkunft.
function stayPlaceFor(i) {
  return morningPlace(i) || state.days[i].night || null;
}
// Wohin geht es abends? Zur Unterkunft oder bei einer Nacht unterwegs zum Abfahrtsort.
function eveningPlace(i) {
  const d = state.days[i];
  return d.night || (d.transit && d.journey?.from) || null;
}
// Nacht unterwegs mit Start und Ziel; ohne Startort gilt der Ort, an dem man morgens war.
function journeyFor(k) {
  const n = nightAt(k);
  if (!n?.transit || !n.journey) return null;
  const from = n.journey.from || (k >= 0 ? morningPlace(k) : null);
  const to = n.journey.to;
  return from && to ? { from, to, mode: n.journey.mode } : null;
}
function endPlace(i, ex) {
  if (ex.end === 'start') return ex.from || stayPlaceFor(i);
  if (ex.end === 'night') return eveningPlace(i);
  return ex.to;
}
function waypoints(i, ex) {
  const start = ex.from || stayPlaceFor(i);
  const end = endPlace(i, ex);
  if (!start || !end) return [];
  return [start, ...ex.via, end];
}
// Ortswechsel: neue Unterkunft, und kein einfacher Ausflug des Tages endet schon dort.
function transferFor(i) {
  const a = morningPlace(i), b = state.days[i].night;
  if (!a || !b || samePlace(a, b)) return null;
  const covered = state.days[i].trips.some((ex) => ex.end !== 'start' && samePlace(endPlace(i, ex), b));
  return covered ? null : { from: a, to: b };
}
// Aufeinanderfolgende Nächte am selben Ort zusammenfassen (from/to = Index der Nacht, -1 = vor Tag 1).
function stayGroups() {
  const groups = [];
  for (let k = -1; k < state.days.length; k++) {
    const n = nightAt(k);
    if (!n?.night) continue;
    const last = groups[groups.length - 1];
    if (last && last.to === k - 1 && samePlace(last.place, n.night)) last.to = k;
    else groups.push({ place: n.night, from: k, to: k });
  }
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
function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
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
    updateRetryBtn();
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
function journeyStats(k) {
  const j = journeyFor(k);
  return j ? legStats(j.mode, [j.from, j.to]) : null;
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
    if (kind === 'journey') { el.textContent = fmtStats(journeyStats(nightIndex(a))); return; }
    const i = dayIndex(a);
    if (i < 0) return;
    if (kind === 'ex') {
      const ex = state.days[i].trips.find((x) => x.id === b);
      el.textContent = ex ? fmtStats(exStats(i, ex)) : '';
    } else if (kind === 'transfer') {
      el.textContent = fmtStats(transferStats(i));
    } else if (kind === 'day') {
      const parts = [transferStats(i), ...state.days[i].trips.map((ex) => exStats(i, ex)), journeyStats(i)].filter(Boolean);
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
  const blob = (await photoStore.get(id).catch(() => null)) || (await downloadPhoto(id));
  if (!blob) return null;
  if (photoURLs.has(id)) return photoURLs.get(id);
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
// Kartenstil: Der deutsche OSM-Stil beschriftet mit deutschen bzw. lateinischen Namen, der Standard in Landessprache.
const TILES_KEY = 'reisekarte.tiles.v1';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende · Routen: <a href="https://routing.openstreetmap.de/">FOSSGIS</a>';
const baseLayers = {
  'Deutsch / lateinische Schrift': L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: `${OSM_ATTR} · Stil: <a href="https://www.openstreetmap.de/">OSM Deutschland</a>`,
  }),
  'Landessprache (OSM Standard)': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: OSM_ATTR }),
};
(baseLayers[loadJSON(TILES_KEY, '')] || Object.values(baseLayers)[0]).addTo(map);
L.control.layers(baseLayers, null, { position: 'topleft' }).addTo(map);
map.on('baselayerchange', (e) => saveJSON(TILES_KEY, e.name));
const routeLayer = L.layerGroup().addTo(map);
// Eigene Ebenen, damit ausgegraute Linien nie über dem hervorgehobenen Tag liegen (auch nicht auf derselben Straße).
map.createPane('routes-faded').style.zIndex = 390;
map.createPane('routes-top').style.zIndex = 410;
const PANE = { past: 'routes-faded', future: 'routes-faded', selected: 'routes-top', soft: 'overlayPane', normal: 'overlayPane' };
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
const DASH = { flight: '1 9', train: '12 6', ferry: '2 7' };

// level: 'normal', 'selected' (angeklickt), 'soft' (gleicher Tag, nicht angeklickt),
// 'past' (früherer Tag: schon gefahren, kräftiges Grau), 'future' (späterer Tag: kommt noch, blass)
const LINE_OPACITY = { normal: 0.95, selected: 1, soft: 0.45, past: 0.75, future: 0.3 };
const FADED_COLOR = '#7b868d';
const isFaded = (level) => level === 'past' || level === 'future';
// Alle Linien der aktuellen Zeichnung in Zeichenreihenfolge (für den Aufbau des hervorgehobenen Tages).
let drawnLines = [];
function drawLine(latlngs, color, { pos, level = 'normal', approx, weight, tooltip, dash, onClick }) {
  const faded = isFaded(level);
  const w = level === 'selected' ? weight + 3 : level === 'past' ? Math.max(weight - 1, 2) : level === 'future' ? Math.max(weight - 2, 2) : weight;
  const pane = PANE[level];
  // Der breitere weiße Rand ist mit anklickbar, damit man die Linie auch auf dem Handy trifft.
  // Ausgegraute Linien bekommen keinen sichtbaren Rand, sonst decken sie den hervorgehobenen Tag ab.
  const halo = L.polyline(latlngs, {
    pane, color: '#ffffff', weight: w + 8, opacity: faded ? 0 : LINE_OPACITY[level] * 0.9, interactive: Boolean(onClick),
  }).addTo(routeLayer);
  const line = L.polyline(latlngs, {
    pane, color: faded ? FADED_COLOR : color, weight: w, opacity: LINE_OPACITY[level],
    dashArray: dash || (approx ? '6 9' : null), lineCap: 'round', lineJoin: 'round',
  }).addTo(routeLayer);
  if (tooltip) { line.bindTooltip(tooltip, { sticky: true }); halo.bindTooltip(tooltip, { sticky: true }); }
  if (onClick) { line.on('click', onClick); halo.on('click', onClick); }
  drawnLines.push({ pos, latlngs, parts: [halo, line] });
}

// Wird ein anderer Tag (oder eine andere Nacht) hervorgehoben, zeichnen sich die Linien nacheinander vom Start bis zum Ende.
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
let animatedFocus = null; // Tag oder Nacht, deren Aufbau schon lief (beim Neuzeichnen nicht noch einmal)
let lineAnim = 0;
function animateLines(lines) {
  const run = ++lineAnim;
  // Länge je Linie (grob in km), damit lange Strecken länger brauchen als kurze.
  const segs = lines.map((l) => {
    const cum = [0];
    for (let k = 1; k < l.latlngs.length; k++) {
      const [a, b] = [l.latlngs[k - 1], l.latlngs[k]];
      cum.push(cum[k - 1] + kmBetween({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }));
    }
    return { ...l, cum, len: cum[cum.length - 1] };
  }).filter((l) => l.len > 0);
  if (!segs.length) return;
  const total = segs.reduce((n, l) => n + l.len, 0);
  // Insgesamt höchstens 2,5 s, jede Linie mindestens 0,4 s.
  const TOTAL_MS = Math.min(2500, 700 * segs.length + 400);
  segs.forEach((l) => { l.ms = Math.max(400, (TOTAL_MS * l.len) / total); });
  const prefix = (l, t) => {
    const d = l.len * t;
    let k = 1;
    while (k < l.cum.length - 1 && l.cum[k] < d) k++;
    const [a, b] = [l.latlngs[k - 1], l.latlngs[k]];
    const f = l.cum[k] > l.cum[k - 1] ? (d - l.cum[k - 1]) / (l.cum[k] - l.cum[k - 1]) : 1;
    return [...l.latlngs.slice(0, k), [a[0] + (b[0] - a[0]) * Math.min(f, 1), a[1] + (b[1] - a[1]) * Math.min(f, 1)]];
  };
  segs.forEach((l) => l.parts.forEach((p) => p.setLatLngs([l.latlngs[0]])));
  let idx = 0, t0 = performance.now();
  const step = (now) => {
    if (run !== lineAnim) return; // inzwischen neu gezeichnet
    const l = segs[idx];
    const t = Math.min((now - t0) / l.ms, 1);
    const eased = 1 - (1 - t) ** 2;
    l.parts.forEach((p) => p.setLatLngs(t < 1 ? prefix(l, eased) : l.latlngs));
    if (t >= 1) {
      if (++idx >= segs.length) return;
      t0 = now;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Punkte je Tag und Nacht ('day:<id>', 'night:<id>', für „Karte folgt der Liste“), wird bei jedem Zeichnen neu gefüllt.
let timePts = new Map();
const addTimePts = (fkey, ll) => { if (!timePts.has(fkey)) timePts.set(fkey, []); timePts.get(fkey).push(...ll); };

function fitPoints(pts, close) {
  if (pts.length === 1) map.setView(pts[0], close ? Math.max(map.getZoom(), 14) : 12);
  else if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 14 });
}

let selMarkerNow = null; // Pin des ausgewählten Elements in der aktuellen Zeichnung

function drawMap(fit) {
  redrawAfterPopup = false; // wird gerade ohnehin komplett neu gezeichnet
  routeLayer.clearLayers();
  markerLayer.clearLayers();
  drawnLines = [];
  lineAnim++; // laufenden Aufbau abbrechen, die Linien sind gleich neu
  const all = [];
  const focus = [];
  const fp = focusPos(); // -1: nichts hervorgehoben
  const fi = fp % 2 === 1 ? (fp - 1) / 2 : -1; // hervorgehobener Tag
  const fk = fp >= 0 && fp % 2 === 0 ? fp / 2 - 1 : null; // hervorgehobene Nacht
  const sel = ui.sel;
  const selPts = [];
  let selMarker = null;
  // Stufe eines Elements (pos = Zeitposition): angeklickt, gleicher Tag/gleiche Nacht wie das Angeklickte,
  // früher oder später als der hervorgehobene Tag bzw. die Nacht, oder nichts ausgewählt.
  const levelOf = (pos, key) => {
    if (sel === key) return 'selected';
    if (fp >= 0 && fp !== pos) return pos < fp ? 'past' : 'future';
    if (sel && fp === pos) return 'soft';
    return 'normal';
  };
  const MARKER_OPACITY = { normal: 1, selected: 1, soft: 0.5, past: 0.75, future: 0.35 };
  timePts = new Map();
  const pick = (key, fkey) => (e) => { if (!ui.mapPick) { L.DomEvent.stopPropagation(e); selectFromMap(key, fkey); } };

  state.days.forEach((d, i) => {
    const pos = dayPos(i);
    const fkey = `day:${d.id}`;
    const collect = (ll, key) => {
      all.push(...ll);
      addTimePts(fkey, ll);
      if (fp === pos) focus.push(...ll);
      if (sel === key) selPts.push(...ll);
    };
    const color = dayColor(i);

    const t = transferFor(i);
    if (t) {
      const key = `transfer:${d.id}`;
      const r = getRoute('car', [t.from, t.to]);
      const ll = r && r.coords ? r.coords : [[t.from.lat, t.from.lon], [t.to.lat, t.to.lon]];
      drawLine(ll, TRANSFER_COLOR, { pos, level: levelOf(pos, key), approx: !(r && r.coords), weight: 5, tooltip: `Tag ${i + 1}: Ortswechsel ${esc(t.from.name)} → ${esc(t.to.name)}`, onClick: pick(key, fkey) });
      collect(ll, key);
    }

    d.trips.forEach((ex) => {
      const pts = waypoints(i, ex);
      if (pts.length < 2) return;
      const key = `trip:${ex.id}`;
      const level = levelOf(pos, key);
      const r = getRoute(ex.mode, pts);
      const ll = legLatLngs(ex.mode, pts, r);
      drawLine(ll, color, {
        pos, level, approx: !(r && r.coords), weight: 4, dash: DASH[ex.mode],
        tooltip: `Tag ${i + 1}: ${esc(tripTitle(i, ex))} (${PROFILES[ex.mode].label})`,
        onClick: pick(key, fkey),
      });
      collect(ll, key);

      const op = MARKER_OPACITY[level];
      const big = level === 'selected' ? 2 : 0;
      // Stopps; das Ende nur, wenn es nicht der Start oder die Unterkunft ist (die haben eigene Pins).
      const stops = [...ex.via, ...(ex.end === 'place' ? [ex.to] : [])];
      stops.forEach((p, k) => {
        const isGoal = ex.end === 'place' && k === stops.length - 1;
        L.circleMarker([p.lat, p.lon], {
          pane: PANE[level], radius: (isGoal ? 7 : 6) + big, color: '#ffffff', weight: 2,
          fillColor: isFaded(level) ? FADED_COLOR : color, fillOpacity: op, opacity: op,
        }).bindTooltip(`${esc(p.name)}${p.note ? ` · ${esc(p.note)}` : ''}<br><small>Tag ${i + 1} · ${isGoal ? 'Ziel' : `Stopp ${k + 1}`}</small>`).on('click', pick(key, fkey)).addTo(markerLayer);
      });
      if (ex.from) {
        L.circleMarker([ex.from.lat, ex.from.lon], {
          pane: PANE[level], radius: 6 + big, color: isFaded(level) ? FADED_COLOR : color, weight: 3, fillColor: '#ffffff', fillOpacity: 1, opacity: op,
        }).bindTooltip(`${esc(ex.from.name)}<br><small>Tag ${i + 1} · Start</small>`).on('click', pick(key, fkey)).addTo(markerLayer);
      }
    });

    drawJourney(i);
  });
  if (state.days.length) drawJourney(-1);

  // Nacht unterwegs: eigene Zeitposition zwischen den Tagen.
  function drawJourney(k) {
    const j = journeyFor(k);
    if (j) {
      const pos = nightPos(k);
      const fkey = `night:${nightId(k)}`;
      const key = `journey:${nightId(k)}`;
      const level = levelOf(pos, key);
      const r = getRoute(j.mode, [j.from, j.to]);
      const ll = legLatLngs(j.mode, [j.from, j.to], r);
      drawLine(ll, TRANSFER_COLOR, {
        pos, level, approx: !(r && r.coords), weight: 5, dash: DASH[j.mode],
        tooltip: `Nacht ${nightNo(k)} unterwegs: ${esc(j.from.name)} → ${esc(j.to.name)} (${PROFILES[j.mode].label})`,
        onClick: pick(key, fkey),
      });
      all.push(...ll);
      addTimePts(fkey, ll);
      if (fp === pos) focus.push(...ll);
      if (sel === key) selPts.push(...ll);
      const op = MARKER_OPACITY[level];
      [j.from, j.to].forEach((p, n) => {
        L.circleMarker([p.lat, p.lon], {
          pane: PANE[level], radius: 6, color: '#ffffff', weight: 2, fillColor: isFaded(level) ? FADED_COLOR : TRANSFER_COLOR, fillOpacity: op, opacity: op,
        }).bindTooltip(`${esc(p.name)}<br><small>Nacht ${nightNo(k)} · ${n ? 'Ankunft' : 'Abfahrt'}</small>`).on('click', pick(key, fkey)).addTo(markerLayer);
      });
    }
  }

  const selStayPlace = sel?.startsWith('stay:') ? nightById(sel.slice(5))?.night : null;

  stayPins().forEach((pin) => {
    const isSel = samePlace(pin.place, selStayPlace);
    // Eine Unterkunft betrifft den Ankunftstag, ihre Nächte, die Tage dazwischen und den Abreisetag.
    const span = (g) => [dayPos(g.from), dayPos(g.to + 1)];
    const relevant = isSel || (fp >= 0 && pin.ranges.some((g) => fp >= span(g)[0] && fp <= span(g)[1]));
    // Bei Ausflug oder Ortswechsel bleibt die Unterkunft des Tages sichtbar, bei Unterkunft/Eintrag nur das Angeklickte.
    const pinOnly = Boolean(sel) && (sel.startsWith('stay:') || sel.startsWith('entry:'));
    const faded = (fp >= 0 && !relevant) || (pinOnly && !isSel);
    // Ausgegraute Unterkunft: schon vorbei (kräftiger) oder kommt noch (blass).
    const past = faded && fp >= 0 && !relevant && pin.ranges.every((g) => span(g)[1] < fp);
    const nights = pin.ranges.reduce((n, g) => n + g.to - g.from + 1, 0);
    const nightsTxt = 'N' + pin.ranges.map((g) => (g.from === g.to ? `${nightNo(g.from)}` : `${nightNo(g.from)}–${nightNo(g.to)}`)).join(', ');
    const icon = L.divIcon({
      className: 'stay-icon',
      iconSize: [0, 0],
      iconAnchor: [0, 0],
      html: `<div class="pin${isSel ? ' is-selected' : past ? ' is-past' : faded ? ' is-faded' : ''}"><span class="pin-ico">⌂</span><span class="pin-name">${esc(pin.place.name)}</span><span class="pin-n">${nightsTxt}</span></div>`,
    });
    const periods = pin.ranges.map((g) => `${fmtDate(g.from)} bis ${fmtDate(g.to + 1)}`).join('<br>');
    const marker = L.marker([pin.place.lat, pin.place.lon], { icon, zIndexOffset: isSel ? 3000 : relevant ? 2000 : 1000 })
      .bindPopup(`<strong>${esc(pin.place.name)}</strong><br>${nights} ${nights === 1 ? 'Nacht' : 'Nächte'}<br>${periods}${pin.place.label ? `<br><small>${esc(pin.place.label)}</small>` : ''}`)
      .addTo(markerLayer);
    // Angeklickt: zur hervorgehobenen Nacht bzw. der Nacht des hervorgehobenen Tages hier, sonst zur ersten.
    const inRange = (k) => k !== null && pin.ranges.some((x) => k >= x.from && k <= x.to);
    const nk = [fk, fi >= 0 ? fi : null, fi >= 0 ? fi - 1 : null].find(inRange) ?? pin.ranges[0].from;
    marker.on('click', pick(`stay:${nightId(nk)}`, `night:${nightId(nk)}`));
    const ll = [[pin.place.lat, pin.place.lon]];
    all.push(...ll);
    pin.ranges.forEach((x) => {
      for (let k = x.from; k <= x.to; k++) addTimePts(`night:${nightId(k)}`, ll);
      for (let k = Math.max(x.from, 0); k <= Math.min(x.to + 1, state.days.length - 1); k++) addTimePts(`day:${state.days[k].id}`, ll);
    });
    if (relevant) focus.push([pin.place.lat, pin.place.lon]);
    if (isSel) { selPts.push([pin.place.lat, pin.place.lon]); selMarker = marker; }
  });

  state.journal.forEach((e) => {
    if (!e.place) return;
    const i = dayIndex(e.dayId);
    const level = levelOf(dayPos(i), `entry:${e.id}`);
    const icon = L.divIcon({
      className: 'stay-icon', iconSize: [0, 0], iconAnchor: [0, 0],
      html: `<div class="jpin${level === 'selected' ? ' is-selected' : level === 'past' ? ' is-past' : level === 'future' || level === 'soft' ? ' is-faded' : ''}" style="--day:${dayColor(i)}">✎</div>`,
    });
    const trip = state.days[i]?.trips.find((x) => x.id === e.tripId);
    const excerpt = e.text.length > 220 ? `${e.text.slice(0, 220)}…` : e.text;
    const marker = L.marker([e.place.lat, e.place.lon], { icon, zIndexOffset: level === 'selected' ? 3500 : 1500 })
      .bindPopup(`<div class="jpop"><strong>Tag ${i + 1} · ${fmtDate(i)}</strong><br><small>${esc(e.place.name)} · ${timeFmt.format(new Date(e.at))}${trip ? ` · ${esc(tripTitle(i, trip))}` : ''}</small>${excerpt ? `<p>${esc(excerpt)}</p>` : ''}${e.photos[0] ? `<img class="jpop-img" data-photo-img="${e.photos[0]}" alt="Foto">` : ''}</div>`, { maxWidth: 260 })
      .on('click', pick(`entry:${e.id}`, `day:${e.dayId}`))
      .addTo(markerLayer);
    all.push([e.place.lat, e.place.lon]);
    addTimePts(`day:${e.dayId}`, [[e.place.lat, e.place.lon]]);
    if (fi === i) focus.push([e.place.lat, e.place.lon]);
    if (level === 'selected') { selPts.push([e.place.lat, e.place.lon]); selMarker = marker; }
  });

  // Hervorgehobener Tag: wo man morgens aufwacht und wo man abends schläft (bzw. abfährt).
  // Hervorgehobene Nacht: Abfahrt und Ankunft der Nacht unterwegs, sonst die Unterkunft.
  const tags = [];
  let tagColor = TRANSFER_COLOR;
  if (fi >= 0) {
    const morning = morningPlace(fi);
    const j = journeyFor(fi); // Nacht danach unterwegs: abends geht es am Abfahrtsort los
    const evening = j ? j.from : eveningPlace(fi);
    const eveningTxt = j ? '☾ Abfahrt' : '☾ Abends';
    tagColor = dayColor(fi);
    if (morning && evening && samePlace(morning, evening)) tags.push([morning, `☀ Start · ${eveningTxt}`]);
    else {
      if (morning) tags.push([morning, '☀ Start']);
      if (evening) tags.push([evening, eveningTxt]);
    }
  } else if (fk !== null) {
    const j = journeyFor(fk);
    if (j) tags.push([j.from, '☾ Abfahrt'], [j.to, '☀ Ankunft']);
    else if (nightAt(fk)?.night) tags.push([nightAt(fk).night, `☾ Nacht ${nightNo(fk)}`]);
  }
  {
    tags.forEach(([p, text]) => {
      L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: 'stay-icon', iconSize: [0, 0], iconAnchor: [0, 0], html: `<div class="day-tag" style="--day:${tagColor}">${text}</div>` }),
        interactive: false, keyboard: false, zIndexOffset: 2500,
      }).addTo(markerLayer);
    });
  }

  const focusKey = fp >= 0 ? ui.focus : null;
  if (focusKey !== animatedFocus) {
    animatedFocus = focusKey;
    if (focusKey && !reduceMotion?.matches) animateLines(drawnLines.filter((l) => l.pos === fp));
  }

  selMarkerNow = selMarker;
  if (fit) {
    const pts = selPts.length ? selPts : fp >= 0 && focus.length ? focus : all;
    fitPoints(pts, selPts.length > 0);
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

// Bevorzugter Name: Deutsch, Englisch, internationaler Name, sonst der Name vor Ort.
const NON_LATIN = /[^\u0000-\u024F\u1E00-\u1EFF\s\d\p{P}\p{S}]/u;
function pickName(nd, fallback) {
  const d = nd || {};
  return d['name:de'] || d['name:en'] || d.int_name || d['name:latin'] || d.name || fallback || '';
}
// Name vor Ort (z. B. auf Thai), wenn er anders lautet: steht in der Beschreibung, etwa zum Zeigen im Taxi.
function localName(nd, chosen, label = '') {
  return nd?.name && nd.name !== chosen && !label.includes(nd.name) ? nd.name : '';
}

// Suche auf den sichtbaren Kartenausschnitt beziehen (ab Länder-Zoom).
function searchBias() {
  if (map.getZoom() < 5) return null;
  return { b: map.getBounds().pad(0.5), c: map.getCenter() };
}

async function nominatimSearch(q, bias) {
  const vb = bias ? `&viewbox=${bias.b.getWest().toFixed(4)},${bias.b.getNorth().toFixed(4)},${bias.b.getEast().toFixed(4)},${bias.b.getSouth().toFixed(4)}` : '';
  const data = await nominatimFetch(`/search?format=jsonv2&limit=6&namedetails=1&accept-language=de,en&q=${encodeURIComponent(q)}${vb}`);
  return data.map((r) => {
    const name = pickName(r.namedetails, String(r.display_name).split(',')[0]);
    return { name, label: [localName(r.namedetails, name, r.display_name), r.display_name].filter(Boolean).join(' · '), lat: Number(r.lat), lon: Number(r.lon) };
  });
}

const PLACE_TYPES = {
  restaurant: 'Restaurant', cafe: 'Café', bar: 'Bar', pub: 'Kneipe', fast_food: 'Imbiss', food_court: 'Essensstände',
  hotel: 'Hotel', guest_house: 'Gästehaus', hostel: 'Hostel', motel: 'Motel', apartment: 'Ferienwohnung', resort: 'Resort',
  attraction: 'Sehenswürdigkeit', viewpoint: 'Aussichtspunkt', museum: 'Museum', waterfall: 'Wasserfall',
  place_of_worship: 'Tempel / Kirche', beach: 'Strand', peak: 'Gipfel', station: 'Bahnhof', aerodrome: 'Flughafen',
  bus_station: 'Busbahnhof', ferry_terminal: 'Fähranleger', marketplace: 'Markt', city: 'Stadt', town: 'Stadt', village: 'Dorf',
};

// Photon findet Restaurants, Hotels usw. besser und verzeiht Tippfehler; bevorzugt Treffer nahe der Kartenmitte.
async function photonSearch(q, bias) {
  const near = bias ? `&lat=${bias.c.lat.toFixed(4)}&lon=${bias.c.lng.toFixed(4)}` : '';
  const res = await fetch(`${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&lang=en${near}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const [lon, lat] = f.geometry?.coordinates || [];
    const street = [p.street, p.housenumber].filter(Boolean).join(' ');
    const parts = [PLACE_TYPES[p.osm_value], street, p.district, p.city, p.state, p.country].filter(Boolean);
    return { name: p.name || street || p.city || 'Ort', label: parts.filter((v, i) => parts.indexOf(v) === i).join(', '), lat: Number(lat), lon: Number(lon) };
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
}

// Links aus Google Maps (oder Apple Karten) mit Koordinaten im Link.
function parseMapsLink(q) {
  if (!/^https?:\/\//i.test(q)) return null;
  let u;
  try { u = new URL(q); } catch { return null; }
  if (/^(maps\.app\.goo\.gl|goo\.gl)$/i.test(u.hostname)) return { short: true };
  let s = u.href;
  try { s = decodeURIComponent(s); } catch { /* bleibt kodiert */ }
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
    || s.match(/[?&](?:q|query|ll|sll|daddr|destination|center)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
  if (!m) return { noCoords: true };
  const lat = Number(m[1]), lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { noCoords: true };
  const place = u.pathname.match(/\/place\/([^/]+)/);
  const qName = u.searchParams.get('q');
  let name = place ? place[1].replace(/\+/g, ' ') : qName && !/^-?\d/.test(qName) ? qName : '';
  try { name = decodeURIComponent(name); } catch { /* bleibt */ }
  return { name: name || `Punkt ${lat.toFixed(4)}, ${lon.toFixed(4)}`, label: 'Aus einem Karten-Link', lat, lon };
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
  const link = parseMapsLink(q);
  if (link?.short) {
    p.results = [];
    p.error = 'Kurzlinks (maps.app.goo.gl) kann der Browser nicht öffnen. Öffne den Ort in Google Maps, tippe lange auf die Stelle und kopiere die Koordinaten, die oben erscheinen (z. B. 18.7883, 98.9853). Am Computer geht auch die lange Adresse aus der Adresszeile.';
    render(); return;
  }
  if (link?.noCoords) { p.results = []; p.error = 'In diesem Link stehen keine Koordinaten. Kopiere stattdessen die Koordinaten aus der Karten-App (lange auf den Ort tippen).'; render(); return; }
  const direct = link || parseCoords(q);
  if (direct) { p.results = [direct]; p.error = null; render(); focusFirstResult(key); return; }
  p.loading = true; p.error = null; p.results = [];
  render();
  const bias = searchBias();
  const [ph, no] = await Promise.allSettled([photonSearch(q, bias), nominatimSearch(q, bias)]);
  const fromPhoton = ph.status === 'fulfilled' ? ph.value : [];
  const fromNominatim = no.status === 'fulfilled' ? no.value : [];
  if (ph.status === 'rejected') console.warn('Photon:', ph.reason?.message);
  if (no.status === 'rejected') console.warn('Nominatim:', no.reason?.message);
  // Photon zuerst; steht dort nur ein Name in fremder Schrift, den lateinischen Namen von Nominatim nehmen.
  const results = fromPhoton.map((r) => {
    if (!NON_LATIN.test(r.name)) return r;
    const twin = fromNominatim.find((x) => kmBetween(x, r) < 0.15 && !NON_LATIN.test(x.name));
    return twin ? { ...r, name: twin.name, label: [r.name, r.label].filter(Boolean).join(' · ') } : r;
  });
  fromNominatim.forEach((x) => { if (!results.some((r) => kmBetween(r, x) < 0.1)) results.push(x); });
  p.results = results.slice(0, 8);
  if (ph.status === 'rejected' && no.status === 'rejected') {
    p.error = 'Die Ortssuche ist gerade nicht erreichbar. Wähle den Ort über „Karte“ oder gib Koordinaten ein (z. B. 46.67, 11.15).';
  } else if (!p.results.length) {
    p.error = 'Nichts gefunden. Schieb die Karte in die Gegend und such noch einmal, oder setz den Ort über „Karte“ und gib ihm mit ✎ einen Namen.';
  }
  p.loading = false;
  render();
  focusFirstResult(key);
}

function focusFirstResult(key) {
  const btn = document.querySelector(`[data-action="pick-result"][data-key="${CSS.escape(key)}"]`);
  if (btn) btn.focus();
}

// Namen für einen per Karte oder Koordinaten gesetzten Ort: ein Restaurant, Hotel usw. an der Stelle, sonst der Ort.
const POI_CATEGORIES = ['amenity', 'tourism', 'shop', 'leisure', 'historic', 'building', 'railway', 'aeroway', 'natural', 'office', 'craft'];
async function reverseGeocode(place) {
  try {
    const r = await nominatimFetch(`/reverse?format=jsonv2&zoom=18&namedetails=1&accept-language=de,en&lat=${place.lat}&lon=${place.lon}`);
    const a = r.address || {};
    const poi = POI_CATEGORIES.includes(r.category) && r.name;
    const locality = a.village || a.town || a.city || a.hamlet || a.suburb || a.county;
    const name = poi ? pickName(r.namedetails, r.name) : locality || pickName(r.namedetails, String(r.display_name || '').split(',')[0]);
    if (!name || !/^Punkt /.test(place.name)) return; // inzwischen selbst benannt: nicht überschreiben
    place.name = name;
    place.label = [poi ? localName(r.namedetails, name, r.display_name) : '', r.display_name || place.label].filter(Boolean).join(' · ');
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
    const d = nightById(a);
    return { get: () => d?.night ?? null, set: (v) => { if (d) { d.night = v; if (v) { d.transit = false; d.journey = null; } } }, persist: true };
  }
  if (kind === 'jfrom' || kind === 'jto') {
    const d = nightById(a);
    const field = kind === 'jfrom' ? 'from' : 'to';
    return { get: () => d?.journey?.[field] ?? null, set: (v) => { if (d?.journey) d.journey[field] = v; }, persist: true };
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

const END_LABEL = { start: 'Ausflug', night: 'Weiterreise', place: 'Einfache Strecke' };

function tripTitle(i, ex) {
  if (ex.name) return ex.name;
  const end = endPlace(i, ex);
  if (ex.end === 'start') return `Ausflug: ${ex.via.map((p) => p.name).join(', ')}`;
  return end ? `Nach ${end.name}` : 'Weiterreise';
}

function pickerHTML(key, place, placeholder = 'Ort, Restaurant, Koordinaten oder Karten-Link') {
  const p = picker(key);
  if (place && !p.editing) {
    return `<div class="place">
      <div class="place-text"><span class="place-name">${esc(place.name)}</span><span class="place-label">${esc(place.label || `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`)}</span></div>
      <button class="icon-btn rename-btn" data-action="rename-place" data-key="${key}" aria-label="Namen ändern" title="Namen ändern">✎</button>
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
  const end = endPlace(i, ex);
  const stop = (p) => `${esc(p.name)}${p.note ? ` <span class="ex-note">(${esc(p.note)})</span>` : ''}`;
  const route = [start ? esc(start.name) : '?', ...ex.via.map(stop), end ? esc(end.name) : '?'].join(' → ');
  const key = `trip:${ex.id}`;
  return `<div class="ex selectable${ui.sel === key ? ' is-selected' : ''}" data-action="select" data-sel="${key}" data-day="${d.id}" role="button" tabindex="0" aria-pressed="${ui.sel === key}">
    <div class="ex-body">
      <div class="ex-title">${esc(tripTitle(i, ex))}</div>
      <div class="ex-route">${route}</div>
      <div class="ex-meta">
        <span class="chip">${END_LABEL[ex.end]}</span>
        <span class="chip">${PROFILES[ex.mode].label}</span>
        <span class="ex-stat" data-stat="ex:${d.id}:${ex.id}"></span>
      </div>
    </div>
    <div class="ex-actions">
      <button class="link-btn" data-action="add-entry" data-day="${d.id}" data-trip="${ex.id}" title="Fotos, Text oder Links zu diesem Trip">+ Fotos</button>
      <button class="link-btn" data-action="edit-ex" data-day="${d.id}" data-ex="${ex.id}">Bearbeiten</button>
      <button class="link-btn" data-action="delete-ex" data-day="${d.id}" data-ex="${ex.id}">Löschen</button>
    </div>
  </div>`;
}

function editorHTML(d, i) {
  const { data, error, exId } = ui.draft;
  const stay = stayPlaceFor(i);
  const evening = eveningPlace(i);
  const seg = (name, field, value, label) => `<label><input type="radio" name="${name}" data-draft="${field}" value="${value}" ${data[field] === value ? 'checked' : ''}>${label}</label>`;
  return `<div class="editor">
    <p class="editor-title">${exId ? 'Trip bearbeiten' : 'Neuer Trip'}</p>
    <label class="text-field">Name (optional)
      <input id="draft-name" type="text" data-draft="name" value="${esc(data.name)}" placeholder="z. B. ATV und Rafting">
    </label>
    <div>
      <div class="field-label">Start</div>
      <div class="seg" role="radiogroup" aria-label="Start">
        ${seg('draft-from', 'fromMode', 'stay', `Unterkunft${stay ? ` (${esc(stay.name)})` : ' (noch keine)'}`)}
        ${seg('draft-from', 'fromMode', 'custom', 'Anderer Ort')}
      </div>
      ${data.fromMode === 'custom' ? pickerHTML('draft:from', data.from, 'Startort suchen') : ''}
    </div>
    <div>
      <div class="field-label">Stopps</div>
      <ol class="vias">
        ${data.via.map((p, k) => `<li class="via-item">
          <span class="via-n">${k + 1}</span>
          <div class="via-fields">
            ${pickerHTML(`draft:via:${k}`, p, `Stopp ${k + 1} suchen`)}
            <input class="via-note" type="text" data-draft-note="${k}" value="${esc(data.notes[k] || '')}" placeholder="Was machst du dort? (optional)" aria-label="Notiz zu Stopp ${k + 1}">
          </div>
          <button class="icon-btn" data-action="remove-via" data-idx="${k}" aria-label="Stopp ${k + 1} entfernen" title="Stopp entfernen">−</button>
        </li>`).join('')}
      </ol>
      <button class="link-btn" data-action="add-via">+ Stopp</button>
    </div>
    <div>
      <div class="field-label">Ende</div>
      <div class="seg" role="radiogroup" aria-label="Ende">
        ${seg('draft-end', 'end', 'start', 'Zurück zum Start')}
        ${seg('draft-end', 'end', 'night', `Zur Unterkunft${evening ? ` (${esc(evening.name)})` : ' der Nacht'}`)}
        ${seg('draft-end', 'end', 'place', 'Anderer Ort')}
      </div>
      ${data.end === 'place' ? pickerHTML('draft:to', data.to, 'Ziel suchen') : ''}
    </div>
    <label class="text-field">Unterwegs mit
      <select id="draft-mode" data-draft="mode">
        ${Object.entries(PROFILES).map(([k, v]) => `<option value="${k}" ${data.mode === k ? 'selected' : ''}>${v.label}</option>`).join('')}
      </select>
    </label>
    ${error ? `<p class="editor-error">${esc(error)}</p>` : ''}
    <div class="editor-actions">
      <button class="btn primary" data-action="save-ex">Trip speichern</button>
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
    ${linksHTML(e.links)}
  </article>`;
}

function entryEditorHTML() {
  const jd = ui.jdraft;
  const i = dayIndex(jd.dayId);
  const trips = state.days[i]?.trips || [];
  const tripId = entryTrip(jd.dayId, jd.data.tripId);
  return `<div class="editor">
    <p class="editor-title">${jd.entryId ? 'Eintrag bearbeiten' : tripId ? 'Fotos und Notizen zum Trip' : 'Neuer Tagebucheintrag'}</p>
    <label class="text-field">Text
      <textarea id="jdraft-text" data-jdraft="text" rows="${tripId ? 3 : 6}" placeholder="${tripId ? 'Wie war es? (optional)' : 'Was hast du heute erlebt?'}">${esc(jd.data.text)}</textarea>
    </label>
    ${trips.length ? `<label class="text-field">Gehört zu
      <select data-jdraft="trip">
        <option value="">Tagebuch des Tages</option>
        ${trips.map((ex) => `<option value="${ex.id}" ${ex.id === tripId ? 'selected' : ''}>${esc(tripTitle(i, ex))}</option>`).join('')}
      </select>
    </label>` : ''}
    <div>
      <div class="field-label">Fotos</div>
      ${thumbsHTML(jd.data.photos, true)}
      <label class="btn file-btn${jd.busy ? ' is-busy' : ''}">${jd.busy ? 'Fotos werden gespeichert…' : 'Fotos hinzufügen'}
        <input id="jdraft-photos" type="file" accept="image/*" multiple ${jd.busy ? 'disabled' : ''}>
      </label>
    </div>
    <div>
      <div class="field-label">Links (z. B. Google-Fotos-Album)</div>
      ${jd.data.links.length ? `<ul class="link-list">${jd.data.links.map((u, k) => `<li><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(u))}</a><span class="link-url">${esc(u)}</span><button class="icon-btn" data-action="remove-link" data-idx="${k}" aria-label="Link entfernen" title="Link entfernen">×</button></li>`).join('')}</ul>` : ''}
      <div class="picker-row">
        <input id="jdraft-link" type="url" inputmode="url" data-jdraft="link" value="${esc(jd.linkInput)}" placeholder="https://photos.app.goo.gl/…" aria-label="Link einfügen">
        <button class="btn" data-action="add-link">Hinzufügen</button>
      </div>
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

// Lesbarer Name für einen Link, z. B. ein geteiltes Google-Fotos-Album.
function linkLabel(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  if (host === 'photos.app.goo.gl' || host === 'photos.google.com') return 'Google Fotos';
  if (host.endsWith('icloud.com')) return 'iCloud';
  return host;
}
function linksHTML(links) {
  if (!links.length) return '';
  return `<div class="entry-links">${links.map((u) => `<a class="link-chip" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(linkLabel(u))} ↗</a>`).join('')}</div>`;
}
function addDraftLink() {
  const jd = ui.jdraft;
  let url = jd.linkInput.trim();
  if (url && !/^[a-z]+:/i.test(url)) url = `https://${url}`;
  if (!isWebLink(url)) {
    jd.error = 'Das sieht nicht nach einem Link aus. Kopiere ihn z. B. in Google Fotos über „Teilen → Link erstellen“.';
    render(); return false;
  }
  jd.data.links.push(url); jd.linkInput = ''; jd.error = null;
  render();
  return true;
}

// Einträge eines Tages ohne Trip (tripId = null) oder eines Trips, samt Entwurf, falls er dorthin gehört.
function entryListHTML(d, tripId) {
  const jd = ui.jdraft && ui.jdraft.dayId === d.id && entryTrip(d.id, ui.jdraft.data.tripId) === tripId ? ui.jdraft : null;
  const editing = ui.jdraft?.entryId;
  const entries = entriesOf(d.id).filter((e) => (e.id === editing ? jd : entryTrip(d.id, e.tripId) === tripId));
  if (!entries.length && !jd) return '';
  return entries.map((e) => (jd && e.id === editing ? entryEditorHTML() : entryHTML(e))).join('')
    + (jd && !entries.some((e) => e.id === editing) ? entryEditorHTML() : '');
}

function journalHTML(d) {
  const list = entryListHTML(d, null);
  return list ? `<div class="journal">
    <div class="field-label">Tagebuch</div>
    <div class="entries">${list}</div>
  </div>` : '';
}

// Fotos und Notizen zu einem Trip stehen direkt unter ihm.
function tripEntriesHTML(d, ex) {
  const list = entryListHTML(d, ex.id);
  return list ? `<div class="entries trip-entries">${list}</div>` : '';
}

// Wie viele Nächte am Stück schläft man ab Nacht k am selben Ort? 0, wenn die Reihe schon früher beginnt.
function stayRunAt(k) {
  const n = nightAt(k);
  if (!n?.night || samePlace(nightAt(k - 1)?.night, n.night)) return 0;
  let len = 1;
  while (k + len < state.days.length && samePlace(state.days[k + len].night, n.night)) len++;
  return len;
}

function nightsHTML(k) {
  const n = stayRunAt(k);
  const id = nightId(k);
  if (!n || k < 0) return '';
  return `<div class="nights-row">
    <span>Nächte hier</span>
    <button class="step-btn" data-action="nights-less" data-night="${id}" ${n <= 1 ? 'disabled' : ''} aria-label="Eine Nacht weniger">−</button>
    <span class="nights-n" aria-live="polite">${n}</span>
    <button class="step-btn" data-action="nights-more" data-night="${id}" aria-label="Eine Nacht mehr">+</button>
    <span class="nights-range">Abreise ${fmtDate(k + n)}</span>
  </div>`;
}

function journeyHTML(k) {
  const n = nightAt(k);
  const id = nightId(k);
  const j = n.journey || normalizeJourney(null);
  const jr = journeyFor(k);
  const start = k >= 0 ? morningPlace(k) : null;
  const key = `journey:${id}`;
  const open = !jr || ui.journeyOpen.has(id);
  return `<div class="journey">
    <div class="place selectable${ui.sel === key ? ' is-selected' : ''}" data-action="select" data-sel="${key}" data-day="${state.days[Math.max(k, 0)].id}" data-night="${id}" role="button" tabindex="0">
      <div class="place-text">
        <span class="place-name">Unterwegs · ${PROFILES[j.mode].label}</span>
        <span class="place-label">${jr ? `${esc(jr.from.name)} → ${esc(jr.to.name)} · <span data-stat="journey:${id}"></span>` : 'Trag ein, wohin es geht'}</span>
      </div>
      ${jr ? `<button class="link-btn" data-action="edit-journey" data-night="${id}" aria-expanded="${open}">${open ? 'Fertig' : 'Ändern'}</button>` : ''}
    </div>
    ${open ? `<div class="journey-fields">
      <div class="seg" role="radiogroup" aria-label="Verkehrsmittel">
        ${JOURNEY_MODES.map((m) => `<label><input type="radio" name="jmode-${id}" data-journey-mode="${id}" value="${m}" ${j.mode === m ? 'checked' : ''}>${PROFILES[m].label}</label>`).join('')}
      </div>
      <div><div class="field-label">Von</div>${pickerHTML(`jfrom:${id}`, j.from, start ? `Abfahrt (leer: ${start.name})` : 'Abfahrtsort suchen')}</div>
      <div><div class="field-label">Nach</div>${pickerHTML(`jto:${id}`, j.to, 'Ankunftsort suchen')}</div>
      <button class="link-btn transit-btn" data-action="toggle-transit" data-night="${id}">Doch eine Unterkunft eintragen</button>
    </div>` : ''}
  </div>`;
}

// Übernachtung als eigene Karte zwischen zwei Tagen (k = Nacht nach Tag k, -1 = vor Tag 1).
function nightHTML(k) {
  const n = nightAt(k);
  const id = nightId(k);
  const edge = k < 0 || k === state.days.length - 1; // vor dem ersten / nach dem letzten Tag: optional
  const pk = `night:${id}`;
  const focused = ui.focus === `night:${id}`;
  let body;
  if (n.night && !picker(pk).editing && !stayRunAt(k) && k >= 0) {
    // Weitere Nacht am selben Ort: eine Zeile reicht.
    const sel = ui.sel === `stay:${id}`;
    return `<section class="night is-cont${focused ? ' is-focused' : ''}" id="night-${id}">
      <div class="night-head selectable${sel ? ' is-selected' : ''}" data-action="select" data-sel="stay:${id}" data-day="${state.days[k].id}" data-night="${id}" role="button" tabindex="0">
        <span class="night-ico" aria-hidden="true">☾</span>
        <span class="night-n">Nacht ${nightNo(k)}</span>
        <span class="night-cont" title="${fmtDate(k)} → ${fmtDate(k + 1)}">weiter in <strong>${esc(n.night.name)}</strong></span>
        <button class="link-btn" data-action="edit-place" data-key="${pk}">Ändern</button>
        ${edge ? `<button class="icon-btn" data-action="remove-night" data-night="${id}" aria-label="Übernachtung entfernen" title="Übernachtung entfernen">×</button>` : ''}
      </div>
    </section>`;
  }
  if (n.transit) {
    body = journeyHTML(k);
  } else if (n.night && !picker(pk).editing) {
    body = `<div class="selectable stay-select${ui.sel === `stay:${id}` ? ' is-selected' : ''}" data-action="select" data-sel="stay:${id}" data-day="${state.days[Math.max(k, 0)].id}" data-night="${id}" role="button" tabindex="0">${pickerHTML(pk, n.night)}</div>${nightsHTML(k)}`;
  } else if (readOnly()) {
    body = '<p class="sync-meta">Noch nicht eingetragen</p>';
  } else {
    body = `${pickerHTML(pk, n.night, 'Unterkunft oder Ort suchen')}${n.night ? '' : `<button class="link-btn transit-btn" data-action="toggle-transit" data-night="${id}">Diese Nacht bin ich unterwegs</button>`}`;
  }
  return `<section class="night${hasNight(n) ? '' : ' is-empty'}${focused ? ' is-focused' : ''}" id="night-${id}">
    <div class="night-head">
      <span class="night-ico" aria-hidden="true">☾</span>
      ${hasNight(n) ? `<button class="night-n night-toggle" data-action="focus-night" data-night="${id}" aria-pressed="${focused}" title="Auf der Karte hervorheben">Nacht ${nightNo(k)}</button>` : `<span class="night-n">Nacht ${nightNo(k)}</span>`}
      <span class="night-date">${fmtDate(k)} → ${fmtDate(k + 1)}</span>
      ${edge ? `<button class="icon-btn" data-action="remove-night" data-night="${id}" aria-label="Übernachtung entfernen" title="Übernachtung entfernen">×</button>` : ''}
    </div>
    ${body}
  </section>`;
}

// Optionale Nacht am Anfang oder Ende: als Karte, wenn eingetragen, sonst als kleiner Knopf.
const edgeNightShown = (k) => (k < 0 ? Boolean(nightAt(k)) : hasNight(nightAt(k)) || ui.openNight === nightId(k));
function edgeNightHTML(k) {
  return edgeNightShown(k) ? nightHTML(k) : '';
}
function edgeRowHTML(top) {
  const k = top ? -1 : state.days.length - 1;
  const night = edgeNightShown(k) ? '' : `<button class="edge-btn" data-action="add-night" data-night="${top ? PRE : nightId(k)}">☾ Übernachtung ${top ? 'davor' : 'danach'}</button>`;
  const day = top ? '<button class="edge-btn" data-action="insert-day" data-at="0" title="Die übrigen Tage behalten ihr Datum, die Anreise wird einen Tag früher.">+ Tag am Anfang</button>' : '';
  return night || day ? `<div class="edge-row${top ? ' is-top' : ''}">${day}${night}</div>` : '';
}

function gapHTML(at) {
  return `<div class="day-gap"><button class="gap-btn" data-action="insert-day" data-at="${at}" aria-label="Tag einfügen">+ Tag<span class="gap-long"> einfügen</span></button></div>`;
}

// Eingeklappter Tag: Trips und Tagebuch als eine Zeile.
function daySummaryHTML(d, i) {
  const parts = d.trips.map((ex) => esc(tripTitle(i, ex)));
  const n = entriesOf(d.id).length;
  if (n) parts.push(`✎ ${n} ${n === 1 ? 'Eintrag' : 'Einträge'}`);
  return `<p class="day-summary">${parts.join(' · ') || 'Noch nichts geplant'}</p>`;
}

function dayHTML(d, i) {
  const focused = ui.focus === `day:${d.id}`;
  const draftHere = ui.draft && ui.draft.dayId === d.id;
  const jdHere = ui.jdraft && ui.jdraft.dayId === d.id;
  const collapsed = ui.collapsed.has(d.id) && !draftHere && !jdHere;
  const t = transferFor(i);
  const isToday = i === todayIndex();
  return `<section id="day-${d.id}" class="day${focused ? ' is-focused' : ''}${collapsed ? ' is-collapsed' : ''}" style="--day:${dayColor(i)}">
    <div class="day-head">
      <button class="drag-handle" data-drag="${d.id}" aria-label="Tag ${i + 1} verschieben (Pfeiltasten hoch/runter)" title="Ziehen, um den Tag zu verschieben">⠿</button>
      <button class="day-toggle" data-action="focus-day" data-day="${d.id}" aria-pressed="${focused}" title="Auf der Karte hervorheben">
        <span class="day-n">Tag ${i + 1}</span><span class="day-date">${fmtDate(i)}</span>${isToday ? '<span class="chip today-chip">Heute</span>' : ''}
      </button>
      <span class="day-stat" data-stat="day:${d.id}"></span>
      <button class="icon-btn fold-btn" data-action="toggle-day" data-day="${d.id}" aria-expanded="${!collapsed}" aria-label="Tag ${i + 1} ${collapsed ? 'ausklappen' : 'einklappen'}" title="${collapsed ? 'Ausklappen' : 'Einklappen'}">${collapsed ? '▸' : '▾'}</button>
      <button class="icon-btn" data-action="remove-day" data-day="${d.id}" aria-label="Tag ${i + 1} löschen" title="Tag löschen">×</button>
    </div>
    ${collapsed ? daySummaryHTML(d, i) : `
    ${t ? `<p class="day-morning selectable transfer-row${ui.sel === `transfer:${d.id}` ? ' is-selected' : ''}" data-action="select" data-sel="transfer:${d.id}" data-day="${d.id}" role="button" tabindex="0">Ortswechsel nach <strong>${esc(t.to.name)}</strong> · <span data-stat="transfer:${d.id}"></span></p>` : ''}
    ${d.trips.length || draftHere ? `<div class="ex-list">
      ${d.trips.map((ex) => (draftHere && ui.draft.exId === ex.id ? editorHTML(d, i) : exHTML(d, i, ex)) + tripEntriesHTML(d, ex)).join('')}
      ${draftHere && !ui.draft.exId ? editorHTML(d, i) : ''}
    </div>` : ''}
    ${journalHTML(d)}
    ${draftHere && jdHere ? '' : `<div class="day-actions">
      ${draftHere ? '' : `<button class="act-btn" data-action="add-ex" data-day="${d.id}">+ Ausflug / Weiterreise</button>`}
      ${jdHere ? '' : `<button class="act-btn" data-action="add-entry" data-day="${d.id}">+ Tagebuch</button>`}
    </div>`}`}
  </section>`;
}

// Einstieg: Hinweise, solange die Reise noch leer ist (bis „Verstanden“).
const HINT_KEY = 'reisekarte.hint.v1';
function hintHTML() {
  const empty = !state.preNight && !state.days.some((d) => hasNight(d) || d.trips.length) && !state.journal.length;
  if (!empty || readOnly() || loadJSON(HINT_KEY, false)) return '';
  return `<div class="hint" role="note">
    <p class="hint-title">So planst du deine Reise</p>
    <ol>
      <li>Oben das <strong>Anreisedatum</strong> und den Namen der Reise eintragen.</li>
      <li>Zwischen den Tagen die <strong>☾ Übernachtungen</strong> eintragen, mit „Nächte hier +“ gleich mehrere am selben Ort.</li>
      <li>Pro Tag <strong>Ausflüge oder Weiterreisen</strong> mit Stopps hinzufügen.</li>
      <li>Unterwegs ins <strong>Tagebuch</strong> schreiben, mit Fotos und Ort. Mit „Online-Sync“ ist alles auf allen Geräten.</li>
    </ol>
    <button class="btn" data-action="dismiss-hint">Verstanden</button>
  </div>`;
}

function render() {
  const ro = readOnly();
  $('.app').classList.toggle('is-readonly', ro);
  $('#ro-banner').hidden = !ro;
  if (guest) $('#ro-banner').innerHTML = guestBannerHTML();
  $('#sync-btn').hidden = Boolean(guest);
  const title = $('#trip-title');
  title.readOnly = ro;
  $('#start-date').disabled = ro;
  if (document.activeElement !== title) title.value = state.title;
  $('#start-date').value = state.startDate;
  const last = state.days.length - 1;
  $('#days').innerHTML = hintHTML() + (ro ? '' : edgeRowHTML(true)) + edgeNightHTML(-1) + state.days.map((d, i) => dayHTML(d, i)
    + (i < last ? nightHTML(i) + gapHTML(i + 1) : edgeNightHTML(i))).join('') + (ro ? '' : edgeRowHTML(false));

  const nights = state.days.filter(hasNight).length + (hasNight(state.preNight) ? 1 : 0);
  const stays = stayPins().length;
  const trips = state.days.reduce((n, d) => n + d.trips.length, 0);
  $('#trip-summary').textContent = `${state.days.length} Tage · ${nights} ${nights === 1 ? 'Nacht' : 'Nächte'} · ${stays} ${stays === 1 ? 'Unterkunft' : 'Unterkünfte'} · ${trips} ${trips === 1 ? 'Trip' : 'Trips'}`;

  $('#today-btn').hidden = todayIndex() < 0;
  $('#pick-banner').hidden = !ui.mapPick;
  $('#map').classList.toggle('is-picking', Boolean(ui.mapPick));
  updateStats();
  hydratePhotos($('#days'));
  updateRetryBtn();
  if (ui.jdraft) persistDraft();
}
// „Routen neu laden“ nur zeigen, wenn eine Route fehlgeschlagen ist.
function updateRetryBtn() {
  $('#retry-btn').hidden = !Object.values(routeCache).some((r) => r.failed);
}

function scrollToDay(id) {
  document.getElementById(`day-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function newEntryDraft(dayId, entry, tripId = null) {
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('jdraft:')));
  if (ui.mapPick?.startsWith('jdraft:')) ui.mapPick = null;
  ui.jdraft = {
    dayId,
    entryId: entry ? entry.id : null,
    data: entry
      ? { text: entry.text, place: clone(entry.place), photos: [...entry.photos], links: [...entry.links], tripId: entry.tripId || null }
      : { text: '', place: null, photos: [], links: [], tripId },
    linkInput: '',
    added: [], removed: [], error: null, busy: false, locating: false,
  };
}
// Angefangener Tagebucheintrag wird laufend gesichert (z. B. falls das Handy die Seite beim Fotoauswählen neu lädt).
const DRAFT_KEY = 'reisekarte.draft.v1';
function persistDraft() {
  const jd = ui.jdraft;
  saveJSON(DRAFT_KEY, jd && { dayId: jd.dayId, entryId: jd.entryId, data: jd.data, added: jd.added, removed: jd.removed, linkInput: jd.linkInput });
}
function restoreDraft() {
  const d = loadJSON(DRAFT_KEY, null);
  if (guest) return false; // den angefangenen Eintrag der eigenen Reise nicht anfassen
  if (!d || !dayById(d.dayId) || readOnly()) { saveJSON(DRAFT_KEY, null); return false; }
  ui.jdraft = {
    dayId: d.dayId, entryId: state.journal.some((e) => e.id === d.entryId) ? d.entryId : null,
    data: { text: '', place: null, photos: [], links: [], tripId: null, ...d.data },
    added: d.added || [], removed: d.removed || [], linkInput: d.linkInput || '', error: null, busy: false, locating: false,
  };
  ui.collapsed.delete(d.dayId);
  return true;
}

function closeEntryDraft(keepPhotos) {
  if (ui.jdraft && !keepPhotos) ui.jdraft.added.forEach(forgetPhoto);
  ui.jdraft = null;
  saveJSON(DRAFT_KEY, null);
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('jdraft:')));
  if (ui.mapPick?.startsWith('jdraft:')) ui.mapPick = null;
}

/* ---------------------------------------------------------------- Online-Sync */

// Optional: Die Reise liegt zusätzlich auf einem eigenen PocketBase-Server (z. B. dem Home-Assistant-Add-on).
// Lokal wird weiter alles gespeichert; Änderungen gehen kurz verzögert an den Server.
// Hat sich die Reise auf dem Server geändert, während hier noch ungespeicherte Änderungen liegen,
// entscheidet der Nutzer, welcher Stand gilt. Fotos bleiben auf dem Gerät.

const saveSync = () => saveJSON(SYNC_KEY, syncCfg);
const loggedIn = () => Boolean(sync.pb?.authStore.isValid);
const linked = () => !guest && loggedIn() && Boolean(syncCfg.tripId);
const parseServerTime = (s) => new Date(String(s).replace(' ', 'T'));
const syncTimeFmt = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });

function connectServer() {
  sync.pb = null; sync.methods = null; sync.trips = null;
  if (!syncCfg.url || !window.PocketBase) return;
  sync.pb = new PocketBase(syncCfg.url);
  sync.pb.autoCancellation(false);
}

function markDirty() {
  if (!syncCfg.tripId || readOnly()) return;
  sync.version++;
  if (!syncCfg.dirty) { syncCfg.dirty = true; saveSync(); }
  clearTimeout(sync.timer);
  sync.timer = setTimeout(pushTrip, 1500);
  renderSyncStatus();
}

// Meine Rolle in einer Online-Reise: angelegt (owner), Mitbearbeiten (member) oder nur lesen (viewer).
function roleOf(rec) {
  const me = sync.pb?.authStore.record?.id;
  if (rec.owner === me) return 'owner';
  return (rec.viewers || []).includes(me) ? 'viewer' : 'member';
}
function setRole(rec) {
  const role = roleOf(rec);
  if (role === syncCfg.role) return;
  syncCfg.role = role;
  saveSync();
  share.people = null;
  render();
}

function unlinkTrip() {
  clearTimeout(sync.timer);
  Object.assign(syncCfg, { tripId: null, tripTitle: '', remoteUpdated: null, dirty: false, role: 'owner' });
  sync.trips = null;
  saveJSON(BASE_KEY, null);
  Object.assign(share, { people: null, unsupported: false, needsPassword: false, invite: null, copied: false, error: null });
  Object.assign(viewLink, { key: undefined, unsupported: false, copied: false, error: null });
  resetPhotoSync();
  saveSync();
}

/* Teilen (nur wer die Reise angelegt hat): über den Endpunkt des Add-ons ab Version 0.3.0. */

const share = { people: null, unsupported: false, needsPassword: false, invite: null, copied: false, error: null, busy: false, loading: false };
const SHARE_ROLE = { member: 'Mitbearbeiten', viewer: 'Nur lesen' };
const APP_URL = location.origin + location.pathname;

async function loadShares() {
  if (share.loading) return;
  share.loading = true;
  try {
    share.people = (await sync.pb.send(`/api/reisetagebuch/share/${syncCfg.tripId}`, {})).people;
    share.unsupported = false;
  } catch (err) {
    if (err.status === 404) share.unsupported = true;
    else share.error = syncErrorText(err);
    share.people = [];
  }
  share.loading = false;
  renderSync();
}

async function sendShare(body) {
  share.busy = true; share.error = null;
  renderSync();
  try {
    const res = await sync.pb.send('/api/reisetagebuch/share', { method: 'POST', body: { trip: syncCfg.tripId, ...body } });
    share.needsPassword = false;
    // Teilen ändert den Zeitstempel der Reise, nicht ihren Inhalt: neuen Stand übernehmen, sonst gäbe es einen Schein-Konflikt.
    const rec = await sync.pb.collection('trips').getOne(syncCfg.tripId, { fields: 'id,updated' });
    syncCfg.remoteUpdated = rec.updated;
    saveSync();
    await loadShares();
    return res;
  } catch (err) {
    if (err.status === 404 && err.response?.code === 'no_account') share.needsPassword = true;
    else if (err.status === 404) share.unsupported = true;
    else share.error = syncErrorText(err);
    return null;
  } finally {
    share.busy = false;
    renderSync();
  }
}

function inviteText(email, role, password) {
  const link = `${APP_URL}?server=${encodeURIComponent(syncCfg.url)}`;
  return [
    `Ich habe die Reise „${state.title || syncCfg.tripTitle}“ mit dir geteilt (${role === 'viewer' ? 'zum Lesen' : 'zum Mitbearbeiten'}).`,
    `1. Öffne ${link}`,
    `2. Melde dich unter „Online-Sync“ mit ${email} an${password ? ` (Passwort: ${password})` : ''}.`,
    '3. Unter „Online-Reisen“ die Reise öffnen.',
  ].join('\n');
}

function shareHTML() {
  const dis = share.busy ? ' disabled' : '';
  if (share.unsupported) return '<p class="sync-meta">Teilen aus der App braucht das Home-Assistant-Add-on „Reisetagebuch Server“ ab Version 0.3.0.</p>';
  const people = share.people === null
    ? '<p class="sync-meta">Lade …</p>'
    : share.people.length
      ? `<ul class="sync-list share-list">${share.people.map((x) => `<li>
          <span><strong>${esc(x.email)}</strong></span>
          <select data-share-role="${esc(x.email)}" aria-label="Rolle von ${esc(x.email)}"${dis}>
            ${Object.entries(SHARE_ROLE).map(([k, v]) => `<option value="${k}" ${x.role === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
          <button class="icon-btn" data-action="share-remove" data-email="${esc(x.email)}" aria-label="${esc(x.email)} ausladen" title="Ausladen"${dis}>×</button>
        </li>`).join('')}</ul>`
      : '<p class="sync-meta">Noch mit niemandem geteilt.</p>';
  return `${people}
    <form class="sync-form" data-submit="share-invite">
      <div class="share-row">
        <input name="share-email" type="email" required autocomplete="off" placeholder="E-Mail der Person" aria-label="E-Mail der Person">
        <select name="share-role" aria-label="Rolle">
          ${Object.entries(SHARE_ROLE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
      </div>
      ${share.needsPassword ? `<label class="text-field">Für diese E-Mail gibt es noch kein Konto. Start-Passwort für das neue Konto (mind. 8 Zeichen):
        <input name="share-password" type="text" minlength="8" required autocomplete="off">
      </label>` : ''}
      <div class="editor-actions"><button class="btn primary"${dis}>${share.needsPassword ? 'Konto anlegen und einladen' : 'Einladen'}</button></div>
    </form>
    ${share.error ? `<p class="editor-error" role="alert">${esc(share.error)}</p>` : ''}
    ${share.invite ? `<div class="invite">
      <p class="sync-meta">Schick der Person diesen Text:</p>
      <textarea class="invite-text" rows="5" readonly>${esc(share.invite)}</textarea>
      <div class="editor-actions"><button class="btn" data-action="share-copy">${share.copied ? 'Kopiert ✓' : 'Text kopieren'}</button></div>
    </div>` : ''}`;
}

/* Link zum Ansehen ohne Konto (Add-on ab Version 0.4.0): Schlüssel shareKey an der Reise, nur der Besitzer setzt ihn. */

// key: undefined = noch nicht geladen, null = kein Link
const viewLink = { key: undefined, unsupported: false, loading: false, busy: false, copied: false, error: null };

// 24 Zufallsbytes als 32 Zeichen Base64url (der Server verlangt mindestens 32 Zeichen).
function newViewKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const viewLinkURL = (key) => `${APP_URL}?server=${encodeURIComponent(syncCfg.url)}&trip=${encodeURIComponent(syncCfg.tripId)}&key=${encodeURIComponent(key)}`;

async function loadViewLink() {
  if (viewLink.loading) return;
  viewLink.loading = true;
  try {
    const rec = await sync.pb.collection('trips').getOne(syncCfg.tripId, { fields: 'id,shareKey' });
    viewLink.unsupported = !('shareKey' in rec); // älteres Add-on kennt das Feld nicht
    viewLink.key = rec.shareKey || null;
  } catch (err) {
    viewLink.error = syncErrorText(err);
    viewLink.key = null;
  }
  viewLink.loading = false;
  renderSync();
}

async function setViewKey(key) {
  Object.assign(viewLink, { busy: true, error: null, copied: false });
  renderSync();
  try {
    const rec = await sync.pb.collection('trips').update(syncCfg.tripId, { shareKey: key }, { fields: 'id,updated,shareKey' });
    if (!('shareKey' in rec)) {
      viewLink.unsupported = true;
    } else {
      viewLink.key = rec.shareKey || null;
      // Wie beim Teilen: Der Zeitstempel ändert sich, der Inhalt nicht.
      syncCfg.remoteUpdated = rec.updated;
      saveSync();
    }
  } catch (err) {
    viewLink.error = syncErrorText(err);
  }
  viewLink.busy = false;
  renderSync();
}

function viewLinkHTML() {
  if (viewLink.unsupported) return '<p class="sync-meta">Dafür braucht das Home-Assistant-Add-on „Reisetagebuch Server“ Version 0.4.0 oder neuer.</p>';
  if (viewLink.key === undefined) return '<p class="sync-meta">Lade …</p>';
  const dis = viewLink.busy ? ' disabled' : '';
  const intro = '<p class="sync-meta">Für Freunde und Familie: Wer den Link hat, sieht die Reise mit Tagebuch und Fotos, ohne Konto und ohne etwas ändern zu können.</p>';
  const err = viewLink.error ? `<p class="editor-error" role="alert">${esc(viewLink.error)}</p>` : '';
  if (!viewLink.key) return `${intro}<div class="editor-actions"><button class="btn primary" data-action="view-link-create"${dis}>Link erstellen</button></div>${err}`;
  return `${intro}
    <input class="view-link" type="text" readonly value="${esc(viewLinkURL(viewLink.key))}" aria-label="Link zum Ansehen">
    <div class="editor-actions">
      <button class="btn primary" data-action="view-link-copy"${dis}>${viewLink.copied ? 'Kopiert ✓' : 'Link kopieren'}</button>
      ${navigator.share ? `<button class="btn" data-action="view-link-share"${dis}>Teilen …</button>` : ''}
    </div>
    <div class="editor-actions">
      <button class="btn ghost" data-action="view-link-renew"${dis}>Neuer Link</button>
      <button class="btn ghost" data-action="view-link-off"${dis}>Link abschalten</button>
    </div>
    <p class="sync-meta">Ein neuer Link oder „Abschalten“ macht den bisherigen Link sofort ungültig.</p>${err}`;
}

/* Gastansicht: Reise über einen Link zum Ansehen laden, nur lesen, ohne Anmeldung. */

async function loadGuest(fit) {
  if (!window.PocketBase) return;
  if (!guest.pb) {
    guest.pb = new PocketBase(guest.url);
    guest.pb.autoCancellation(false);
  }
  const first = !guest.updated;
  try {
    const rec = await guest.pb.collection('trips').getOne(guest.trip, { fields: 'id,title,data,updated', query: { key: guest.key } });
    guest.error = null; guest.offline = false;
    if (rec.updated !== guest.updated) {
      const next = normalizeTrip(rec.data);
      next.journal = next.journal.filter((e) => next.days.some((d) => d.id === e.dayId));
      state = next;
      guest.updated = rec.updated;
      saveJSON(GUEST_KEY, { trip: guest.trip, updated: rec.updated, data: rec.data });
      if (focusPos() < 0) ui.focus = null;
      ui.sel = null;
      $('#trip-title').value = state.title;
      render(); drawMap(fit || first);
      if (first) setTimeout(() => { const i = todayIndex(); if (i >= 0) scrollToDay(state.days[i].id); }, 300);
      return;
    }
  } catch (err) {
    if (!err.status) guest.offline = true;
    else if (err.status === 404 || err.status === 403) {
      // Link abgeschaltet oder erneuert: auch den hier gespeicherten Stand nicht mehr zeigen.
      guest.error = 'Dieser Link gilt nicht mehr. Bitte frag nach einem neuen.';
      saveJSON(GUEST_KEY, null);
      if (guest.updated) {
        guest.updated = null;
        state = emptyTrip();
        state.title = 'Reise nicht verfügbar';
        $('#trip-title').value = state.title;
        ui.focus = null; ui.sel = null;
        render(); drawMap(true);
        return;
      }
    } else guest.error = syncErrorText(err);
  }
  render();
}

function guestBannerHTML() {
  const when = guest.updated ? syncTimeFmt.format(parseServerTime(guest.updated)) : '';
  const status = guest.error || (guest.offline ? `Offline${when ? `, Stand ${when}` : ''}` : when ? `Stand ${when}` : 'Wird geladen …');
  return `👁 Nur ansehen · ${esc(status)} · <a href="${esc(APP_URL)}">Eigene Reisekarte öffnen</a>`;
}

/* Fotos: Hochladen nach dem Speichern, Herunterladen bei Bedarf (wenn ein Foto auf diesem Gerät fehlt). */

function resetPhotoSync() {
  Object.assign(photoSync, { records: null, loading: null, loadedAt: 0, uploading: false, pending: 0, error: null, token: null, tokenAt: 0 });
  photoSync.downloads.clear();
}

const photoTrip = () => (guest ? guest.trip : syncCfg.tripId);
function loadServerPhotos() {
  const tripId = photoTrip();
  const pb = guest ? guest.pb : sync.pb;
  photoSync.loading ||= pb.collection('photos').getFullList({
    filter: pb.filter('trip = {:t}', { t: tripId }),
    fields: 'id,key,file,collectionId,collectionName',
    ...(guest ? { query: { key: guest.key } } : {}),
  }).then((list) => {
    if (photoTrip() === tripId) {
      photoSync.records = new Map(list.map((r) => [r.key, r]));
      photoSync.loadedAt = Date.now();
    }
  }).catch((err) => {
    if (err.status === 404) photoSync.unsupported = true;
    throw err;
  }).finally(() => { photoSync.loading = null; });
  return photoSync.loading;
}

async function fileToken() {
  // Datei-Token gelten nur kurz; eine Minute wiederverwenden reicht für eine Seite voller Fotos.
  if (!photoSync.token || Date.now() - photoSync.tokenAt > 60000) {
    photoSync.token = await sync.pb.files.getToken();
    photoSync.tokenAt = Date.now();
  }
  return photoSync.token;
}

function downloadPhoto(id) {
  if (!(linked() || guest?.pb) || photoSync.unsupported) return Promise.resolve(null);
  if (!photoSync.downloads.has(id)) {
    const job = (async () => {
      try {
        if (!photoSync.records || (!photoSync.records.has(id) && Date.now() - photoSync.loadedAt > 10000)) await loadServerPhotos();
        const rec = photoSync.records?.get(id);
        if (!rec) return null;
        const url = guest
          ? guest.pb.files.getURL(rec, rec.file, { key: guest.key })
          : sync.pb.files.getURL(rec, rec.file, { token: await fileToken() });
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        await photoStore.put(id, blob).catch(() => {});
        return blob;
      } catch {
        return null;
      }
    })();
    photoSync.downloads.set(id, job);
    // Fehlgeschlagen: frühestens nach 30 Sekunden erneut versuchen.
    job.then((blob) => setTimeout(() => photoSync.downloads.delete(id), blob ? 0 : 30000));
  }
  return photoSync.downloads.get(id);
}

async function uploadPhotos() {
  if (!linked() || photoSync.unsupported || photoSync.uploading) return;
  photoSync.uploading = true; photoSync.error = null;
  const tripId = syncCfg.tripId;
  try {
    if (!photoSync.records) await loadServerPhotos();
    const missing = [...new Set(state.journal.flatMap((e) => e.photos))].filter((id) => !photoSync.records.has(id));
    photoSync.pending = missing.length;
    renderSyncStatus();
    for (const id of missing) {
      if (syncCfg.tripId !== tripId || !loggedIn()) break;
      const blob = await photoStore.get(id).catch(() => null);
      // Ohne Datei hier liegt das Foto auf einem anderen Gerät, das es selbst hochlädt.
      if (blob) {
        const body = { trip: tripId, key: id, file: new File([blob], `${id}.jpg`, { type: blob.type || 'image/jpeg' }) };
        const opts = { fields: 'id,key,file,collectionId,collectionName' };
        let rec;
        try {
          rec = await sync.pb.collection('photos').create(body, opts);
        } catch (err) {
          if (err.status !== 429) throw err;
          await sleep(5000); // Anfragebegrenzung des Servers
          rec = await sync.pb.collection('photos').create(body, opts);
        }
        photoSync.records.set(id, rec);
        await sleep(300);
      }
      photoSync.pending--;
      renderSyncStatus(); renderSync();
    }
  } catch (err) {
    if (!err.status) sync.offline = true;
    else if (!photoSync.unsupported) photoSync.error = `Fotos: ${syncErrorText(err)}`;
  }
  photoSync.uploading = false;
  renderSyncStatus(); renderSync();
}

// Foto endgültig entfernen: lokal und (falls verknüpft) auf dem Server.
function dropPhoto(id) {
  forgetPhoto(id);
  if (!linked() || photoSync.unsupported) return;
  const rec = photoSync.records?.get(id);
  photoSync.records?.delete(id);
  const col = sync.pb.collection('photos');
  const found = rec ? Promise.resolve(rec) : col.getFirstListItem(sync.pb.filter('trip = {:t} && key = {:k}', { t: syncCfg.tripId, k: id }));
  found.then((r) => col.delete(r.id)).catch(() => {});
}

function syncErrorText(err) {
  if (!err.status) return 'Der Server ist nicht erreichbar. Stimmt die Adresse, und bist du online?';
  if (err.status === 400 && /auth-with-password/.test(err.url)) return 'E-Mail oder Passwort ist falsch.';
  if (err.status === 429) return 'Zu viele Versuche. Warte kurz und probier es dann noch einmal.';
  return `Der Server meldet: ${err.response?.message || err.message} (${err.status})`;
}

function handleSyncError(err) {
  if (err.isAbort) return;
  if (!err.status) { sync.offline = true; return; }
  sync.offline = false;
  if (err.status === 404 && syncCfg.tripId) {
    sync.error = 'Die Online-Reise gibt es nicht mehr, oder du hast keinen Zugriff mehr. Die Reise ist jetzt nur noch auf diesem Gerät gespeichert.';
    unlinkTrip();
  } else if (err.status === 401) {
    sync.error = 'Deine Anmeldung ist abgelaufen. Bitte melde dich neu an.';
    sync.pb.authStore.clear();
  } else {
    sync.error = syncErrorText(err);
  }
}

/* Zusammenführen: Wurde die Reise woanders geändert, während hier ungespeicherte Änderungen liegen,
   werden beide Stände zusammengeführt (Drei-Wege-Abgleich gegen den zuletzt gemeinsamen Stand „base“).
   Je Tagebucheintrag, Tag, Trip und Feld: nur eine Seite geändert → diese; beide → dieses Gerät.
   Neue Einträge von beiden Seiten bleiben erhalten. */

const BASE_KEY = 'reisekarte.base.v1';
function saveBase(data) {
  saveJSON(BASE_KEY, { tripId: syncCfg.tripId, data });
}
function loadBase() {
  const b = loadJSON(BASE_KEY, null);
  return b && b.tripId === syncCfg.tripId ? b.data : null;
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const pick3 = (base, mine, theirs) => (same(mine, theirs) || !same(base, mine) ? mine : theirs);

function mergeList(base = [], mine = [], theirs = [], mergeItem = pick3) {
  const B = new Map(base.map((x) => [x.id, x]));
  const M = new Map(mine.map((x) => [x.id, x]));
  const T = new Map(theirs.map((x) => [x.id, x]));
  const ids = (l) => l.map((x) => x.id).join();
  // Reihenfolge von der Seite, die sie geändert hat (sonst vom Server).
  const lead = ids(mine) !== ids(base) ? mine : theirs;
  const other = lead === mine ? theirs : mine;
  const out = [];
  const seen = new Set();
  const take = (id) => {
    seen.add(id);
    const b = B.get(id), m = M.get(id), t = T.get(id);
    if (m && t) return mergeItem(b, m, t);
    const only = m || t;
    // Nur auf einer Seite: neu (behalten) oder auf der anderen Seite gelöscht (weg, außer hier inzwischen geändert).
    return !b || !same(b, only) ? only : null;
  };
  lead.forEach((x) => { const v = take(x.id); if (v) out.push(v); });
  other.forEach((x, k) => {
    if (seen.has(x.id)) return;
    const v = take(x.id);
    if (!v) return;
    const prev = k > 0 ? out.findIndex((y) => y.id === other[k - 1].id) : -1;
    out.splice(prev + 1, 0, v); // hinter den Vorgänger von der anderen Seite
  });
  return out;
}

const nightPart = (d) => d && { night: d.night, transit: d.transit, journey: d.journey };
function mergeDay(b, m, t) {
  return { id: m.id, ...pick3(nightPart(b), nightPart(m), nightPart(t)), trips: mergeList(b?.trips, m.trips, t.trips) };
}

function mergeTrips(base, mine, theirs) {
  const b = base || {};
  const days = mergeList(b.days, mine.days, theirs.days, mergeDay);
  const journal = mergeList(b.journal, mine.journal, theirs.journal).filter((e) => days.some((d) => d.id === e.dayId));
  return {
    title: pick3(b.title, mine.title, theirs.title),
    startDate: pick3(b.startDate, mine.startDate, theirs.startDate),
    preNight: pick3(b.preNight, mine.preNight, theirs.preNight),
    days: days.length ? days : mine.days,
    journal,
  };
}

async function pushTrip() {
  clearTimeout(sync.timer);
  if (!linked() || !syncCfg.dirty || readOnly()) return;
  if (sync.pushing) { sync.pushAgain = true; return; }
  sync.pushing = true; sync.error = null;
  renderSyncStatus();
  try {
    const col = sync.pb.collection('trips');
    const remote = await col.getOne(syncCfg.tripId, { fields: 'id,updated' });
    if (remote.updated !== syncCfg.remoteUpdated) {
      // Woanders geändert: zusammenführen, dann den gemeinsamen Stand hochladen.
      const rec = await col.getOne(syncCfg.tripId);
      const merged = mergeTrips(loadBase(), state, normalizeTrip(rec.data));
      state = normalizeTrip(merged);
      saveJSON(STORAGE_KEY, state);
      syncCfg.remoteUpdated = rec.updated;
      if (ui.draft && !dayById(ui.draft.dayId)) closeDraft();
      $('#trip-title').value = state.title;
      render(); drawMap(false);
      showToast('Änderungen von einem anderen Gerät wurden übernommen.');
    }
    // Erst die Fotos, damit andere Geräte sie schon finden, wenn der neue Stand ankommt.
    await uploadPhotos();
    const sent = clone(state);
    const sentVersion = sync.version;
    const rec = await col.update(syncCfg.tripId, { title: sent.title, data: sent }, { fields: 'id,title,updated' });
    syncCfg.remoteUpdated = rec.updated; syncCfg.tripTitle = rec.title;
    saveBase(sent);
    syncCfg.dirty = sync.version !== sentVersion; // während des Hochladens geändert: gleich noch einmal
    saveSync();
    sync.offline = false;
  } catch (err) {
    handleSyncError(err);
  }
  sync.pushing = false;
  // Während des Hochladens geändert: gleich noch einmal. Fehler und Offline wiederholt der Timer unten.
  if (sync.pushAgain || (syncCfg.dirty && !sync.error && !sync.offline)) {
    sync.pushAgain = false;
    sync.timer = setTimeout(pushTrip, 1500);
  }
  renderSyncStatus(); renderSync();
}

async function pullTrip() {
  if (!linked() || sync.pushing) return;
  try {
    const rec = await sync.pb.collection('trips').getOne(syncCfg.tripId);
    sync.offline = false; sync.error = null;
    if (rec.id !== syncCfg.tripId || sync.pushing) return;
    setRole(rec);
    if (rec.updated === syncCfg.remoteUpdated) {
      if (syncCfg.dirty) pushTrip(); else uploadPhotos();
    } else if (syncCfg.dirty) {
      pushTrip(); // führt beide Stände zusammen
    } else if (!ui.draft && !ui.jdraft) {
      // Mitten in einer Bearbeitung nicht austauschen; der nächste Abgleich holt es nach.
      applyRemote(rec, false);
    }
  } catch (err) {
    handleSyncError(err);
  }
  renderSyncStatus(); renderSync();
}

function applyRemote(rec, fit) {
  let next;
  try {
    next = normalizeTrip(rec.data);
  } catch {
    sync.error = 'Die Online-Reise enthält keine gültigen Reisedaten.';
    return;
  }
  next.journal = next.journal.filter((e) => next.days.some((d) => d.id === e.dayId));
  state = next;
  Object.assign(syncCfg, { tripId: rec.id, tripTitle: rec.title, remoteUpdated: rec.updated, dirty: false, role: roleOf(rec) });
  saveSync();
  saveBase(clone(state));
  saveJSON(STORAGE_KEY, state);
  closeDraft(); closeEntryDraft();
  if (focusPos() < 0) ui.focus = null;
  ui.sel = null;
  $('#trip-title').value = state.title; // render() lässt das Feld sonst in Ruhe, solange es den Fokus hat
  render(); drawMap(fit);
}

async function loadTripList() {
  sync.trips = await sync.pb.collection('trips').getFullList({ sort: '-updated', fields: 'id,title,updated,owner,viewers' });
}

async function loadAuthMethods() {
  try {
    sync.methods = await sync.pb.collection('users').listAuthMethods();
  } catch {
    sync.methods = null;
  }
}

// Führt eine Aktion im Sync-Dialog aus und zeigt Fehler dort an.
async function runSync(fn) {
  sync.busy = true; sync.error = null;
  renderSync();
  try {
    await fn();
  } catch (err) {
    if (!err.isAbort) sync.error = err.status === undefined ? err.message : syncErrorText(err);
  }
  sync.busy = false;
  renderSync(); renderSyncStatus();
}

async function afterLogin() {
  if (syncCfg.tripId) await pullTrip();
  else await loadTripList();
}

function syncStatus() {
  if (!sync.pb) return { text: 'Online-Sync', cls: '' };
  if (!loggedIn()) return { text: 'Anmelden', cls: 'is-warn' };
  if (!syncCfg.tripId) return { text: 'Online: keine Reise', cls: '' };
  if (sync.error) return { text: 'Sync-Fehler', cls: 'is-bad' };
  if (sync.pushing) return { text: 'Speichert…', cls: '' };
  if (syncCfg.dirty) return { text: sync.offline ? 'Offline · noch nicht online' : 'Wird gespeichert…', cls: 'is-warn' };
  if (photoSync.uploading && photoSync.pending > 0) return { text: `Fotos ↑ ${photoSync.pending}`, cls: '' };
  return { text: 'Online ✓', cls: 'is-ok' };
}

function renderSyncStatus() {
  const btn = $('#sync-btn');
  if (!btn) return;
  const st = syncStatus();
  btn.textContent = st.text;
  btn.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (st.cls) btn.classList.add(st.cls);
}

function syncBodyHTML() {
  const pb = sync.pb;
  const dis = sync.busy ? ' disabled' : '';
  const err = sync.error ? `<p class="editor-error" role="alert">${esc(sync.error)}</p>` : '';

  if (!pb) {
    return `
      <p class="sync-text">Speichere die Reise auf deinem eigenen Server, zum Beispiel dem Home-Assistant-Add-on „Reisetagebuch Server“, und nutze sie auf mehreren Geräten.</p>
      <form class="sync-form" data-submit="sync-set-server">
        <label class="text-field">Server-Adresse
          <input name="url" type="url" required inputmode="url" autocomplete="url" placeholder="https://name.duckdns.org:8091" value="${esc(syncCfg.url)}">
        </label>
        <div class="editor-actions"><button class="btn primary"${dis}>Verbinden</button></div>
      </form>${err}`;
  }

  const serverLine = `Server: <span class="sync-mono">${esc(syncCfg.url)}</span>`;
  const server = `<p class="sync-meta">${serverLine}</p>`;

  if (!loggedIn()) {
    const google = sync.methods?.oauth2?.enabled && sync.methods.oauth2.providers.some((p) => p.name === 'google');
    return `${server}
      <form class="sync-form" data-submit="sync-login">
        <label class="text-field">E-Mail
          <input name="email" type="email" required autocomplete="username">
        </label>
        <label class="text-field">Passwort
          <input name="password" type="password" required autocomplete="current-password">
        </label>
        <div class="editor-actions">
          <button class="btn primary"${dis}>Anmelden</button>
          ${google ? `<button type="button" class="btn" data-action="sync-google"${dis}>Mit Google anmelden</button>` : ''}
        </div>
      </form>${err}
      <div class="editor-actions"><button class="btn ghost" data-action="sync-change-server">Anderen Server eintragen</button></div>`;
  }

  const who = `<p class="sync-meta">Angemeldet als <strong>${esc(pb.authStore.record?.email || '')}</strong><br>${serverLine}</p>`;
  const footer = `<div class="editor-actions sync-foot"><button class="btn ghost" data-action="sync-logout">Abmelden</button></div>`;

  if (!syncCfg.tripId) {
    const list = sync.trips === null
      ? '<p class="sync-text">Lade Online-Reisen…</p>'
      : sync.trips.length
        ? `<ul class="sync-list">${sync.trips.map((t) => `
            <li><span><strong>${esc(t.title || 'Ohne Namen')}</strong><span class="sync-meta">geändert ${esc(syncTimeFmt.format(parseServerTime(t.updated)))}${{ owner: '', member: ' · mit dir geteilt', viewer: ' · zum Lesen geteilt' }[roleOf(t)]}</span></span>
              <button class="btn" data-action="sync-open-trip" data-trip="${esc(t.id)}"${dis}>Öffnen</button></li>`).join('')}</ul>`
        : '<p class="sync-text">Du hast noch keine Online-Reisen.</p>';
    return `${who}
      <h3 class="sync-sub">Online-Reisen</h3>${list}
      <div class="editor-actions"><button class="btn primary" data-action="sync-upload"${dis}>„${esc(state.title)}“ online speichern</button></div>${err}${footer}`;
  }

  const st = syncStatus();
  const last = syncCfg.remoteUpdated ? syncTimeFmt.format(parseServerTime(syncCfg.remoteUpdated)) : '–';
  return `${who}
    <div class="sync-box">
      <p>Diese Reise ist mit <strong>${esc(syncCfg.tripTitle || state.title)}</strong> verbunden.</p>
      <p class="sync-meta">Status: ${esc(st.text)} · online zuletzt geändert ${esc(last)}</p>
      ${sync.offline ? '<p class="sync-meta">Keine Verbindung zum Server. Änderungen werden gespeichert, sobald er wieder erreichbar ist.</p>' : ''}
      ${photoSync.unsupported
        ? '<p class="sync-meta">Fotos werden nicht übertragen: Bitte aktualisiere das Home-Assistant-Add-on „Reisetagebuch Server“ auf Version 0.2.0 oder neuer.</p>'
        : `<p class="sync-meta">Fotos werden mit hochgeladen${photoSync.uploading && photoSync.pending ? ` · noch ${photoSync.pending}` : ''}.</p>`}
      ${photoSync.error ? `<p class="editor-error">${esc(photoSync.error)}</p>` : ''}
      ${syncCfg.role === 'viewer' ? '<p class="sync-meta"><strong>Nur lesen:</strong> Diese Reise wurde mit dir zum Lesen geteilt.</p>' : ''}
      ${syncCfg.role === 'member' ? '<p class="sync-meta">Diese Reise wurde mit dir zum Mitbearbeiten geteilt.</p>' : ''}
      <div class="editor-actions">
        <button class="btn primary" data-action="sync-now"${dis}>Jetzt abgleichen</button>
        <button class="btn" data-action="sync-unlink"${dis}>Andere Reise öffnen</button>
      </div>
    </div>
    ${syncCfg.role === 'owner' ? `<div class="sync-box"><h3 class="sync-sub">Teilen</h3>${shareHTML()}</div>
      <div class="sync-box"><h3 class="sync-sub">Link zum Ansehen</h3>${viewLinkHTML()}</div>` : ''}${err}${footer}`;
}

function renderSync() {
  const dlg = $('#sync-dialog');
  if (!dlg?.open) return;
  // Eingaben überleben das Neuzeichnen (z. B. die E-Mail nach falschem Passwort).
  const typed = Object.fromEntries([...dlg.querySelectorAll('input[name]')].map((i) => [i.name, i.value]));
  const focused = document.activeElement?.name;
  $('#sync-body').innerHTML = syncBodyHTML();
  dlg.querySelectorAll('input[name]').forEach((i) => { if (typed[i.name]) i.value = typed[i.name]; });
  if (focused) dlg.querySelector(`[name="${focused}"]`)?.focus();
  // Teilen-Liste nachladen, z. B. direkt nachdem die Reise hochgeladen wurde.
  if (linked() && syncCfg.role === 'owner' && share.people === null && !share.unsupported) loadShares();
  if (linked() && syncCfg.role === 'owner' && viewLink.key === undefined && !viewLink.unsupported) loadViewLink();
}

function openSync() {
  const dlg = $('#sync-dialog');
  if (!dlg.open) dlg.showModal();
  renderSync();
  if (sync.pb && !loggedIn() && !sync.methods) loadAuthMethods().then(renderSync);
  if (loggedIn() && !syncCfg.tripId && !sync.trips) runSync(loadTripList);
  if (linked() && syncCfg.role === 'owner' && share.people === null && !share.unsupported) loadShares();
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
      ? {
        name: ex.name, fromMode: ex.from ? 'custom' : 'stay', from: clone(ex.from),
        via: ex.via.map(({ note, ...p }) => p), notes: ex.via.map((p) => p.note || ''),
        end: ex.end, to: clone(ex.to), mode: ex.mode,
      }
      : { name: '', fromMode: 'stay', from: null, via: [null], notes: [''], end: 'start', to: null, mode: 'car' },
  };
}
function closeDraft() {
  ui.draft = null;
  ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('draft:')));
  if (ui.mapPick?.startsWith('draft:')) ui.mapPick = null;
}

const actions = {
  'focus-day'(el) {
    const key = `day:${el.dataset.day}`;
    ui.focus = ui.focus === key && !ui.sel ? null : key;
    ui.sel = null;
    render();
    drawMap(true);
  },
  'focus-night'(el) {
    const key = `night:${el.dataset.night}`;
    ui.focus = ui.focus === key && !ui.sel ? null : key;
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
      ui.focus = el.dataset.night ? `night:${el.dataset.night}` : `day:${el.dataset.day}`;
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
    if ((hasNight(d) || d.trips.length || entries.length) && !confirm(`Tag ${i + 1} mit der Nacht danach, Trips${entries.length ? ` und ${entries.length} Tagebucheintrag/-einträgen` : ''} löschen?`)) return;
    entries.forEach((e) => e.photos.forEach(dropPhoto));
    state.journal = state.journal.filter((e) => e.dayId !== d.id);
    if (ui.jdraft?.dayId === d.id) closeEntryDraft();
    state.days.splice(i, 1);
    if (ui.draft?.dayId === d.id) closeDraft();
    if (ui.focus === `day:${d.id}` || ui.focus === `night:${d.id}`) { ui.focus = null; ui.sel = null; }
    save(); render(); drawMap(false);
  },
  'add-day'() {
    const last = state.days[state.days.length - 1];
    state.days.push({ id: uid(), night: last?.night ? clone(last.night) : null, transit: false, journey: null, trips: [] });
    save(); render(); drawMap(false);
    $('#days').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },
  'toggle-transit'(el) {
    const id = el.dataset.night;
    const n = nightById(id);
    n.transit = !n.transit;
    n.journey = n.transit ? normalizeJourney(null) : null;
    if (n.transit) n.night = null;
    ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.endsWith(`:${id}`)));
    save(); render(); drawMap(false);
  },
  'add-night'(el) {
    const id = el.dataset.night;
    if (id === PRE) {
      state.preNight = normalizeNight(null);
      save();
    } else {
      ui.openNight = id; // Nacht nach dem letzten Tag: erst beim Eintragen gespeichert
    }
    render();
    document.querySelector(`[data-picker="night:${id}"]`)?.focus();
  },
  'remove-night'(el) {
    const id = el.dataset.night;
    if (id === PRE) state.preNight = null;
    else Object.assign(dayById(id), normalizeNight(null));
    if (ui.openNight === id) ui.openNight = null;
    if (ui.sel === `stay:${id}` || ui.sel === `journey:${id}`) ui.sel = null;
    if (ui.focus === `night:${id}`) ui.focus = null;
    ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.endsWith(`:${id}`)));
    save(); render(); drawMap(false);
  },
  'insert-day'(el) {
    const at = Number(el.dataset.at);
    const prev = state.days[at - 1];
    state.days.splice(at, 0, { id: uid(), night: prev?.night ? clone(prev.night) : null, transit: false, journey: null, trips: [] });
    // Am Anfang eingefügt: Die bisherigen Tage behalten ihr Datum.
    if (at === 0) state.startDate = shiftDate(state.startDate, -1);
    save(); render(); drawMap(false);
  },
  'nights-more'(el) {
    const i = nightIndex(el.dataset.night);
    const d = nightAt(i);
    const k = i + stayRunAt(i);
    const next = state.days[k];
    // Freie Nacht am nächsten Tag belegen, sonst einen Tag einschieben (spätere Unterkünfte bleiben, wie sie sind).
    if (next && !next.night && !next.transit) next.night = clone(d.night);
    else state.days.splice(k, 0, { id: uid(), night: clone(d.night), transit: false, journey: null, trips: [] });
    save(); render(); drawMap(false);
  },
  'nights-less'(el) {
    const i = nightIndex(el.dataset.night);
    const n = stayRunAt(i);
    if (n <= 1) return;
    state.days[i + n - 1].night = null;
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
    const via = data.via.map((p, k) => p && (data.notes[k]?.trim() ? { ...p, note: data.notes[k].trim().slice(0, 200) } : p)).filter(Boolean);
    const fail = (msg) => { ui.draft.error = msg; render(); };
    if (data.fromMode === 'custom' && !data.from) return fail('Wähle einen Startort oder starte bei der Unterkunft.');
    if (data.fromMode === 'stay' && !stayPlaceFor(i)) return fail('Für diesen Tag gibt es noch keine Unterkunft. Trag eine Übernachtung ein oder wähle „Anderer Ort“ als Start.');
    if (data.end === 'start' && !via.length) return fail('Ein Ausflug zurück zum Start braucht mindestens einen Stopp.');
    if (data.end === 'place' && !data.to) return fail('Wähle, wo der Trip endet.');
    if (data.end === 'night' && !eveningPlace(i)) return fail('Für diese Nacht ist noch keine Unterkunft eingetragen. Trag sie zuerst ein oder wähle „Anderer Ort“ als Ende.');
    const ex = {
      id: exId || uid(),
      name: data.name.trim(),
      from: data.fromMode === 'custom' ? data.from : null,
      via,
      end: data.end,
      to: data.end === 'place' ? data.to : null,
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
    ui.draft.data.notes.push('');
    render();
    document.querySelector(`[data-picker="draft:via:${ui.draft.data.via.length - 1}"]`)?.focus();
  },
  'remove-via'(el) {
    ui.draft.data.via.splice(Number(el.dataset.idx), 1);
    ui.draft.data.notes.splice(Number(el.dataset.idx), 1);
    ui.pickers = Object.fromEntries(Object.entries(ui.pickers).filter(([k]) => !k.startsWith('draft:via:')));
    if (ui.mapPick?.startsWith('draft:via:')) ui.mapPick = null;
    render();
  },
  search(el) { searchPlace(el.dataset.key); },
  'pick-result'(el) {
    const p = picker(el.dataset.key);
    const r = p.results[Number(el.dataset.idx)];
    if (!r) return;
    const place = { name: r.name, label: r.label, lat: r.lat, lon: r.lon };
    setPlace(el.dataset.key, place);
    if (/^Punkt /.test(place.name)) reverseGeocode(place);
  },
  'rename-place'(el) {
    const key = el.dataset.key;
    const place = placeRef(key).get();
    if (!place) return;
    const name = prompt('Name des Ortes', place.name)?.trim().slice(0, 120);
    if (!name || name === place.name) return;
    if (key.startsWith('night:')) {
      // Alle Nächte an derselben Stelle mit demselben Namen umbenennen (sonst stünde „weiter in …“ mit altem Namen da).
      for (let k = -1; k < state.days.length; k++) {
        const n = nightAt(k);
        if (n?.night && samePlace(n.night, place) && n.night.name === place.name) n.night = { ...n.night, name };
      }
      save(); render(); drawMap(false);
    } else {
      setPlace(key, { ...place, name });
    }
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
  'fit-all'() { ui.focus = null; ui.sel = null; map.closePopup(); render(); drawMap(true); },
  'retry-routes'() {
    Object.keys(routeCache).forEach((k) => { if (routeCache[k].failed) delete routeCache[k]; });
    drawMap(false); updateStats();
  },
  'add-entry'(el) {
    if (ui.jdraft) closeEntryDraft();
    newEntryDraft(el.dataset.day, null, el.dataset.trip || null);
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
    entry.photos.forEach(dropPhoto);
    state.journal = state.journal.filter((e) => e !== entry);
    if (ui.sel === `entry:${entry.id}`) ui.sel = null;
    save(); render(); drawMap(false);
  },
  'cancel-entry'() { closeEntryDraft(); render(); },
  'save-entry'() {
    const jd = ui.jdraft;
    if (jd.busy) return;
    const text = jd.data.text.trim();
    if (jd.linkInput.trim() && !addDraftLink()) return;
    if (!text && !jd.data.photos.length && !jd.data.place && !jd.data.links.length) {
      jd.error = 'Schreib etwas, füge ein Foto oder einen Link hinzu oder wähle einen Ort.';
      render(); return;
    }
    const old = state.journal.find((e) => e.id === jd.entryId);
    const entry = {
      id: old ? old.id : uid(),
      dayId: jd.dayId,
      ...(entryTrip(jd.dayId, jd.data.tripId) ? { tripId: jd.data.tripId } : {}),
      at: old ? old.at : new Date().toISOString(),
      text,
      place: jd.data.place,
      photos: jd.data.photos,
      links: jd.data.links,
    };
    jd.removed.forEach(dropPhoto);
    if (old) state.journal[state.journal.indexOf(old)] = entry; else state.journal.push(entry);
    closeEntryDraft(true);
    save(); render(); drawMap(false);
  },
  'add-link'() { if (addDraftLink()) $('#jdraft-link')?.focus(); },
  'remove-link'(el) {
    ui.jdraft.data.links.splice(Number(el.dataset.idx), 1);
    render();
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
    if (ui.collapsed.delete(id)) saveCollapsed();
    ui.focus = `day:${id}`; ui.sel = null;
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
      btn.disabled = false; btn.textContent = 'Exportieren (Sicherung mit Fotos)';
    }
  },
  sample() {
    if (!confirm(`Die aktuelle Reise inklusive Tagebuch durch die Beispielreise ersetzen? Exportiere sie vorher, wenn du sie behalten willst.${syncCfg.tripId ? ' Die Online-Reise bleibt unverändert, dieses Gerät gleicht danach aber nicht mehr mit ihr ab.' : ''}`)) return;
    state.journal.flatMap((e) => e.photos).forEach(forgetPhoto);
    unlinkTrip(); renderSyncStatus();
    state = sampleTrip(); closeDraft(); closeEntryDraft(); ui.focus = null; ui.sel = null;
    save(); render(); drawMap(true);
  },
  'clear-all'() {
    if (!confirm(`Alle Tage und das Tagebuch löschen und eine leere Reise beginnen? Exportiere vorher, wenn du sie behalten willst.${syncCfg.tripId ? ' Die Online-Reise bleibt unverändert, dieses Gerät gleicht danach aber nicht mehr mit ihr ab.' : ''}`)) return;
    state.journal.flatMap((e) => e.photos).forEach(forgetPhoto);
    unlinkTrip(); renderSyncStatus();
    state = emptyTrip(); closeDraft(); closeEntryDraft(); ui.focus = null; ui.sel = null;
    save(); render(); drawMap(true);
  },
  'open-sync'() { openSync(); },
  'toggle-menu'() { setMenu($('#trip-menu').hidden); },
  'dismiss-hint'() { saveJSON(HINT_KEY, true); render(); },
  'toggle-legend'() {
    const open = $('.legend').classList.toggle('is-closed') === false;
    $('.legend-toggle').setAttribute('aria-expanded', String(open));
    saveJSON('reisekarte.legend.v1', open);
  },
  'toggle-day'(el) {
    const id = el.dataset.day;
    if (ui.collapsed.has(id)) ui.collapsed.delete(id); else ui.collapsed.add(id);
    saveCollapsed(); render();
  },
  'collapse-all'() { state.days.forEach((d) => ui.collapsed.add(d.id)); saveCollapsed(); render(); },
  'expand-all'() { ui.collapsed.clear(); saveCollapsed(); render(); },
  'edit-journey'(el) {
    const id = el.dataset.night;
    if (ui.journeyOpen.has(id)) ui.journeyOpen.delete(id); else ui.journeyOpen.add(id);
    render();
  },
  'close-sync'() { $('#sync-dialog').close(); },
  'sync-set-server'(form) {
    let url;
    try {
      url = new URL(form.elements.url.value.trim());
    } catch {
      sync.error = 'Das ist keine gültige Adresse. Beispiel: https://name.duckdns.org:8091';
      renderSync(); return;
    }
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
      sync.error = 'Die Adresse muss mit https:// beginnen, sonst blockiert der Browser die Verbindung.';
      renderSync(); return;
    }
    runSync(async () => {
      const pb = new PocketBase(url.origin);
      await pb.health.check();
      syncCfg.url = url.origin;
      unlinkTrip();
      connectServer();
      await loadAuthMethods();
    });
  },
  'sync-change-server'() {
    sync.pb?.authStore.clear();
    unlinkTrip();
    syncCfg.url = '';
    saveSync();
    connectServer(); sync.error = null;
    renderSync(); renderSyncStatus();
  },
  'sync-login'(form) {
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    runSync(async () => {
      await sync.pb.collection('users').authWithPassword(email, password);
      await afterLogin();
    });
  },
  'sync-google'() {
    // Das Fenster muss direkt im Klick geöffnet werden, sonst blockiert Safari es.
    const popup = window.open('', '_blank');
    runSync(async () => {
      try {
        await sync.pb.collection('users').authWithOAuth2({
          provider: 'google',
          urlCallback: (url) => { if (popup) popup.location.href = url; else window.open(url, '_blank'); },
        });
      } catch (err) {
        popup?.close();
        throw err;
      }
      await afterLogin();
    });
  },
  'sync-logout'() {
    clearTimeout(sync.timer);
    if (photoSync.uploading && !confirm('Es werden noch Fotos hochgeladen. Trotzdem abmelden?')) return;
    if (syncCfg.dirty && !confirm('Es gibt Änderungen, die noch nicht online sind. Trotzdem abmelden? Sie bleiben auf diesem Gerät gespeichert.')) return;
    sync.pb.authStore.clear();
    unlinkTrip();
    sync.error = null;
    renderSync(); renderSyncStatus();
  },
  'share-invite'(form) {
    const email = form.elements['share-email'].value.trim();
    const role = form.elements['share-role'].value;
    const password = form.elements['share-password']?.value || '';
    sendShare({ email, role, ...(password ? { password } : {}) }).then((res) => {
      if (!res) return;
      share.invite = inviteText(email, role, res.created ? password : '');
      share.copied = false;
      form.reset();
      renderSync();
      $('#sync-dialog [name="share-email"]').value = '';
    });
  },
  'share-remove'(el) {
    if (!confirm(`${el.dataset.email} ausladen? Die Person sieht die Reise danach nicht mehr.`)) return;
    sendShare({ email: el.dataset.email, role: 'remove' });
  },
  'view-link-create'() { setViewKey(newViewKey()); },
  'view-link-renew'() {
    if (confirm('Neuen Link erstellen? Der bisherige Link funktioniert dann nicht mehr.')) setViewKey(newViewKey());
  },
  'view-link-off'() {
    if (confirm('Link abschalten? Wer ihn hat, sieht die Reise dann nicht mehr.')) setViewKey('');
  },
  async 'view-link-copy'() {
    const url = viewLinkURL(viewLink.key);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      $('#sync-dialog .view-link')?.select(); document.execCommand?.('copy');
    }
    viewLink.copied = true;
    renderSync();
  },
  async 'view-link-share'() {
    try {
      await navigator.share({ title: state.title, text: `Hier kannst du unsere Reise „${state.title}“ mitverfolgen:`, url: viewLinkURL(viewLink.key) });
    } catch { /* abgebrochen */ }
  },
  async 'share-copy'() {
    const ta = $('#sync-dialog .invite-text');
    try {
      await navigator.clipboard.writeText(share.invite);
    } catch {
      ta.select(); document.execCommand?.('copy');
    }
    share.copied = true;
    renderSync();
  },
  'sync-upload'() {
    runSync(async () => {
      const rec = await sync.pb.collection('trips').create(
        { owner: sync.pb.authStore.record.id, title: state.title, data: state },
        { fields: 'id,title,updated' },
      );
      Object.assign(syncCfg, { tripId: rec.id, tripTitle: rec.title, remoteUpdated: rec.updated, dirty: false, role: 'owner' });
      saveSync();
      saveBase(clone(state));
      uploadPhotos();
    });
  },
  'sync-open-trip'(el) {
    const t = sync.trips?.find((x) => x.id === el.dataset.trip);
    if (!t) return;
    if (!confirm(`Die Reise auf diesem Gerät durch „${t.title || 'Ohne Namen'}“ ersetzen? Exportiere sie vorher, wenn du sie behalten willst.`)) return;
    runSync(async () => {
      const rec = await sync.pb.collection('trips').getOne(t.id);
      applyRemote(rec, true);
    });
  },
  'sync-unlink'() {
    if (syncCfg.dirty && !confirm('Es gibt Änderungen, die noch nicht online sind. Trotzdem trennen? Sie bleiben nur auf diesem Gerät.')) return;
    unlinkTrip();
    runSync(loadTripList);
  },
  'sync-now'() {
    runSync(() => (syncCfg.dirty ? pushTrip() : pullTrip()));
  },
};

// Was im Nur-Lesen-Modus geht: ansehen, auswählen, ein-/ausklappen, Sync, Export.
const READONLY_OK = new Set(['select', 'focus-day', 'focus-night', 'toggle-day', 'collapse-all', 'expand-all', 'open-photo', 'close-photo',
  'open-sync', 'close-sync', 'toggle-menu', 'export', 'fit-all', 'retry-routes', 'toggle-follow', 'today', 'toggle-map',
  'toggle-legend', 'edit-journey', 'share-copy', 'view-link-copy', 'view-link-share']);

function setMenu(open) {
  $('#trip-menu').hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', String(open));
  if (open) $('#trip-menu .menu-item')?.focus();
}

document.addEventListener('click', (e) => {
  if (e.target.closest('a[href]')) return; // Links normal öffnen, auch innerhalb anklickbarer Einträge
  // Menü schließen bei Klick daneben oder auf einen Menüpunkt (außer „Importieren“, das öffnet den Dateidialog).
  if (!$('#trip-menu').hidden && (!e.target.closest('.menu-wrap') || e.target.closest('button.menu-item'))) setMenu(false);
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  if (readOnly() && !READONLY_OK.has(el.dataset.action) && !el.dataset.action.startsWith('sync-')) return;
  // Ausgewähltes oder bearbeitetes Element in einem eingeklappten Tag: Tag aufklappen.
  if (['add-ex', 'add-entry'].includes(el.dataset.action)) ui.collapsed.delete(el.dataset.day);
  try {
    const r = actions[el.dataset.action](el);
    r?.catch?.((err) => showToast(`Da ist etwas schiefgegangen: ${err.message}`, true));
  } catch (err) {
    console.error(err);
    showToast(`Da ist etwas schiefgegangen: ${err.message}`, true);
  }
});

// Formulare (Sync-Dialog): Enter und Absenden-Knopf.
document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-submit]');
  if (!form || !actions[form.dataset.submit]) return;
  e.preventDefault();
  actions[form.dataset.submit](form);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.picker) picker(t.dataset.picker).query = t.value;
  else if (t.dataset.draft === 'name' && ui.draft) ui.draft.data.name = t.value;
  else if (t.dataset.draftNote !== undefined && ui.draft) ui.draft.data.notes[Number(t.dataset.draftNote)] = t.value;
  else if (t.dataset.jdraft === 'text' && ui.jdraft) { ui.jdraft.data.text = t.value; persistDraft(); }
  else if (t.dataset.jdraft === 'link' && ui.jdraft) { ui.jdraft.linkInput = t.value; persistDraft(); }
  else if (t.id === 'trip-title' && !readOnly()) { state.title = t.value; save(); }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.jdraft === 'trip' && ui.jdraft) {
    ui.jdraft.data.tripId = t.value || null;
    persistDraft(); render();
    $('#jdraft-text')?.focus();
    return;
  }
  if (t.dataset.draft && ui.draft) {
    const field = t.dataset.draft;
    if (field === 'end') {
      ui.draft.data.end = t.value;
      render();
      if (t.value === 'place') document.querySelector('[data-picker="draft:to"]')?.focus();
    } else if (field === 'mode') ui.draft.data.mode = t.value;
    else if (field === 'fromMode') {
      ui.draft.data.fromMode = t.value;
      render();
      if (t.value === 'custom') document.querySelector('[data-picker="draft:from"]')?.focus();
    }
  } else if (t.dataset.shareRole) {
    sendShare({ email: t.dataset.shareRole, role: t.value });
  } else if (t.dataset.journeyMode) {
    const n = nightById(t.dataset.journeyMode);
    if (n?.journey) { n.journey.mode = t.value; save(); render(); drawMap(false); }
  } else if (t.id === 'start-date' && t.value && !readOnly()) {
    state.startDate = t.value; save(); render(); drawMap(false);
  } else if (t.id === 'jdraft-photos' && t.files.length) {
    const files = [...t.files];
    t.value = '';
    addPhotos(files);
  } else if (t.id === 'import-file' && t.files[0]) {
    setMenu(false);
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
    if (syncCfg.tripId && !confirm('Die Reise ist mit einer Online-Reise verbunden. Soll die importierte Datei die Online-Reise ersetzen? „Abbrechen“ trennt die Verbindung, die Online-Reise bleibt dann unverändert.')) {
      unlinkTrip(); renderSyncStatus();
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
    closeDraft(); closeEntryDraft(true); ui.focus = null; ui.sel = null;
    save(); render(); drawMap(true);
  } catch (err) {
    alert(`Import fehlgeschlagen: ${err.message}`);
  }
}

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset?.action === 'select') {
    e.preventDefault();
    actions.select(e.target);
  } else if (e.key === 'Enter' && e.target.dataset?.jdraft === 'link') {
    e.preventDefault();
    actions['add-link']();
  } else if (e.key === 'Enter' && e.target.dataset?.picker) {
    e.preventDefault();
    searchPlace(e.target.dataset.picker);
  } else if (e.key === 'Escape' && !$('#trip-menu').hidden) {
    setMenu(false);
    $('#menu-btn').focus();
  } else if (e.key === 'Escape' && !$('#lightbox').hidden) {
    actions['close-photo']();
  } else if (e.key === 'Escape' && ui.mapPick) {
    ui.mapPick = null; render();
  }
});

/* ---------------------------------------------------------------- Liste ↔ Karte */

// Auf der Karte angeklickt: auswählen und in der Liste dorthin scrollen (fkey = 'day:<id>' oder 'night:<id>').
function selectFromMap(key, fkey) {
  ui.sel = key; ui.focus = fkey;
  const [type, id] = fkey.split(':');
  if (type === 'day' && ui.collapsed.delete(id)) saveCollapsed();
  render(); drawMap(false);
  if (selMarkerNow) selMarkerNow.openPopup();
  const el = document.querySelector(`#days [data-sel="${CSS.escape(key)}"]`) || document.getElementById(`${type}-${id}`);
  if (!el) return;
  follow.ignoreUntil = Date.now() + 1500; // das Scrollen soll die Karte nicht wieder verschieben
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Beim Scrollen der Liste zeigt die Karte den Tag oder die Nacht, die oben in der Liste steht (ganz oben: die ganze Reise).
const FOLLOW_KEY = 'reisekarte.follow.v1';
const follow = { on: loadJSON(FOLLOW_KEY, true) !== false, focus: null, ignoreUntil: 0, timer: null };
const FOCUSABLE = '#days .day, #days .night:not(.is-empty)';

function currentListFocus() {
  const panel = $('.panel');
  if (panel.scrollTop < 8) return null;
  const head = $('.panel-head');
  const top = getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().bottom : panel.getBoundingClientRect().top;
  const secs = [...document.querySelectorAll(FOCUSABLE)];
  // Ganz unten angekommen: das Letzte zählt, auch wenn es nicht mehr bis nach oben rutschen kann.
  const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 4;
  const sec = atEnd ? secs[secs.length - 1] : secs.find((x) => x.getBoundingClientRect().bottom > top + 40);
  if (!sec) return null;
  return sec.classList.contains('day') ? `day:${sec.id.slice(4)}` : `night:${sec.id.slice(6)}`;
}

function followList() {
  if (!follow.on || Date.now() < follow.ignoreUntil || drag?.started || ui.mapPick) return;
  const key = currentListFocus();
  if (key === follow.focus) return;
  follow.focus = key;
  if (ui.focus !== key) {
    // Hervorhebung wandert mit, ohne die Liste neu aufzubauen (sonst springt das Scrollen).
    ui.focus = key; ui.sel = null;
    const elId = key && key.replace(':', '-');
    document.querySelectorAll(FOCUSABLE).forEach((x) => x.classList.toggle('is-focused', x.id === elId));
    document.querySelectorAll('#days .is-selected').forEach((x) => x.classList.remove('is-selected'));
    map.closePopup();
    drawMap(false);
  }
  const pts = key ? timePts.get(key) : [...timePts.values()].flat();
  if (pts?.length) fitPoints(pts, false);
}

$('.panel').addEventListener('scroll', () => {
  clearTimeout(follow.timer);
  follow.timer = setTimeout(followList, 180);
}, { passive: true });

function renderFollowBtn() {
  const btn = $('#follow-btn');
  btn.classList.toggle('is-active', follow.on);
  btn.setAttribute('aria-pressed', String(follow.on));
}
actions['toggle-follow'] = () => {
  follow.on = !follow.on;
  follow.focus = undefined;
  saveJSON(FOLLOW_KEY, follow.on);
  renderFollowBtn();
  if (follow.on) followList();
};

/* ---------------------------------------------------------------- Größe Liste/Karte */

// Am Desktop die Breite der Liste, am Handy (Liste unter der Karte) die Höhe der Karte. Gemerkt pro Gerät.
const LAYOUT_KEY = 'reisekarte.layout.v1';
const layout = { w: null, h: null, ...loadJSON(LAYOUT_KEY, {}) };
const isStacked = () => matchMedia('(max-width: 800px)').matches;

function applyLayout() {
  const app = $('.app');
  const r = app.getBoundingClientRect();
  // Grenzen: Liste und Karte bleiben immer benutzbar.
  if (layout.w && !isStacked()) layout.w = Math.round(Math.min(Math.max(layout.w, 280), r.width - 320));
  if (layout.h && isStacked()) layout.h = Math.round(Math.min(Math.max(layout.h, 120), r.height - 200));
  if (layout.w) app.style.setProperty('--panel-w', `${layout.w}px`); else app.style.removeProperty('--panel-w');
  if (layout.h) app.style.setProperty('--map-h', `${layout.h}px`); else app.style.removeProperty('--map-h');
  map.invalidateSize();
}

function setLayoutFromPointer(x, y) {
  const r = $('.app').getBoundingClientRect();
  if (isStacked()) layout.h = y - r.top; else layout.w = x - r.left;
  applyLayout();
}

{
  const handle = $('#resizer');
  let active = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    active = e.pointerId;
    try { handle.setPointerCapture(e.pointerId); } catch { /* ohne Capture geht es auch */ }
    handle.classList.add('is-active');
    document.body.classList.add('is-resizing');
  });
  handle.addEventListener('pointermove', (e) => {
    if (e.pointerId === active) setLayoutFromPointer(e.clientX, e.clientY);
  });
  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    handle.classList.remove('is-active');
    document.body.classList.remove('is-resizing');
    saveJSON(LAYOUT_KEY, layout);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => {
    layout.w = null; layout.h = null;
    saveJSON(LAYOUT_KEY, layout); applyLayout();
  });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 24;
    const stacked = isStacked();
    const keys = stacked ? { ArrowUp: -step, ArrowDown: step } : { ArrowLeft: -step, ArrowRight: step };
    if (!(e.key in keys)) return;
    e.preventDefault();
    if (stacked) layout.h = (layout.h || $('.map-wrap').getBoundingClientRect().height) + keys[e.key];
    else layout.w = (layout.w || $('.panel').getBoundingClientRect().width) + keys[e.key];
    applyLayout(); saveJSON(LAYOUT_KEY, layout);
  });
  window.addEventListener('resize', applyLayout);
  handle.setAttribute('aria-orientation', isStacked() ? 'horizontal' : 'vertical');
  matchMedia('(max-width: 800px)').addEventListener?.('change', () => {
    handle.setAttribute('aria-orientation', isStacked() ? 'horizontal' : 'vertical');
    applyLayout();
  });
  applyLayout();
}

/* ---------------------------------------------------------------- Tage verschieben */

// Ziehen am Griff (Maus und Finger) oder Pfeiltasten auf dem Griff.
let drag = null;

function moveDay(from, to) {
  // to = Einfügeposition in der alten Reihenfolge (0 … Anzahl Tage)
  if (to < 0 || to > state.days.length || to === from || to === from + 1) return false;
  // Die Nächte bleiben an ihrem Platz zwischen den Tagen, nur die Tage wandern.
  const nights = state.days.map(({ night, transit, journey }) => ({ night, transit, journey }));
  const [d] = state.days.splice(from, 1);
  state.days.splice(to > from ? to - 1 : to, 0, d);
  state.days.forEach((x, k) => Object.assign(x, nights[k]));
  save(); render(); drawMap(false);
  return true;
}

function dropIndex(y) {
  const sections = [...document.querySelectorAll('#days .day')];
  const k = sections.findIndex((x) => { const r = x.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return k < 0 ? sections.length : k;
}

function showDrop() {
  const sections = [...document.querySelectorAll('#days .day')];
  drag.to = dropIndex(drag.y);
  sections.forEach((x, k) => {
    x.classList.toggle('drop-before', k === drag.to);
    x.classList.toggle('drop-after', drag.to === sections.length && k === sections.length - 1);
  });
}

function dragScroll() {
  if (!drag?.started) return;
  const panel = $('.panel');
  const head = $('.panel-head');
  const r = panel.getBoundingClientRect();
  const top = getComputedStyle(head).position === 'sticky' ? head.getBoundingClientRect().bottom : r.top;
  if (drag.y < top + 50) panel.scrollTop -= 12;
  else if (drag.y > r.bottom - 50) panel.scrollTop += 12;
  showDrop();
  requestAnimationFrame(dragScroll);
}

function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  document.body.classList.remove('is-dragging-day');
  document.querySelectorAll('#days .day').forEach((x) => x.classList.remove('is-dragging', 'drop-before', 'drop-after'));
  if (commit && d.started && d.to !== null) moveDay(d.from, d.to);
}

document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-drag]');
  if (!h || e.button > 0 || readOnly()) return;
  e.preventDefault();
  drag = { from: dayIndex(h.dataset.drag), to: null, startY: e.clientY, y: e.clientY, pointerId: e.pointerId, section: h.closest('.day'), started: false };
  try { h.setPointerCapture(e.pointerId); } catch { /* ohne Capture geht es auch */ }
});
document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.y = e.clientY;
  if (!drag.started) {
    if (Math.abs(e.clientY - drag.startY) < 5) return;
    drag.started = true;
    drag.section.classList.add('is-dragging');
    document.body.classList.add('is-dragging-day');
    requestAnimationFrame(dragScroll);
  }
  showDrop();
});
document.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
document.addEventListener('pointercancel', () => endDrag(false));

document.addEventListener('keydown', (e) => {
  const h = e.target.closest?.('[data-drag]');
  if (!h || readOnly() || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const i = dayIndex(h.dataset.drag);
  if (moveDay(i, e.key === 'ArrowUp' ? i - 1 : i + 2)) document.querySelector(`[data-drag="${h.dataset.drag}"]`)?.focus();
});

$('#app-version').textContent = `Version ${APP_VERSION}`;
const draftRestored = restoreDraft();
render();
drawMap(true);
if (draftRestored) {
  setTimeout(() => document.querySelector('#jdraft-text')?.scrollIntoView({ block: 'center' }), 300);
  showToast('Dein angefangener Tagebucheintrag wurde wiederhergestellt.');
}
renderFollowBtn();

if (loadJSON('reisekarte.legend.v1', true) === false) {
  $('.legend').classList.add('is-closed');
  $('.legend-toggle').setAttribute('aria-expanded', 'false');
}

// Einladungslink (…?server=https://…): Server-Adresse übernehmen und zur Anmeldung auffordern.
{
  const params = new URLSearchParams(location.search);
  const invited = params.get('server');
  if (invited && !guest) {
    history.replaceState(null, '', location.pathname);
    try {
      const u = new URL(invited);
      if (!syncCfg.url && (u.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(u.hostname))) {
        syncCfg.url = u.origin;
        saveSync();
      }
    } catch { /* ungültiger Link: ignorieren */ }
    setTimeout(() => { if (syncCfg.url && !loggedIn()) openSync(); }, 0);
  }
}

// Online-Sync: Anmeldung auffrischen und Stand vom Server holen. In der Gastansicht nur die angesehene Reise laden.
if (guest) {
  loadGuest(false);
} else {
  connectServer();
  renderSyncStatus();
  if (loggedIn()) {
    sync.pb.collection('users').authRefresh().catch((err) => {
      if (err.status === 401) { sync.pb.authStore.clear(); renderSyncStatus(); }
    });
    pullTrip();
  }
}
const refresh = () => (guest ? loadGuest(false) : syncCfg.dirty ? pushTrip() : pullTrip());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh();
});
window.addEventListener('online', refresh);
setInterval(() => {
  if (document.visibilityState === 'visible') refresh();
}, 60000);

// Auf dem Handy direkt zum heutigen Tag springen.
// (Index erst beim Springen bestimmen: Die Gastansicht kann die Reise inzwischen ausgetauscht haben.)
setTimeout(() => { const i = todayIndex(); if (i >= 0) scrollToDay(state.days[i].id); }, 300);

// Browser bitten, die Daten nicht automatisch zu löschen (wird nicht überall gewährt).
navigator.storage?.persist?.().catch(() => {});

// Offline-Start und Installation auf dem Startbildschirm.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((err) => console.warn('Service Worker:', err.message));
}
