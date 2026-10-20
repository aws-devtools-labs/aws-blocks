---
"@aws-blocks/bb-file-bucket": patch
"@aws-blocks/blocks": patch
---

docs(bb-file-bucket): document that `corsRules` is required for browser uploads and downloads

Browser uploads and downloads that worked under `npm run dev` failed after
deploying to a sandbox or production stack with `No 'Access-Control-Allow-Origin'
header is present on the requested resource`, and nothing in the docs explained
why. The local dev file-server accepts any origin, but the deployed S3 bucket has
no CORS configuration unless `corsRules` is set — and it does not inherit the
stack's `defaults.allowedOrigins` or the Hosting domain.

- **bb-file-bucket README** — new "Browser Uploads and Downloads (CORS)" section
  with the failing error, a working `corsRules` example (`GET`/`PUT`,
  `allowedHeaders: ['Content-Type']`), how to find the deployed Hosting origin
  (`HostingUrl`), and notes on preflight headers, S3 origin syntax, the scope of
  the wildcard synth guard, which requests need CORS, and wrapped buckets. The
  `corsRules` option row, Best Practices, and Local Development sections now
  point to it.
- **bb-file-bucket TSDoc / DESIGN.md** — `corsRules` documents its no-CORS
  default, that it is ignored for wrapped buckets, and (new D-FB-15) why it is
  not derived from `defaults.allowedOrigins` or the Hosting domain.
- **blocks README** — the Security Considerations list notes that
  `defaults.allowedOrigins` covers the API only and FileBucket needs its own
  `corsRules`.

Documentation only — no runtime or API change.
