import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { store, seedCameras, addDetection } from './store.js';
import { createSimulator } from './simulator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

// ---- WebSocket: pushes detections to every connected app instance ----
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

const simulator = createSimulator((detection) => {
  broadcast({ type: 'detection', detection });
});

// ---- REST API ----

// Full state for app start-up / reconnect
app.get('/api/state', (req, res) => {
  res.json({
    cameras: store.cameras,
    detections: store.detections.slice(-100),
    simulatorEnabled: simulator.enabled,
  });
});

// Seed demo cameras around a point (the app calls this with the user's location).
// Idempotent unless reset=true — so a second device joining doesn't move the park.
app.post('/api/cameras/seed', (req, res) => {
  const { lat, lng, reset } = req.body ?? {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Body must include numeric "lat" and "lng"' });
  }
  if (store.cameras.length > 0 && !reset) {
    return res.json({ cameras: store.cameras, seeded: false });
  }
  const cameras = seedCameras(lat, lng);
  broadcast({ type: 'cameras', cameras });
  res.json({ cameras, seeded: true });
});

// The endpoint the real camera unit (Pi → smaller chip) will POST to over cellular.
// Expected detection package:
//   { cameraId, species, confidence?, behavior?, healthAlert?, timestamp? }
app.post('/api/detections', (req, res) => {
  const { detection, error } = addDetection(req.body ?? {});
  if (error) return res.status(400).json({ error });
  broadcast({ type: 'detection', detection });
  res.status(201).json({ detection });
});

// Pause/resume the fake cameras from the UI
app.post('/api/simulator', (req, res) => {
  simulator.setEnabled(req.body?.enabled);
  broadcast({ type: 'simulator', enabled: simulator.enabled });
  res.json({ enabled: simulator.enabled });
});

server.listen(PORT, () => {
  console.log(`Rangefinder running at http://localhost:${PORT}`);
});
