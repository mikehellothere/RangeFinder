// In-memory data store. Swap for a database when the real cameras arrive.

const MAX_DETECTIONS = 500;

export const store = {
  cameras: [],
  detections: [],
};

let nextDetectionId = 1;

// Offset a lat/lng by metres (rough equirectangular approximation — fine at park scale).
function offsetMetres(lat, lng, dNorth, dEast) {
  const dLat = dNorth / 111_320;
  const dLng = dEast / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

const CAMERA_NAMES = [
  'North Ridge', 'Waterhole', 'Acacia Grove', 'River Bend',
  'South Gate', 'Baobab Flats', 'Kopje Lookout', 'Marsh Edge',
];

export function seedCameras(centerLat, centerLng) {
  store.cameras = CAMERA_NAMES.map((name, i) => {
    // Ring of cameras 350–1400 m out, evenly spread with a little jitter
    const angle = (i / CAMERA_NAMES.length) * 2 * Math.PI + (Math.random() - 0.5) * 0.5;
    const dist = 350 + Math.random() * 1050;
    const { lat, lng } = offsetMetres(centerLat, centerLng, Math.cos(angle) * dist, Math.sin(angle) * dist);
    return {
      id: `cam-${i + 1}`,
      name: `${name} Cam`,
      lat,
      lng,
      battery: Math.round(55 + Math.random() * 45),
      status: 'online',
    };
  });
  store.detections = [];
  nextDetectionId = 1;
  return store.cameras;
}

export function getCamera(id) {
  return store.cameras.find((c) => c.id === id);
}

// Accepts a "detection package" as the camera unit will send it,
// enriches it with server-side fields, and stores it.
export function addDetection(pkg) {
  const camera = getCamera(pkg.cameraId);
  if (!camera) return { error: `Unknown cameraId "${pkg.cameraId}"` };
  if (!pkg.species || typeof pkg.species !== 'string') return { error: 'Missing "species"' };

  const detection = {
    id: `det-${nextDetectionId++}`,
    cameraId: camera.id,
    cameraName: camera.name,
    lat: camera.lat,
    lng: camera.lng,
    species: pkg.species.toLowerCase(),
    confidence: typeof pkg.confidence === 'number' ? Math.min(1, Math.max(0, pkg.confidence)) : null,
    behavior: pkg.behavior ?? null,
    healthAlert: Boolean(pkg.healthAlert),
    timestamp: pkg.timestamp ?? new Date().toISOString(),
  };

  store.detections.push(detection);
  if (store.detections.length > MAX_DETECTIONS) {
    store.detections.splice(0, store.detections.length - MAX_DETECTIONS);
  }
  return { detection };
}
