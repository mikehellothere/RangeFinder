

"""
Classify image lambda euw2 · PY

Triggered when an image lands in the trail camera S3 bucket.
 
Bucket and Rekognition are both in eu-west-2, so Rekognition reads the object
directly from S3. No download into the function, and no 5 MB byte limit.
 
Results are logged to CloudWatch only. Sending them onwards to the web app
comes later.
"""

 
import json
import logging
import urllib.parse
 
import boto3
 
logger = logging.getLogger()
logger.setLevel(logging.INFO)
 
MAX_LABELS = 15
MIN_CONFIDENCE = 55.0          # percent, Rekognition uses 0-100 not 0-1
 
rekognition = boto3.client("rekognition")
 
 
def lambda_handler(event, context):
    results = []
 
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        # Keys arrive URL-encoded, so "cam 1/x.jpg" comes through as "cam+1/x.jpg"
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
 
        logger.info("Processing s3://%s/%s", bucket, key)
 
        try:
            rek_response = rekognition.detect_labels(
                Image={"S3Object": {"Bucket": bucket, "Name": key}},
                MaxLabels=MAX_LABELS,
                MinConfidence=MIN_CONFIDENCE,
            )
        except Exception:
            logger.exception("Rekognition failed on %s", key)
            continue
 
        labels = [
            {
                "name": label["Name"],
                "confidence": round(label["Confidence"], 1),
                "parents": [p["Name"] for p in label.get("Parents", [])],
                "instances": len(label.get("Instances", [])),
            }
            for label in rek_response.get("Labels", [])
        ]
 
        # camera_id is the first part of the key: cam-1/2026/09/26/16/<uuid>.jpg
        camera_id = key.split("/")[0] if "/" in key else "unknown"
 
        detection = {
            "cameraId": camera_id,
            "s3Key": key,
            "labels": labels,
        }
 
        logger.info("Detection: %s", json.dumps(detection))
        results.append(detection)
 
    return {"processed": len(results), "detections": results}
 

