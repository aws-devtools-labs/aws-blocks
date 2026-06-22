# AWS Blocks (Preview)

[![npm version](https://img.shields.io/npm/v/@aws-blocks/blocks?color=brightgreen&label=npm%20package)](https://www.npmjs.com/package/@aws-blocks/blocks)[![weekly downloads](https://img.shields.io/npm/dw/@aws-blocks/blocks)](https://www.npmjs.com/package/@aws-blocks/blocks)[![build status](https://img.shields.io/github/actions/workflow/status/aws-devtools-labs/aws-blocks/publish-packages.yml)](https://github.com/aws-devtools-labs/aws-blocks/blob/main/.github/workflows/publish-packages.yml)

AWS Blocks is a backend toolkit for building full-stack applications on AWS. Each Block is a self-contained backend capability that bundles your application code, a local development setup, and the infrastructure to run it. Pick the Blocks you need, compose them, and AWS Blocks defines the AWS infrastructure for you following AWS best practices. Your entire application runs locally without an AWS account — when you're ready, deploy the same code to AWS without changing it.

> 📚 **Documentation:** [AWS Blocks Developer Guide](https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html)

## Getting started

Requires [Node.js](https://nodejs.org/) 22 or later and npm 10 or later.

```bash
npm create @aws-blocks/blocks-app@latest my-app
cd my-app
npm install
npm run dev
```

`npm run dev` starts a local development server at `http://localhost:3000` with every Block running a local implementation — no AWS account or credentials required. Define your backend in `aws-blocks/index.ts` and your frontend in `src/`; types flow end to end with no code generation step.

- Start from a specific template with `--template <name>`. Available templates: `default`, `nextjs`, `react`, `auth-cognito`, `demo`, `bare`, `backend`, `amplify`.
- Run the command inside an existing project (omit the directory, or pass `.`) to add an `aws-blocks/` backend to it. The CLI auto-detects an AWS Amplify Gen 2 project and integrates with it.

For a full walkthrough, see [Getting started with AWS Blocks](https://docs.aws.amazon.com/blocks/latest/devguide/getting-started.html).

## How it works

AWS Blocks uses Node.js conditional exports to load different code for each context:

- **Local development** — Blocks use in-memory and filesystem storage; your app runs on your machine.
- **CDK synthesis** — Blocks produce CDK constructs, and AWS Blocks generates a CloudFormation template.
- **AWS Lambda runtime** — Blocks call AWS services through the SDK.

The same `new KVStore(scope, 'todos')` line becomes a local store in development, an Amazon DynamoDB table at deploy time, and SDK calls in production — with no code changes.

## Blocks

A Block is a module that gives you a complete feature: cloud resources, a runtime API, and a local implementation. Each Block is published as an npm package, and the umbrella package [`@aws-blocks/blocks`](https://www.npmjs.com/package/@aws-blocks/blocks) re-exports every Block plus the core runtime.

| Category | Blocks |
| --- | --- |
| Data & storage | `KVStore`, `DistributedTable`, `Database`, `DistributedDatabase`, `FileBucket` |
| Authentication | `AuthBasic`, `AuthCognito`, `AuthOIDC` |
| Compute & background | `AsyncJob`, `CronJob` |
| AI | `Agent`, `KnowledgeBase` |
| Communication | `Realtime`, `EventBus`, `EmailClient` |
| Configuration | `AppSetting` |
| Observability | `Logger`, `Metrics`, `Tracer`, `Dashboard` |
| Hosting | `Hosting` |

For the full catalog and per-Block API reference, see the [AWS Blocks Developer Guide](https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html).

## Supported platforms

Type safety extends from your backend all the way to your client across web frameworks (Next.js, Nuxt, Astro, React, Vue, Svelte, Angular), native mobile (Swift, Kotlin, Dart/Flutter), and desktop applications.

Native clients are build-time code generators that produce type-safe client code from a Blocks spec (`blocks.spec.json`), paired with a runtime library that calls your backend over JSON-RPC:

- **[kotlin](./native/kotlin/README.md)** — Kotlin Multiplatform (Android, iOS, JVM). Gradle plugin + KMP runtime.
- **[swift](./native/swift/README.md)** — Swift Package (iOS, macOS). SwiftPM build plugin + Foundation-based runtime.
- **[dart](./native/dart/README.md)** — Dart / Flutter client. Generates a typed Dart client from your Blocks spec.

## Repository layout

```
blocks/
├── packages/   # Blocks, the core runtime, and the create-blocks-app CLI (published to npm)
├── native/     # Native client SDKs (Kotlin, Swift, Dart)
├── test-apps/  # Example applications and end-to-end tests
└── scripts/    # Repository tooling and automation
```

## Building from source

Requires Node.js 22 or later.

```bash
npm install
npm run build
npm test
```

## Contributing

Contributions, feedback, and questions are welcome.

## License

Apache-2.0
