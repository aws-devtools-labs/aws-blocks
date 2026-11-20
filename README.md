# AWS CDK Blocks

[![npm version](https://img.shields.io/npm/v/aws-cdk-blocks?color=brightgreen&label=npm%20package)](https://www.npmjs.com/package/aws-cdk-blocks)[![weekly downloads](https://img.shields.io/npm/dw/aws-cdk-blocks)](https://www.npmjs.com/package/aws-cdk-blocks)[![build status](https://img.shields.io/github/actions/workflow/status/aws/cdk-blocks/publish-packages.yml)](https://github.com/aws/cdk-blocks/blob/main/.github/workflows/publish-packages.yml)

AWS CDK Blocks is an open-source expansion of [AWS Cloud Development Kit (AWS CDK)](https://aws.amazon.com/cdk/). Each CDK Block packages a construct, an interface, and the interface's AWS and local implementations. AWS best practices are built in. More than 17 Blocks cover background jobs, realtime, SQL and NoSQL databases, authentication, file storage, and AI agents. Build and test your whole app locally, then deploy the same code to your own AWS account. Every resource is CDK that you can audit and change. AWS maintains each CDK Block's best practices through versioned releases. Platform teams can package their own standards as custom CDK Blocks.

A CDK construct defines and provisions AWS infrastructure. A Block packages one application capability in three parts:

- The infrastructure, as CDK constructs.
- The application code that connects your app to the infrastructure.
- A local implementation.

Select the CDK Blocks your app needs and compose them. Your app runs locally without an AWS account. When you are ready, deploy the same code to your own AWS account. The deployment provisions the AWS infrastructure, and each Block follows AWS best practices.

Platform teams can package their own standards as custom CDK Blocks and share them through npm. To create a custom CDK Block, see [`create-block`](./packages/create-block/README.md).

For an overview, see the [AWS CDK Blocks Developer Guide](https://docs.aws.amazon.com/blocks/latest/devguide/what-is-blocks.html). For the Block catalog and APIs at this revision, see the [Blocks README](./packages/blocks/README.md).

## Getting started

You must have [Node.js](https://nodejs.org/) 22 or later and npm 10 or later.

```bash
npm create @aws-cdk-blocks/blocks-app@latest my-app
cd my-app
npm run dev
```

The first command creates the app and installs its dependencies. `npm run dev` starts a local development server at `http://localhost:3000`. Each Block runs its local implementation, so you do not need an AWS account or credentials.

Define your backend in `cdk-blocks/index.ts` and your frontend in `src/`. Your frontend imports your backend and gets its types directly from the TypeScript source. You do not run a code generation step.

- **Documentation in your app:** `npm run docs` lists the Blocks. `npm run docs KVStore` shows the guide for one Block. `npm run help` lists the tasks.
- **Templates:** To start from a different template, add `-- --template <name>` to the `npm create` command. To see the templates, run `npx @aws-cdk-blocks/create-blocks-app --help`. The `auth` template was formerly named `auth-cognito`, and the old name still works.
- **Existing projects:** To add a `cdk-blocks/` backend to an existing project, run the `npm create` command in the project directory. Omit the directory name, or use `.`. If the project is an AWS Amplify Gen 2 project, the CLI finds it and integrates with it.

For the full procedure, see the [Getting started guide](https://docs.aws.amazon.com/blocks/latest/devguide/getting-started.html).

## How it works

AWS CDK Blocks uses Node.js conditional exports to load different code for each context:

- **Local development:** Your app runs on your machine. Each CDK Block runs its local implementation and keeps its data in memory or in local files.
- **CDK synthesis:** Each CDK Block packages CDK constructs. The AWS CDK synthesizes an AWS CloudFormation template from them.
- **AWS runtime:** Your app runs on AWS. Each Block calls AWS services through the AWS SDK.

For example, the line `new KVStore(scope, 'todos')` is a local store in development. At deployment, it becomes an Amazon DynamoDB table. In production, it makes SDK calls to that table. You do not change the code.

## Blocks

Each CDK Block is an npm package. The umbrella package [`aws-cdk-blocks`](https://www.npmjs.com/package/aws-cdk-blocks) re-exports every CDK Block and the core runtime.

| Category | Blocks |
| --- | --- |
| Data and storage | `KVStore`, `Database`, `FileBucket` |
| Authentication | `Auth` (email and password, social sign-in, OIDC, and SAML in one Block) |
| Compute and background jobs | `Compute`, `AsyncJob`, `CronJob` |
| AI | `Agent`, `KnowledgeBase` |
| Communication | `Realtime`, `EmailClient` |
| Configuration | `AppSetting`, `Secret` |
| Observability | `Logger`, `Metrics`, `Tracer`, `Dashboard` |
| Hosting | `Hosting` |

## Supported platforms

Type safety extends from your backend to your client on these platforms:

- **Web frameworks:** Next.js, Nuxt, Astro, React, Vue, Svelte, and Angular.
- **Native mobile:** Swift, Kotlin, and Dart (Flutter).
- **Desktop:** Kotlin, Swift, and Dart (Flutter).

Each native client has two parts. At build time, a code generator makes type-safe client code from your Blocks spec (`blocks.spec.json`). At run time, a library calls your backend over JSON-RPC.

- **[Kotlin](./native/kotlin/README.md):** Kotlin Multiplatform (Android, iOS, and JVM). A Gradle plugin and a Kotlin Multiplatform runtime.
- **[Swift](./native/swift/README.md):** A Swift package (iOS and macOS). A SwiftPM build plugin and a Foundation-based runtime.
- **[Dart](./native/dart/README.md):** Dart and Flutter. A code generator and runtime packages.

## Repository layout

```
cdk-blocks/
├── packages/    # Blocks, the core runtime, and the create-blocks-app CLI (published to npm)
├── native/      # Native client SDKs (Kotlin, Swift, Dart)
├── test-apps/   # Example apps and end-to-end tests
├── test-infra/  # Persistent CI infrastructure (test VPCs, GitHub OIDC roles)
├── tasks/       # Agent benchmark tasks
├── docs/        # Contributor guides, design documents, and decisions
└── scripts/     # Repository tooling and automation
```

## Building from source

You must have Node.js 22 or later and npm 10 or later.

```bash
npm install
npm run build
npm test
```

## Contributing

To report a bug or send a pull request, see [CONTRIBUTING.md](./CONTRIBUTING.md). Coding agents start with [AGENTS.md](./AGENTS.md).

## License

[Apache-2.0](./LICENSE)
