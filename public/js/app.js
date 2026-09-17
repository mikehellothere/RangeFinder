/* global L */
'use strict';

// ---------- Config ----------

// Fallback centre if geolocation is unavailable/denied (Longleat Safari Park, UK)
const FALLBACK_CENTER = { lat: 51.1858, lng: -2.2769 };
const STALE_AFTER_MS = 5 * 60 * 1000; // detections fade after 5 minutes

const SPECIES_EMOJI = {
  lion: '🦁', elephant: '🐘', giraffe: '🦒', zebra: '🦓', rhino: '🦏',
  cheetah: '🐆', buffalo: '🐃', hippo: '🦛', warthog: '🐗', antelope: '🦌',
};
const emojiFor = (species) => SPECIES_EMOJI[species] ?? '🐾';

// ---------- Map ----------

const map = L.map('map', { zoomControl: false }).setView(
  [FALLBACK_CENTER.lat, FALLBACK_CENTER.lng],
  14
);
L.control.zoom({ position: 'bottomright' }).addTo(map);

const satellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 19, attribution: 'Imagery © Esri' }
);
const stylised = L.tileLayer(
  'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  { maxZoom: 19, attribution: '© OpenStreetMap contributors © CARTO' }
);
satellite.addTo(map);
L.control.layers(
  { 'Satellite': satellite, 'Stylised map': stylised },
  null,
  { position: 'topright' }
).addTo(map);

// ---------- State ----------

let userMarker = null;
const cameraMarkers = new Map(); // cameraId -> L.Marker
// One marker per species per camera — "last known location", not a pile-up
const animalMarkers = new Map(); // `${cameraId}:${species}` -> { marker, detection }
let detectionCount = 0;
let simulatorEnabled = true;

// ---------- UI helpers ----------

const feedEl = document.getElementById('feed');
const feedEmptyEl = document.getElementById('feed-empty');
const countEl = document.getElementById('detection-count');
const connDot = document.getElementById('conn-dot');
const toastEl = document.getElementById('toast');

function toast(message, ms = 3500) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (toastEl.hidden = true), ms);
}

function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// ---------- Markers ----------

function upsertUserMarker(lat, lng) {
  if (!userMarker) {
    userMarker = L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: '<div class="marker-user"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(map);
  } else {
    userMarker.setLatLng([lat, lng]);
  }
}

function renderCameras(cameras) {
  for (const cam of cameras) {
    if (cameraMarkers.has(cam.id)) {
      cameraMarkers.get(cam.id).setLatLng([cam.lat, cam.lng]);
      continue;
    }
    const marker = L.marker([cam.lat, cam.lng], {
      icon: L.divIcon({ className: '', html: '<div class="marker-camera">📷</div>', iconSize: [30, 30], iconAnchor: [15, 15] }),
    }).addTo(map);
    marker.bindPopup(
      `<div class="popup-title">${cam.name}</div>` +
      `Status: ${cam.status}<br>Battery: ${cam.battery}%<br><code>${cam.id}</code>`
    );
    cameraMarkers.set(cam.id, marker);
  }
}

function animalPopupHtml(d) {
  const conf = d.confidence != null ? `${Math.round(d.confidence * 100)}%` : '—';
  return (
    `<div class="popup-title">${emojiFor(d.species)} ${d.species}</div>` +
    `Seen at <b>${d.cameraName}</b><br>` +
    `${new Date(d.timestamp).toLocaleTimeString()} · confidence ${conf}<br>` +
    (d.behavior ? `Behaviour: ${d.behavior}<br>` : '') +
    (d.healthAlert ? `<span class="health-flag">⚠ Possible health concern</span>` : '')
  );
}

function upsertAnimalMarker(d) {
  const key = `${d.cameraId}:${d.species}`;
  // Jitter each species slightly around its camera so icons don't stack exactly
  const hash = [...d.species].reduce((a, c) => a + c.charCodeAt(0), 0);
  const jLat = ((hash % 7) - 3) * 0.00012;
  const jLng = ((hash % 5) - 2) * 0.00016;

  const existing = animalMarkers.get(key);
  if (existing) {
    existing.detection = d;
    existing.marker.setPopupContent(animalPopupHtml(d));
    const el = existing.marker.getElement()?.firstElementChild;
    if (el) {
      el.classList.remove('stale');
      el.classList.toggle('health', d.healthAlert);
    }
    return existing.marker;
  }

  const html =
    `<div class="marker-animal ${d.healthAlert ? 'health' : ''}" style="position:relative">` +
    `${emojiFor(d.species)}${d.healthAlert ? '<span class="badge">!</span>' : ''}</div>`;
  const marker = L.marker([d.lat + jLat, d.lng + jLng], {
    icon: L.divIcon({ className: '', html, iconSize: [38, 38], iconAnchor: [19, 19] }),
    zIndexOffset: 500,
  }).addTo(map);
  marker.bindPopup(animalPopupHtml(d));
  animalMarkers.set(key, { marker, detection: d });
  return marker;
}

