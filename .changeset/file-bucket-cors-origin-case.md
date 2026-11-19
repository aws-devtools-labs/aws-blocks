---
"@aws-cdk-blocks/bb-file-bucket": patch
"@aws-cdk-blocks/hosting": patch
---

`FileBucket` writes its `corsRules` origins in lower case, the case a browser sends in its `Origin` header. An ALB door's `HostingUrl` keeps the capitals of the load balancer's DNS name, and S3 compares `AllowedOrigin` case-sensitively, so a bucket CORS rule with that URL copied from `HostingUrl`, as the FileBucket README says to, blocked every upload and download from the page. The Hosting README now says the ALB URL keeps its capitals.
