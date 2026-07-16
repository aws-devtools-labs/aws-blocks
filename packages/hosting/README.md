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
```

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
