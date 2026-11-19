# create-blocks-app

Scaffolds a new AWS CDK Blocks app from a template, or adds an `cdk-blocks/` backend to an existing project.

## Usage

```bash
npx @aws-cdk-blocks/create-blocks-app [directory] [--template <name>] [--skip-install] [-y|--yes]
```

| Argument or option | Default | Meaning |
|---|---|---|
| `directory` | omitted | The target directory. Without it, the CLI checks the current directory for an existing app; in an empty directory it creates `blocks-demo-apps/template-<name>`. Pass `.` to scaffold in place. |
| `--template <name>` | `default` | For a new project, the starter app. For an existing project, the `cdk-blocks/` workspace to copy |
| `--skip-install` | | Skip installing dependencies |
| `-y`, `--yes` | | Skip confirmation prompts |
| `-h`, `--help` | | Print the usage and the templates with their one-line descriptions |

The CLI picks its mode from the target directory: an Amplify Gen 2 project (`amplify/backend.ts` exists), an existing project (`package.json` exists), or a new project.

### Create a New Project

```bash
npx @aws-cdk-blocks/create-blocks-app my-app
```

A target directory that contains only benign metadata (VCS/editor/OS files) or an `INSTRUCTIONS.md` is still treated as a fresh project; any other pre-existing file blocks scaffolding so nothing is overwritten.

### Start from Template

```bash
npx @aws-cdk-blocks/create-blocks-app my-app --template react
```

### Add to Existing Project

```bash
npx @aws-cdk-blocks/create-blocks-app .
```

