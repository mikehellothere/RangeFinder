"""
Returns a presigned S3 PUT URL so a camera unit can upload an image directly.

The camera never holds AWS credentials. It POSTs here, gets a short-lived URL,
and PUTs the JPEG straight to S3.
"""

import json
import logging
import re
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(logging.INFO)

REGION = "eu-west-2"
BUCKET_NAME = "rangefinder-trail-camera-340482406491-eu-west-2-an"   # <-- your new bucket name
URL_EXPIRY_SECONDS = 300                             # the Pi uploads immediately
VALID_CAMERA_ID = re.compile(r"^[a-zA-Z0-9-]{1,32}$")

s3 = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(
        signature_version="s3v4",
        s3={"addressing_style": "virtual"},
    ),
)


def response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Access-Control-Allow-Origin": "*",
            "Content-Type": "application/json",
        },
        "body": json.dumps(body),
    }


def lambda_handler(event, context):
    try:
        # body can be None when the request has no payload
        body = json.loads(event.get("body") or "{}")
        metadata = body.get("metadata", {})

        camera_id = str(metadata.get("camera_id", "unknown"))
        if not VALID_CAMERA_ID.match(camera_id):
            return response(400, {"error": "invalid camera_id"})

        timestamp = datetime.now(timezone.utc)
        date_path = timestamp.strftime("%Y/%m/%d/%H")
        filename = f"{camera_id}/{date_path}/{uuid.uuid4()}.jpg"

        presigned_url = s3.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": BUCKET_NAME,
                "Key": filename,
                "ContentType": "image/jpeg",
            },
            ExpiresIn=URL_EXPIRY_SECONDS,
        )

        logger.info("Issued upload URL for %s", filename)

        return response(200, {
            "upload_url": presigned_url,
            "filename": filename,
            "expires_in": URL_EXPIRY_SECONDS,
        })

    except json.JSONDecodeError:
        return response(400, {"error": "body was not valid JSON"})
    except Exception:
        # Full detail goes to CloudWatch, the caller gets a generic message
        logger.exception("Failed to generate upload URL")
        return response(500, {"error": "internal error"})
