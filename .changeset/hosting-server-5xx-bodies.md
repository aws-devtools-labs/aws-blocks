---
"@aws-cdk-blocks/hosting": patch
---

The CloudFront door no longer replaces the 500 and 503 responses of an app's server with the built-in "Service Temporarily Unavailable" page, so an API route's JSON error and the framework's own error page reach the client with their status. The built-in page now answers only the 502 and 504 responses CloudFront generates when the server function fails or times out. `errorPages.serverError` still maps 500 to the app's page. None of these responses are cached.
