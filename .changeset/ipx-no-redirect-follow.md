---
"@aws-blocks/hosting": patch
"@aws-blocks/blocks": patch
---

fix(hosting): the image-optimization Lambda no longer follows redirects on remote image fetches

The IPX image Lambda validated a remote image URL against the allowlist
(`IMAGE_ALLOWED_HOSTNAMES` / `remotePatterns`) once, before fetching — and the
fetch then followed HTTP redirects without re-validating the target. An allowlisted
host with an open redirect (a user-content CDN, say) could therefore steer the fetch
to any host, including `127.0.0.1` inside the Lambda sandbox.

Remote fetches now use `fetchOptions: { redirect: 'error' }`, so a 3xx fails the
image request instead of being followed, and the allowlist holds for every request
the Lambda makes. **If an allowlisted image host serves its images through a redirect,
allowlist the final location instead.** The generated Lambda also pins `ipx` to an
exact version (`3.1.1`) rather than `^3.0.0`, so the fetch behavior this guard relies
on can't change at deploy time.
