// Fake camera units. Generates detection packages in the exact shape the
// real Raspberry Pi / camera chip will POST to /api/detections, so the rest
// of the system can't tell the difference.

import { store, addDetection } from './store.js';

const SPECIES = [
  { species: 'lion', weight: 1 },
  { species: 'elephant', weight: 2 },
  { species: 'giraffe', weight: 2 },
  { species: 'zebra', weight: 3 },
  { species: 'rhino', weight: 1 },
  { species: 'cheetah', weight: 1 },
  { species: 'buffalo', weight: 2 },
  { species: 'hippo', weight: 1 },
  { species: 'warthog', weight: 2 },
  { species: 'antelope', weight: 3 },
];

const BEHAVIORS = ['grazing', 'walking', 'resting', 'drinking', 'running', 'alert'];

function weightedSpecies() {
  const total = SPECIES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const s of SPECIES) {
    r -= s.weight;
    if (r <= 0) return s.species;
  }
  return SPECIES[0].species;
}

export function createSimulator(onDetection) {
  let enabled = true;
  let timer = null;

  function scheduleNext() {
    const delay = 3000 + Math.random() * 9000; // a detection every 3–12 s
    timer = setTimeout(tick, delay);
  }

  function tick() {
    if (enabled && store.cameras.length > 0) {
      const camera = store.cameras[Math.floor(Math.random() * store.cameras.length)];
      const pkg = {
        cameraId: camera.id,
        species: weightedSpecies(),
        confidence: Math.round((0.7 + Math.random() * 0.29) * 100) / 100,
        behavior: BEHAVIORS[Math.floor(Math.random() * BEHAVIORS.length)],
        healthAlert: Math.random() < 0.07,
        timestamp: new Date().toISOString(),
      };
      const { detection } = addDetection(pkg);
      if (detection) onDetection(detection);
    }
    scheduleNext();
  }

  scheduleNext();

  return {
    get enabled() {
      return enabled;
    },
    setEnabled(value) {
      enabled = Boolean(value);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
