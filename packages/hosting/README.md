# @aws-blocks/hosting

Low-level CDK L3 constructs for deploying web applications on AWS
(CloudFront, S3, Lambda, WAF, monitoring, DNS).

## Overview

This package provides:

1. **`HostingConstruct`** -- a CDK L3 construct that provisions a full hosting
   stack (CloudFront distribution, S3 origin, Lambda compute, optional WAF,
   monitoring dashboards, and DNS records).

2. **Framework adapters** (Next.js, Nuxt, Astro, SPA) that run the framework
   build, produce a `DeployManifest`, and hand off to the construct for
   provisioning.

3. **Manifest types** (`DeployManifest`, `RouteBehavior`, `ComputeResource`,
   etc.) that describe the shape of a deployment.

## When to use this package directly

Most users should use `Hosting` from `@aws-blocks/core`, which wraps these
constructs with the AWS Blocks integration layer (route registry, config.json
generation, RPC prefix wiring).

Use `HostingConstruct` directly when you need:

- A standalone CDK app without the AWS Blocks layer
- Fine-grained control over construct props
- Custom adapters or manifest generation pipelines

## Main exports

```ts
// Root entry point
import {
  HostingConstruct,
  HostingConstructProps,
  HostingDomainConfig,
  HostingWafConfig,
  generateBuildId,
  DeployManifest,
  RouteBehavior,
  ComputeResource,
  FrameworkAdapterFn,
  HostingError,
} from '@aws-blocks/hosting';

// Sub-path: construct only
import { HostingConstruct } from '@aws-blocks/hosting/constructs';

// Sub-path: adapters only
import { nextjsAdapter, nuxtAdapter, astroAdapter, spaAdapter } from '@aws-blocks/hosting/adapters';

// Sub-path: typed errors
import { HostingError } from '@aws-blocks/hosting/error';

// Sub-path: secrets & config (CDK-free — safe to import in SSR/runtime code)
import { secret, config, getSecret, getConfig } from '@aws-blocks/hosting/secret';
```

## Secrets & config

Keep sensitive and environment-specific values out of source. You declare a value
by **which function you call** — that choice picks the store, and the framework
owns everything else (the CLI write, the IAM grant, the runtime read):

| Declare (infra) | Store | Read (runtime) |
| --- | --- | --- |
| `secret('KEY')` | AWS **Secrets Manager** (sensitive) | `getSecret('KEY')` |
| `config('KEY')` | AWS **SSM Parameter Store** (non-sensitive, free tier) | `getConfig('KEY')` |

### Declare — in your hosting infra

```ts
import { HostingConstruct } from '@aws-blocks/hosting';
import { secret, config } from '@aws-blocks/hosting/secret';

new HostingConstruct(stack, 'Web', {
  // …framework, root, api…
  environment: {
    STRIPE_KEY: secret('STRIPE_KEY'), // → Secrets Manager
    FEATURE_FLAGS: config('FEATURE_FLAGS'), // → SSM Parameter Store
  },
  // Optional per-kind namespace / cache config:
  secretStore: { prefix: '/myapp/secrets', cacheTtlSeconds: 0 },
  configStore: { prefix: '/myapp/config', cacheTtlSeconds: 30 },
});
```

The marker is inert (`{ key, kind }`) and safe to commit — only the store
*locator* is injected (never the value), and the compute role is granted
least-privilege read on that one resource (`secretsmanager:GetSecretValue` /
`ssm:GetParameter`, scoped to the exact ARN) plus `kms:Decrypt`.

Markers in `environment` are wired for **runtime** resolution (above), so both
`secret()` and `config()` are allowed there (only the locator is injected, never
the value). Resolving a marker to a literal at **synth time** — e.g. for
`domain.domainName`, which must be a literal before CloudFront/ACM are built —
**inlines the value into the CloudFormation template**, so those positions accept
only `config()` (non-sensitive → SSM) or a plain string, never `secret()`. Synth
resolution needs an async wrapper that does the SDK read during construction; that
path is provided by the Blocks `Hosting` block (`await Hosting.create(...)`), not
this leaf construct, whose `domain.domainName` is a plain `string | string[]`.

**Bring your own:** `environment` also accepts an existing CDK `ISecret` /
`IParameter` handle — the construct grants read via the handle and injects its
locator, so `getSecret` / `getConfig` resolve it identically (managed
*provisions*, BYO *references*).

### Read — in your SSR / API / runtime code

```ts
// Import from the CDK-free subpath so no CDK is pulled into the runtime bundle:
import { getSecret, getConfig } from '@aws-blocks/hosting/secret';

const key = await getSecret('STRIPE_KEY'); // Secrets Manager
const flags = await getConfig('FEATURE_FLAGS'); // SSM
```

Each getter reads `process.env.KEY` first, so **local dev needs no AWS** — put
the value in a `.env` file. On a deployed function it fetches + decrypts from its
store and caches per cold start (or per `cacheTtlSeconds`, for rotation without a
redeploy).

### Set the values (out of band, never in git)

Standalone hosting apps get two bundled CLIs:

```bash
# Secrets Manager — a secret value is NEVER taken from argv (it would land in
# shell history). Omit the value for a hidden prompt, or pipe it via --value-stdin:
npx hosting-secret set STRIPE_KEY --prefix /myapp/secrets --region us-east-1   # hidden prompt
cat key.txt | npx hosting-secret set STRIPE_KEY --value-stdin --prefix /myapp/secrets
npx hosting-secret list --prefix /myapp/secrets
npx hosting-secret remove STRIPE_KEY --prefix /myapp/secrets

# SSM Parameter Store — a config value is non-sensitive, so a positional value is fine:
npx hosting-config set FEATURE_FLAGS '{"beta":true}' --prefix /myapp/config
```

