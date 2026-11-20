---
"@aws-cdk-blocks/core": patch
---

The backend REST API's root path (`/` on the stage URL) now reaches the backend function, which answers `404 {"error":"Not Found"}` like any other unknown path. It used to answer `500 {"message": "Internal server error"}`: the root method had a mock integration without a request template.

The root path no longer matches a `/*` RawRoute. A `/*` wildcard used to match `/` with an empty capture, so with the root forwarded to the function (and under `npm run dev`), `GET /` would have run the catch-all handler. The root now answers `404 {"error":"Not Found"}` whichever routes are registered, and `/*` still matches every other path.
