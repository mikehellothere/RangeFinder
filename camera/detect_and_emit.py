#!/usr/bin/env python3
"""
Wildlife detection -> web app bridge (Pi 5 + Hailo-8L, picamera2).

Runs Hailo object detection on the camera feed and POSTs a "detection package"
to the web app's /api/detections endpoint whenever a target animal is seen.

emit_event() is the integration seam: everything above it (camera + Hailo) and
below it (the web app) can change independently.

Run:
    python3 detect_and_emit.py --no-preview -l ~/coco.txt

Before running, set SERVER_URL to your Mac's LAN IP (NOT localhost -- the Pi is
a different machine) and CAMERA_ID to a camera the app already knows about
(check http://<mac-ip>:3000/api/state to see valid IDs).
"""

import argparse
import json
import time
import datetime
import urllib.request
import urllib.error
from pathlib import Path

import cv2
from picamera2 import Picamera2, Preview
from picamera2.devices import Hailo

# --- Where detections go -----------------------------------------------------
# Your Mac's LAN IP + the app's port. Find the IP with: ipconfig getifaddr en0
SERVER_URL = "http://192.168.1.229:3000/api/detections"   # <-- EDIT THIS
# Must match a camera the app has registered (see /api/state). Demo IDs look
# like "cam-1". The pin appears at that camera's location for now.
CAMERA_ID = "cam-1"                                       # <-- maybe EDIT THIS

# --- What we care about, and how sure we need to be -------------------------
TARGET_CLASSES = {"person", "cat", "dog", "bird", "horse",
                  "sheep", "cow", "elephant", "bear"}
SCORE_THRESHOLD = 0.45          # ignore weak detections
COOLDOWN_SECONDS = 10           # don't emit the same critter 30x/second
THUMBNAIL_DIR = Path.home() / "detections"


def extract_detections(hailo_output, w, h, class_names, threshold):
    """HailoRT output -> [label, (x0,y0,x1,y1), score]."""
    results = []
    for class_id, detections in enumerate(hailo_output):
        for det in detections:
            score = float(det[4])
            if score >= threshold:
                y0, x0, y1, x1 = det[:4]
                bbox = (int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h))
                results.append([class_names[class_id], bbox, score])
    return results


def emit_event(event, frame_rgb):
    """THE SEAM. Sends the detection package to the web app.

    Saves a thumbnail locally (for later, when the app accepts images), then
    POSTs the package the app expects. Prints the outcome so you can see
    success (201) vs rejection (400, usually a bad cameraId) vs a network
    problem (wrong IP / not on the same Wi-Fi / server not running).
    """
    # Save a thumbnail locally -- not sent yet, the contract has no image field.
    THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)
    thumb_path = THUMBNAIL_DIR / f"{event['id']}.jpg"
    cv2.imwrite(str(thumb_path), cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR))

    # Build the exact package the app's /api/detections expects.
    package = {
        "cameraId": CAMERA_ID,
        "species": event["label"],          # lowercase already
        "confidence": event["confidence"],  # 0-1
        "timestamp": event["timestamp"],    # ISO 8601
    }

    data = json.dumps(package).encode("utf-8")
    req = urllib.request.Request(
        SERVER_URL, data=data,
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            print(f"[{resp.status}] sent {package['species']} "
                  f"({package['confidence']}) -> pin dropped")
    except urllib.error.HTTPError as e:
        print(f"[{e.code}] server rejected it: {e.read().decode()}  "
              f"(payload: {package})")
    except urllib.error.URLError as e:
        print(f"[network] could not reach {SERVER_URL}: {e.reason}  "
              f"-- check the Mac IP, same Wi-Fi, and that the app is running")


def main():
    parser = argparse.ArgumentParser(description="Detect animals and POST them.")
    parser.add_argument("-m", "--model",
                        default="/usr/share/hailo-models/yolov8s_h8l.hef",
                        help="Path to the HEF model.")
    parser.add_argument("-l", "--labels", default="coco.txt",
                        help="Path to the class-name labels file.")
    parser.add_argument("--no-preview", action="store_true",
                        help="Run headless (no preview window).")
    args = parser.parse_args()

    with open(args.labels, "r", encoding="utf-8") as f:
        class_names = f.read().splitlines()

    last_emit = 0.0

    with Hailo(args.model) as hailo:
        model_h, model_w, _ = hailo.get_input_shape()
        main_w, main_h = 1280, 960

        with Picamera2() as picam2:
            main = {"size": (main_w, main_h), "format": "XRGB8888"}
            lores = {"size": (model_w, model_h), "format": "RGB888"}
            config = picam2.create_preview_configuration(
                main, lores=lores, controls={"FrameRate": 30})
            picam2.configure(config)

            if not args.no_preview:
                picam2.start_preview(Preview.QTGL, x=0, y=0,
                                     width=main_w, height=main_h)
            picam2.start()
            print(f"Running. POSTing to {SERVER_URL} as {CAMERA_ID}. Ctrl-C to stop.")

            try:
                while True:
                    frame = picam2.capture_array("lores")
                    results = hailo.run(frame)
                    detections = extract_detections(
                        results, main_w, main_h, class_names, SCORE_THRESHOLD)

                    hits = [d for d in detections if d[0] in TARGET_CLASSES]
                    if not hits:
                        continue

                    now = time.time()
                    if now - last_emit < COOLDOWN_SECONDS:
                        continue
                    last_emit = now

                    label, bbox, score = max(hits, key=lambda d: d[2])
                    event = {
                        "id": datetime.datetime.now().strftime("%Y%m%d_%H%M%S_%f"),
                        "timestamp": datetime.datetime.now(
                            datetime.timezone.utc).isoformat(),
                        "label": label,
                        "confidence": round(score, 3),
                        "bbox": bbox,
                    }
                    thumb_frame = picam2.capture_array("main")[:, :, :3]
                    emit_event(event, thumb_frame)

            except KeyboardInterrupt:
                print("\nStopped.")


if __name__ == "__main__":
    main()
