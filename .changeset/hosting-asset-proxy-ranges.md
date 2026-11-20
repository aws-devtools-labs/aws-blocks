---
'@aws-cdk-blocks/hosting': patch
---

The ALB and API Gateway doors' asset proxy now answers byte-range requests: a single `Range` (`bytes=0-9`, `bytes=500-`, `bytes=-500`) is read from S3 as that range and answered with `206 Partial Content` and `Content-Range` (never gzipped), a range past the end of the file with `416`, and every file response carries `Accept-Ranges: bytes`. Several ranges, a malformed range, or an `If-Range` that names another version of the file get the whole file (`200`). Video and audio seeking and resumable downloads of static files now work behind these doors, as on the CloudFront door.