// Fade markers whose last sighting is old
setInterval(() => {
  const now = Date.now();
  for (const { marker, detection } of animalMarkers.values()) {
    const el = marker.getElement()?.firstElementChild;
    if (el) el.classList.toggle('stale', now - new Date(detection.timestamp).getTime() > STALE_AFTER_MS);
  }
  // refresh feed timestamps
  for (const t of feedEl.querySelectorAll('.feed-time')) {
    t.textContent = timeAgo(t.dataset.ts);
  }
}, 30_000);

// ---------- Detection feed ----------

function addToFeed(d) {
  feedEmptyEl.style.display = 'none';
  detectionCount++;
  countEl.textContent = detectionCount;

  const li = document.createElement('li');
  li.className = `feed-item${d.healthAlert ? ' health' : ''}`;
  li.innerHTML =
    `<span class="feed-emoji">${emojiFor(d.species)}</span>` +
    `<span class="feed-body">` +
    `<div class="feed-species">${d.species}${d.healthAlert ? ' <span class="health-flag">⚠</span>' : ''}</div>` +
    `<div class="feed-meta">${d.cameraName}${d.confidence != null ? ` · ${Math.round(d.confidence * 100)}%` : ''}</div>` +
    `</span>` +
    `<span class="feed-time" data-ts="${d.timestamp}">${timeAgo(d.timestamp)}</span>`;
  li.addEventListener('click', () => {
    const marker = upsertAnimalMarker(d);
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 16));
    marker.openPopup();
  });
  feedEl.prepend(li);
  while (feedEl.children.length > 60) feedEl.lastElementChild.remove();
}

function handleDetection(d) {
  upsertAnimalMarker(d);
  addToFeed(d);
}

// ---------- Server communication ----------

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => connDot.classList.add('connected');
  ws.onclose = () => {
    connDot.classList.remove('connected');
    setTimeout(connectWebSocket, 2000);
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'detection') handleDetection(msg.detection);
    else if (msg.type === 'cameras') renderCameras(msg.cameras);
    else if (msg.type === 'simulator') updateSimButton(msg.enabled);
  };
}

// ---------- Simulator toggle ----------

const simBtn = document.getElementById('btn-sim');
function updateSimButton(enabled) {
  simulatorEnabled = enabled;
  simBtn.textContent = enabled ? '⏸ Pause demo' : '▶ Resume demo';
}
simBtn.addEventListener('click', async () => {
  const { enabled } = await api('/api/simulator', { enabled: !simulatorEnabled });
  updateSimButton(enabled);
});

// ---------- Geolocation ----------

function locateUser() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  });
}

function watchUser() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition(
    (pos) => upsertUserMarker(pos.coords.latitude, pos.coords.longitude),
    () => {},
    { enableHighAccuracy: true }
  );
}

document.getElementById('btn-locate').addEventListener('click', async () => {
  const loc = await locateUser();
  if (loc) {
    upsertUserMarker(loc.lat, loc.lng);
    map.flyTo([loc.lat, loc.lng], 15);
  } else {
    toast('Location unavailable — check browser permissions');
  }
});

// ---------- Mobile bottom-sheet collapse ----------

document.getElementById('btn-collapse').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed');
});

// ---------- Start-up ----------

async function init() {
  connectWebSocket();
  watchUser();

  const loc = await locateUser();
  const center = loc ?? FALLBACK_CENTER;
  if (loc) upsertUserMarker(loc.lat, loc.lng);
  else toast('Using demo location — allow location access for the real one');

  map.setView([center.lat, center.lng], 14);

  // Seed demo cameras around the user (no-op if the park already exists)
  try {
    await api('/api/cameras/seed', { lat: center.lat, lng: center.lng });
  } catch {
    toast('Could not reach the server');
  }

  // Load current state: cameras + recent detections
  try {
    const state = await api('/api/state');
    renderCameras(state.cameras);
    for (const d of state.detections) handleDetection(d);
    updateSimButton(state.simulatorEnabled);
    if (state.cameras.length > 0) {
      const bounds = L.latLngBounds(state.cameras.map((c) => [c.lat, c.lng]));
      if (loc) bounds.extend([loc.lat, loc.lng]);
      map.fitBounds(bounds.pad(0.15));
    }
  } catch {
    feedEmptyEl.textContent = 'Server unreachable — start it with: npm start';
  }
}

init();

// ---------- PWA service worker ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
