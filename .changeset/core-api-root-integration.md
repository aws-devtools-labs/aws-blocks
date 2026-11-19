---
"@aws-blocks/core": patch
---

The backend REST API's root path (`/` on the stage URL) now reaches the backend function, which answers `404 {"error":"Not Found"}` like any other unknown path. It used to answer `500 {"message": "Internal server error"}`: the root method had a mock integration without a request template.