- It lists the changes and asks `Proceed? (y/N)`. Pass `--yes` (or `-y`) to skip the question; without a terminal (CI, a script) the CLI can't ask it, so it exits with status 1 and changes nothing unless you pass `--yes`. The same applies to the Amplify Gen 2 integration below.
- The CLI writes `cdk-blocks/tsconfig.json`, a TypeScript project that checks the backend with Node types, and never edits your own `tsconfig`.
- To keep Node types out of your frontend, reference that project from the `tsconfig` that compiles the code importing `cdk-blocks`, and typecheck with `tsc -b --force`. The CLI prints the steps, and [Keep Node types out of the frontend](https://github.com/aws/cdk-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend) has them in full.
- In a Next.js project, it writes no `cdk-blocks/tsconfig.json`: `next build` ignores project references, so the app's `tsconfig.json` keeps checking `cdk-blocks/`.

In an npm workspaces monorepo, the app's `cdk-blocks/` folder has to be a workspace of the monorepo root too: npm installs the app's dependencies at the root and does not read the app's own `"workspaces": ["cdk-blocks"]`. When the app is a workspace of an enclosing root that does not list `<app>/cdk-blocks`, `create-blocks-app` stops before it writes anything and prints the `"workspaces"` entry to add; add it and run the command again.

It also adds to your `.gitignore` (or creates one): the AWS CDK Blocks build and local-data paths, secret and key-material patterns such as `.env` and `*.pem`, and `node_modules` unless a line such as `node_modules`, `node_modules/` or `/node_modules` already ignores it. A `.gitignore` that un-ignores it (`!node_modules`) is left as it is. Lines you already have are kept, and the CLI prints the ones it adds.

### Add Blocks to an Amplify Gen 2 Project

In an Amplify Gen 2 project (`amplify/backend.ts` exists), the same command integrates Blocks alongside it: it adds an `cdk-blocks/` workspace, wires auth via bearer tokens, and adds npm scripts for deployment. Your existing Amplify auth, data, and hosting stay untouched.

## What Gets Created

```
./
├── cdk-blocks/
│   ├── index.ts          # Backend entry point
│   ├── index.cdk.ts      # CDK stack definition
│   ├── index.handler.ts  # Lambda handler
│   ├── client.js         # Auto-generated frontend client
│   ├── package.json      # Backend workspace dependencies
│   └── tsconfig.json     # Backend TypeScript project (not in a Next.js app)
├── cdk.json              # CDK configuration
├── src/
│   └── ...               # Your existing code
└── package.json          # Updated with Blocks scripts and "blocks" CLI settings
```

### Package.json Scripts

Every Blocks task is an npm script that loads the app's installed `aws-cdk-blocks/run` entry. The dev server settings live in `package.json#blocks.dev`:

```json
{
  "scripts": {
    "dev": "node --input-type=module -e \"import 'aws-cdk-blocks/run'\" -- dev"
  },
  "blocks": {
    "dev": { "frontendPort": 3100 }
  }
}
```

Run `npm run help` for the task list or `npm run help sandbox destroy` for one task. What each task does, its output and exit codes, and the `blocks.dev` settings are in the [`aws-cdk-blocks` README](https://github.com/aws/cdk-blocks/tree/main/packages/blocks#package-scripts) (`npm run docs guide` in the app).

| Mode | Scripts added | `blocks.dev` |
|---|---|---|
| New app | The selected template's scripts | `{ "frontendPort": 3100 }` for frontend templates. `npm run dev` detects the frontend from the app's dependencies |
| New app from a backend-only template (`api-only`, `backend`, `cron`, `observability`, `sql`) | The selected template's scripts, without `sandbox:preview` | `{ "port": 3001, "frontend": false }`: `npm run dev` runs the backend only |
| Existing project | The template's Blocks tasks, such as `sandbox`, `sandbox:destroy`, `sandbox:console`, `deploy`, `destroy` and `dev:stop`, plus `dev:server` for the `dev` task | Only the template's `port` and `"frontend": false`, unless your `package.json` already has `blocks.dev`. A backend-only template in a Vite or Next.js project runs the backend only; any other template runs the project's own Vite or Next.js dev server |
| Amplify Gen 2 project | `blocks:dev` for the `dev` task, `blocks:stop`, and `blocks:generate-client`, which runs the overlay's own `cdk-blocks/scripts/generate-client.ts`: its client needs the Amplify auth middleware and the API URL from `amplify_outputs.json` | `{ "port": 3001, "frontend": false, "generateClient": false }`: the Amplify app runs its own frontend and keeps its own client |

In an existing project, the CLI preserves existing scripts and avoids their `pre` and `post` hooks. It tries `blocks:<name>` for a conflicting unprefixed name, then numbered variants if needed. Use the name printed by the CLI, or find the `aws-cdk-blocks/run` entry with the task's trailing command in `package.json`.

An app whose scripts run `aws-blocks/scripts/*.ts` wrappers: update `aws-cdk-blocks`, then run `node --input-type=module -e "import 'aws-cdk-blocks/run'" -- migrate` from the app root to switch its scripts to this form and delete the wrappers it generated. See [Migrating an existing app](https://github.com/aws/cdk-blocks/tree/main/packages/blocks#migrating-an-existing-app).

### `@aws-cdk-blocks/*` Dependency Versions

Every `@aws-cdk-blocks/*` package the CLI writes into your `package.json` (and into `cdk-blocks/package.json` for an Amplify Gen 2 project) gets a caret range on the release line this CLI version was tested with, for example:

```json
{
  "dependencies": {
    "aws-cdk-blocks": "^1.0.0-rc.0",
    "@aws-cdk-blocks/hosting": "^1.0.0-rc.0"
  }
}
```

- A reinstall stays on that release line and picks up later releases on it.
- Before 1.0, a new minor (`0.9.x` to `0.10.0`) is a new, breaking release line, and your app moves to it only when you edit the range.
- The CLI is released with every `aws-cdk-blocks` release, so the latest CLI starts a new app on the latest `aws-cdk-blocks` release.
- If you add AWS CDK Blocks to an existing project that already lists one of these packages in `dependencies`, your range is kept.
- For an Amplify Gen 2 project, `cdk-blocks/package.json` follows the root's range too (from `dependencies` or `devDependencies`) when it is a semver range; a `*`, path or protocol spec gets the stamp instead.
- An app that declares `"*"` for an `@aws-cdk-blocks/*` package can pull a breaking release on its next clean install. Replace each `"*"` with a caret range for the version you have installed (`npm ls aws-cdk-blocks` shows it), then run `npm install`.

## Templates

`npx @aws-cdk-blocks/create-blocks-app --help` lists the templates with their one-line descriptions. `--template auth-cognito` is an alias of `auth`.

The Vite templates (`default`, `bare`, `react`, `auth`, `auth-oidc`, `agent`, `demo`) typecheck the browser and the backend as separate [TypeScript projects](https://www.typescriptlang.org/docs/handbook/project-references.html): `tsconfig.app.json` checks `src/` with `"types": ["vite/client"]`, so a Node global there is an error, and `cdk-blocks/tsconfig.json` checks the backend with Node types. `nextjs` and the backend-only templates keep one `tsconfig.json` with Node types. [Keep Node types out of the frontend](https://github.com/aws/cdk-blocks/blob/main/docs/guides/upgrading-older-apps.md#keep-node-types-out-of-the-frontend) explains the layout and how to move an older app to it.

How a template registers itself and how the CLI stamps its `@aws-cdk-blocks/*` dependency ranges is in [DESIGN.md](https://github.com/aws/cdk-blocks/blob/main/packages/create-blocks-app/DESIGN.md), for contributors.

## Related Packages

- [blocks](https://github.com/aws/cdk-blocks/tree/main/packages/blocks#readme) - Core runtime and Building Blocks
