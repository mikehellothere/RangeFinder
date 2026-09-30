#!/usr/bin/env python3
"""
Capture one image on the Pi and upload it to S3 via the trail-camera API.

Flow:
    1. Capture a JPEG from the Pi camera (held in memory, not written to disk).
    2. POST to the API Gateway endpoint to get a presigned S3 upload URL.
    3. PUT the JPEG bytes to that URL.

Nothing is sent to the web app -- recognition happens in AWS later.

Config lives in a .env file next to this script (see .env.example):
    UPLOAD_API_URL=https://xxxx.execute-api.eu-north-1.amazonaws.com/prod/get-upload-url
    CAMERA_ID=cam-1

Run:
    python3 capture_and_upload.py
    python3 capture_and_upload.py --keep-local   # also save a copy on the Pi
"""

import argparse
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from picamera2 import Picamera2

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_PATH = SCRIPT_DIR / ".env"
LOCAL_DIR = Path.home() / "detections"

CAPTURE_SIZE = (1920, 1080)
WARMUP_SECONDS = 2          # let auto-exposure and white balance settle
REQUEST_TIMEOUT = 20


def load_env(path):
    """Read a simple KEY=VALUE .env file into os.environ."""
    if not path.exists():
        sys.exit(f"No .env file found at {path}. Copy .env.example to .env and fill it in.")

    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def capture_jpeg():
    """Capture a single still and return it as JPEG bytes."""
    buffer = io.BytesIO()
    with Picamera2() as picam2:
        config = picam2.create_still_configuration(main={"size": CAPTURE_SIZE})
        picam2.configure(config)
        picam2.start()
        time.sleep(WARMUP_SECONDS)
        picam2.capture_file(buffer, format="jpeg")
    return buffer.getvalue()


def request_upload_url(api_url, camera_id):
    """Ask the API for a presigned S3 PUT URL. Returns (upload_url, filename)."""
    payload = json.dumps({
        "metadata": {
            "camera_id": camera_id,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    }).encode("utf-8")

    req = urllib.request.Request(
        api_url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    if "upload_url" not in body:
        raise ValueError(f"API response had no upload_url: {body}")
    return body["upload_url"], body.get("filename", "unknown")


def upload_image(upload_url, image_bytes):
    """PUT the JPEG to S3. Content-Type must match what the URL was signed with."""
    req = urllib.request.Request(
        upload_url,
        data=image_bytes,
        headers={"Content-Type": "image/jpeg"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.status


def save_local_copy(image_bytes):
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = LOCAL_DIR / f"{stamp}.jpg"
    path.write_bytes(image_bytes)
    return path


def main():
    parser = argparse.ArgumentParser(description="Capture an image and upload it to S3.")
    parser.add_argument("--keep-local", action="store_true",
                        help="Also save a copy to ~/detections/")
    parser.add_argument("--no-upload", action="store_true",
                        help="Capture only, skip AWS. Useful for testing the camera.")
    args = parser.parse_args()

    load_env(ENV_PATH)
    api_url = os.environ.get("UPLOAD_API_URL")
    camera_id = os.environ.get("CAMERA_ID", "unknown")

    if not api_url and not args.no_upload:
        sys.exit("UPLOAD_API_URL is not set in .env")

    print("Capturing...")
    try:
        image_bytes = capture_jpeg()
    except Exception as e:
        sys.exit(f"Capture failed: {e}")
    print(f"Captured {len(image_bytes) / 1024:.0f} KB")

    if args.no_upload:
        path = save_local_copy(image_bytes)
        print(f"Saved to {path} (upload skipped)")
        return

    try:
        upload_url, filename = request_upload_url(api_url, camera_id)
        print(f"Got upload URL for {filename}")
    except urllib.error.HTTPError as e:
        keep_on_failure(image_bytes)
        sys.exit(f"API returned {e.code}: {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        keep_on_failure(image_bytes)
        sys.exit(f"Could not reach the API: {e.reason}")
    except ValueError as e:
        keep_on_failure(image_bytes)
        sys.exit(str(e))

    try:
        status = upload_image(upload_url, image_bytes)
        print(f"[{status}] uploaded to s3://{filename}")
    except urllib.error.HTTPError as e:
        keep_on_failure(image_bytes)
        sys.exit(f"S3 rejected the upload ({e.code}): {e.read().decode(errors='replace')}")
    except urllib.error.URLError as e:
        keep_on_failure(image_bytes)
        sys.exit(f"Upload failed: {e.reason}")

    if args.keep_local:
        print(f"Local copy: {save_local_copy(image_bytes)}")


def keep_on_failure(image_bytes):
    """Don't lose the image if AWS is unreachable."""
    try:
        print(f"Kept a local copy at {save_local_copy(image_bytes)}")
    except Exception as e:
        print(f"Could not save a local copy either: {e}")


if __name__ == "__main__":
    main()
