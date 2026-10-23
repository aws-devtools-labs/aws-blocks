---
"@aws-blocks/hosting": patch
---

fix(hosting): don't hard-fail a Next.js deploy the day its major ages out of OpenNext's support window

`@opennextjs/aws` refuses to build a Next.js major that has passed the Next.js team's 2-year support window: it prints `Next.js version X is not supported by the Next.js team` and calls `process.exit(1)` unless invoked with `--dangerously-use-unsupported-next-version`. Because that window is a wall-clock deadline, a Next.js SSR deploy that worked yesterday would start hard-failing the day the major expires — with no change on the user's side (e.g. Next 15 aged out on 2026-10-21).

The Next.js adapter now passes `--dangerously-use-unsupported-next-version` to the OpenNext build unconditionally. The flag is inert on a supported version — OpenNext reads it only inside its `if (!isSupported)` branch — and on an aged-out major it downgrades the hard `exit(1)` to a warning and continues. The deployed app still runs; the support policy is about upstream security patches, not runtime compatibility. OpenNext's own `isNextVersionSupported` remains the single source of truth for the supported/unsupported decision, so nothing in this package needs to track Next.js release dates.