`set` is **create-or-update**: the first call creates the entry, and running it
again overwrites the value in place (no error, no prompt) — that is how you
rotate a value. A **secret** value is never read from `argv` / shell history:
`hosting-secret set` takes it from a **hidden prompt** or `--value-stdin`, and
passing it positionally is a hard error. A **config** value is non-sensitive, so
`hosting-config set KEY value` positionally is allowed (`--value-stdin` / the
prompt still work). `list` prints names only, never values.

`remove` on a **secret** is recoverable by default — the value enters Secrets
Manager's recovery window and can be restored (guards against a typo'd prod key).
Pass `--force` to delete immediately with no recovery. (`config` removes are always
immediate — SSM Parameter Store has no recovery window.)

> **Footguns to know.**
> 1. **Region.** `--region` (or `AWS_REGION`) must match the region the app deploys
>    to, or the deploy reports the value as "not set".
> 2. **Account-global prefix.** The default prefixes (`/hosting/secrets`,
>    `/hosting/config`) are account-global — if more than one app deploys to the
>    same account, give each its own `secretStore.prefix` / `configStore.prefix`
>    (and matching CLI `--prefix`), or their same-named values collide.
> 3. **`stage` is not a security boundary.** An optional `stage` on
>    `secretStore` / `configStore` resolves `<prefix>/<stage>/<key>` and falls
>    back to the shared `<prefix>/<key>`. To make that fallback work the IAM grant
>    is *static*, so a stage's compute has standing read on **both** the stage
>    value and the shared one. Every stage sharing a prefix can read the shared
>    value — put production-only secrets in a stage-scoped slot and keep only a
>    safe cross-stage default (e.g. a sandbox credential) in the shared slot. Two
>    constructs sharing a prefix are not isolated from each other.

## Architecture

```
┌──────────────────────────────────────────────┐
│  Framework Adapter (nextjs / nuxt / astro)   │
│  - runs build                                │
│  - emits DeployManifest                      │
└──────────────────┬───────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────┐
│  HostingConstruct (CDK L3)                   │
│  - CloudFront distribution                   │
│  - S3 origin (static assets)                 │
│  - Lambda compute (SSR / API / middleware)   │
│  - Optional: WAF, DNS, monitoring, warmup    │
└──────────────────────────────────────────────┘
```

## Custom domains

Configure a custom domain through the `domain` prop on `HostingConstruct`
(`HostingDomainConfig`). CloudFront only accepts ACM certificates in
**us-east-1**, so every certificate, whether auto-provisioned or
bring-your-own, must live in us-east-1. There are two paths, depending on where
you manage DNS.

### Route 53 (automatic)

Provide `hostedZone` (the zone domain name) or `hostedZoneId`. The construct
provisions a DNS-validated ACM certificate and creates the A and AAAA alias
records for you. Validation is automatic when the hosted zone is in the same
account as the deployment, because the construct writes the ACM validation
records into the zone itself.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  domain: {
    domainName: 'app.example.com',
    hostedZone: 'example.com', // a Route 53 zone you control
  },
});
```

Use `hostedZoneId` to skip `HostedZone.fromLookup()`, which otherwise requires
`env: { account, region }` on the stack. This is useful in pipeline stages:

```ts
domain: {
  domainName: 'app.example.com',
  hostedZone: 'example.com',
  hostedZoneId: 'Z0123456789ABCDEFGHIJ',
}
```

### Bring your own DNS (manual)

If you manage DNS elsewhere (your registrar, Cloudflare, or another provider),
omit `hostedZone` and `hostedZoneId` and pass a pre-validated `certificate`, an
ACM certificate in us-east-1. The construct creates no DNS records. Instead it
emits the CloudFront distribution domain as a `DistributionDomainName`
CloudFormation output, so you can point a CNAME at it from your own DNS
provider.

```ts
new HostingConstruct(stack, 'Hosting', {
  manifest,
  domain: {
    domainName: 'app.example.com',
    // no hostedZone: you manage DNS externally
    certificate: myPreValidatedCert, // ACM cert in us-east-1, pre-validated
  },
});
```

### Error behavior

Omitting both `hostedZone` / `hostedZoneId` and `certificate` throws
`MissingCertificateError` at synth time. Synthesis fails immediately, so the
deploy never starts and there is no 72-hour CloudFormation wait on an
unvalidated certificate. A bring-your-own certificate outside us-east-1 fails
synthesis with `InvalidCertificateRegionError`.

### Two-phase workflow for external DNS

A certificate must be validated before CloudFront will serve the domain, and
the CloudFront domain is only known after deploy. Set up external DNS in two
phases around the deploy:

1. **Before deploy:** request an ACM certificate in **us-east-1** for your
   domain and validate it (add the ACM validation CNAME to your DNS, or use
   email validation). Wait until the certificate status is **Issued**.
2. **Deploy:** deploy the stack with `domain: { domainName, certificate }`. The
   stack emits the `DistributionDomainName` output (for example
   `d1234abcd.cloudfront.net`).
3. **After deploy:** in your DNS provider, create a CNAME from your domain
   (`app.example.com`) to the `DistributionDomainName` value. For an apex
   domain, use an ALIAS or ANAME record if your provider supports it.

## Development

```bash
npm run build        # compile TypeScript
npm test             # run tests (node --test)
```

## License

Apache-2.0
