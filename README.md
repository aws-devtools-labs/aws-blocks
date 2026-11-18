# AWS CDK Blocks

[![npm version](https://img.shields.io/npm/v/aws-cdk-blocks?color=brightgreen&label=npm%20package)](https://www.npmjs.com/package/aws-cdk-blocks)[![weekly downloads](https://img.shields.io/npm/dw/aws-cdk-blocks)](https://www.npmjs.com/package/aws-cdk-blocks)[![build status](https://img.shields.io/github/actions/workflow/status/aws-devtools-labs/aws-blocks/publish-packages.yml)](https://github.com/aws-devtools-labs/aws-blocks/blob/main/.github/workflows/publish-packages.yml)

AWS Blocks is a backend toolkit for building full-stack applications on AWS. Each Block is a self-contained backend capability that bundles your application code, a local development setup, and the infrastructure to run it. Pick the Blocks you need and compose them; AWS Blocks generates the AWS infrastructure (CDK constructs) for them. Your entire application runs locally without an AWS account — when you're ready, deploy the same code to AWS without changing it.

Documentation: [AWS Blocks Developer Guide](https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html), with the full Block catalog and the API reference of each Block.

## Getting started

Requires [Node.js](https://nodejs.org/) 22 or later and npm 10 or later.

```bash
npm create @aws-cdk-blocks/blocks-app@latest my-app
cd my-app
npm install
npm run dev
```

`npm run dev` starts a local development server at `http://localhost:3000` with every Block running a local implementation. Define your backend in `aws-blocks/index.ts` and your frontend in `src/`; types flow end to end with no code generation step.

- In the installed app, `npm run docs` lists Building Blocks, `npm run docs KVStore` opens a block’s guide, and `npm run help` lists tasks.
- Start from a specific template with `--template <name>`. `npx @aws-blocks/create-blocks-app --help` lists the templates and describes each.
- Run the command inside an existing project (omit the directory, or pass `.`) to add an `aws-blocks/` backend to it. The CLI auto-detects an AWS Amplify Gen 2 project and integrates with it.

For a full walkthrough, see [Getting started with AWS CDK Blocks](https://docs.aws.amazon.com/blocks/latest/devguide/getting-started.html).

## How it works

AWS CDK Blocks uses Node.js conditional exports to load different code for each context:

- **Local development** — Blocks use in-memory and filesystem storage; your app runs on your machine.
- **CDK synthesis** — Blocks produce CDK constructs, and AWS CDK Blocks generates a CloudFormation template.
- **AWS Lambda runtime** — Blocks call AWS services through the SDK.

The same `new KVStore(scope, 'todos')` line becomes a local store in development, an Amazon DynamoDB table at deploy time, and SDK calls in production.

## Blocks

Each Block is published as an npm package, and the umbrella package [`@aws-blocks/blocks`](https://www.npmjs.com/package/@aws-blocks/blocks) re-exports every Block plus the core runtime.

| Category | Blocks |
| --- | --- |
| Data & storage | `KVStore`, `Database`, `FileBucket` |
| Authentication | `Auth` (email + password, social, OIDC and SAML in one block) |
| Compute & background | `Compute`, `AsyncJob`, `CronJob` |
| AI | `Agent`, `KnowledgeBase` |
| Communication | `Realtime`, `EmailClient` |
| Configuration | `AppSetting`, `Secret` |
| Observability | `Logger`, `Metrics`, `Tracer`, `Dashboard` |
| Hosting | `Hosting` |

## Supported platforms

Clients are typed from your backend: web frameworks (Next.js, Nuxt, Astro, React, Vue, Svelte, Angular), native mobile (Swift, Kotlin, Dart/Flutter), and desktop applications.

Native clients are build-time code generators that produce type-safe client code from a Blocks spec (`blocks.spec.json`), paired with a runtime library that calls your backend over JSON-RPC:

- **[kotlin](./native/kotlin/README.md)** — Kotlin Multiplatform (Android, iOS, JVM). Gradle plugin + KMP runtime.
- **[swift](./native/swift/README.md)** — Swift Package (iOS, macOS). SwiftPM build plugin + Foundation-based runtime.
- **[dart](./native/dart/README.md)** — Dart / Flutter client. Generates a typed Dart client from your Blocks spec.

## Repository layout

```
aws-blocks/
├── packages/    # Blocks, the core runtime, and the create-blocks-app CLI (published to npm)
├── native/      # Native client SDKs (Kotlin, Swift, Dart)
├── test-apps/   # Example applications and end-to-end tests
├── test-infra/  # Persistent CI infrastructure (test VPCs, GitHub OIDC roles)
├── tasks/       # Agent benchmark tasks
├── docs/        # Contributor guides, design documents, and decisions
└── scripts/     # Repository tooling and automation
```

## Building from source

```bash
npm install
npm run build
npm test
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to report issues and send pull requests. Coding agents start with [AGENTS.md](./AGENTS.md).

## License

Apache-2.0
