# Rangefinder

Live animal-tracking map for AI trail cameras. Camera units (Raspberry Pi today,
smaller hardware later) detect and identify animals, then send a **detection
package** to this server over cellular data. Every connected app instance sees
the detection appear on the map in real time.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000. Allow location access and the app centres on you,
seeds 8 demo cameras around your position, and starts a simulator that fakes
camera detections every few seconds.

To try it on your phone, connect it to the same Wi-Fi and open
`http://<your-mac-ip>:3000`. Note: browsers only allow geolocation over HTTPS
or localhost, so on the phone the app will fall back to the demo location
unless you serve it over HTTPS (e.g. with a tunnel like `ngrok`/`cloudflared`).
You can install it as an app from the browser menu ("Add to Home Screen").

## The detection package

This is the contract between camera hardware and app. Your Pi should POST it:

```bash
curl -X POST http://localhost:3000/api/detections \
  -H 'Content-Type: application/json' \
  -d '{
    "cameraId": "cam-1",
    "species": "elephant",
    "confidence": 0.94,
    "behavior": "drinking",
    "healthAlert": false,
    "timestamp": "2026-07-02T12:00:00Z"
  }'
```

| Field         | Required | Notes                                                      |
| ------------- | -------- | ---------------------------------------------------------- |
| `cameraId`    | yes      | Must match a registered camera                             |
| `species`     | yes      | Lowercase name; unknown species get a generic paw icon     |
| `confidence`  | no       | 0–1 from the recognition model                             |
| `behavior`    | no       | e.g. `grazing`, `drinking` — for the behaviour model later |
| `healthAlert` | no       | `true` flags a possible sick animal (red badge on the map) |
| `timestamp`   | no       | ISO 8601; server time used if omitted                      |

## API

- `GET /api/state` — cameras, last 100 detections, simulator status
- `POST /api/cameras/seed` — `{lat, lng, reset?}` create demo cameras around a point
- `POST /api/detections` — the endpoint camera units call (see above)
- `POST /api/simulator` — `{enabled}` pause/resume the fake cameras
- `WS /ws` — pushes `{type: "detection" | "cameras" | "simulator", ...}` live

## Architecture notes / next steps

- Data is in-memory: restarting the server clears cameras and detections.
  First upgrade: SQLite via `better-sqlite3`.
- No auth yet. Before real deployment the detection endpoint needs a per-camera
  API key, and the app needs user accounts (one park = one tenant).
- Real cameras should get a registration flow (`POST /api/cameras` with an
  install location) instead of the demo seeding.
- Thumbnails: add an image URL/upload to the detection package so rangers can
  verify sightings.
