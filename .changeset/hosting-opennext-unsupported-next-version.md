---
"@aws-blocks/hosting": patch
---

fix(hosting): don't hard-fail a Next.js deploy the day its major ages out of OpenNext's support window

`@opennextjs/aws` refuses to build a Next.js major that has passed the Next.js team's 2-year support window: it prints `Next.js version X is not supported by the Next.js team` and exits 1 unless invoked with `--dangerously-use-unsupported-next-version`. Because that window is a wall-clock deadline, a Next.js SSR deploy that worked yesterday would start hard-failing the day the major expires — with no change on the user's side (e.g. Next 15 aged out on 2026-10-21).

The Next.js adapter now detects when the installed Next major is outside OpenNext's support window (mirroring OpenNext's own release-date table) and passes `--dangerously-use-unsupported-next-version` automatically, surfacing a stderr warning that advises upgrading to a supported Next.js major. The deployed app still runs — the policy is about upstream security patches, not runtime compatibility — so the deploy proceeds instead of breaking on a date. When the Next version can't be read, the flag is omitted and OpenNext's own check decides.
