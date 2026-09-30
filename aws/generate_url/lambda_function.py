import json
import boto3
from botocore.config import Config
from datetime import datetime, timezone
import uuid

s3 = boto3.client(
    's3',
    region_name='eu-north-1',
    config=Config(
        signature_version='s3v4',
        s3={'addressing_style': 'virtual'},
    ),
)

BUCKET_NAME = 'your-trail-camera-bucket'

def lambda_handler(event, context):
    try:
        body = json.loads(event.get('body', '{}'))
        metadata = body.get('metadata', {})

        timestamp = datetime.now(timezone.utc)
        camera_id = metadata.get('camera_id', 'unknown')
        date_path = timestamp.strftime('%Y/%m/%d/%H')
        filename = f"{camera_id}/{date_path}/{uuid.uuid4()}.jpg"

        presigned_url = s3.generate_presigned_url(
            'put_object',
            Params={
                'Bucket': BUCKET_NAME,
                'Key': filename,
                'ContentType': 'image/jpeg',
            },
            ExpiresIn=3600,
        )

        return {
            'statusCode': 200,
            'headers': {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json',
            },
            'body': json.dumps({
                'upload_url': presigned_url,
                'filename': filename,
                'expires_in': 3600,
            }),
        }

    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)}),
        }