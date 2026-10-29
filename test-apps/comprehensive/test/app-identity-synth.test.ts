// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `defaults.app` across every Building Block.
 *
 * Synthesizes this app (which instantiates every BB) with `defaults.app` and a
 * permissions boundary set, then checks:
 * - no Building Block's own grants or roles count as reaching outside the app —
 *   the IAM report lists no violations, so a platform can run with `strict: true`
 *   and `blocks-iam-check` passes on a plain AWS Blocks app;
 * - every `AWS::IAM::Role` carries the `app` tag, so a boundary keyed on
 *   `aws:PrincipalTag/app` reads it on every role.
 *
 * The app id is `bb`, the prefix of this app's stack names (`bb-test-…`).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(__dirname, '..');
const APP_ID = 'bb';

type Resource = { Type: string; Properties?: { Tags?: { Key: string; Value: unknown }[] } };

// ── A small IAM evaluator: enough to ask "does the boundary allow this grant?" ──

type Template = { stackName?: string; Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };
type Statement = { Effect: string; Action: string | string[]; Resource?: string | string[]; Condition?: Record<string, Record<string, unknown>> };
/** One granted action on one resource, rendered; `own` = the ARN names one of the template's own (tagged) resources. */
type Grant = { action: string; arn: string; own: boolean };

const ACCOUNT = '111111111111';
const REGION = 'us-east-1';
/** Placeholder ids for the template's own APIs (what `--api-id` would list once deployed). */
const API_IDS = ['apiid00001', 'apiid00002', 'apiid00003'];
/** Services the boundary scopes by the resource's `app` tag. Not `bedrock`: its models and inference profiles are AWS-owned, untagged. */
const TAG_SCOPED = new Set(['secretsmanager', 'states', 'cognito-idp', 'kms', 'bedrock-agentcore', 'dsql', 's3vectors', 'cloudfront', 'cloudfront-keyvaluestore']);
const list = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const glob = (pattern: string, value: string, flags = '') =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, flags).test(value);

/** Every Allow grant in the templates' role policies, its resource rendered to an ARN (refs to own resources → their names). */
function grants(all: Template[]): Grant[] {
  const out: Grant[] = [];
  for (const t of all) {
    const resources = t.Resources ?? {};
    const stack = t.stackName ?? APP_ID;
    const apiIds = new Map<string, string>();
    for (const [id, r] of Object.entries(resources)) {
      if (/^AWS::ApiGateway(V2)?::(Api|RestApi)$/.test(r.Type ?? '')) apiIds.set(id, API_IDS[apiIds.size] ?? 'apiid99999');
    }
    // The physical name a Ref gives: the type's own name property when literal, or the
    // CloudFormation-generated `<stack>-<logical id>-…` (which starts with the app id).
    const nameOf = (id: string): string => {
      if (apiIds.has(id)) return apiIds.get(id) as string;
      const type = resources[id]?.Type ?? '';
      const props = resources[id]?.Properties ?? {};
      const key = [`${type.split('::')[2]}Name`, 'Name', 'DBClusterIdentifier'].find((k) => typeof props[k] === 'string');
      return key ? (props[key] as string) : `${stack}-${id}-gen`.toLowerCase();
    };
    // The ARN `Fn::GetAtt [X, Arn]` gives, for the types whose ARN is built from their name.
    const arnOf = (id: string): string | undefined => {
      const name = nameOf(id);
      const arns: Record<string, string> = {
        'AWS::DynamoDB::Table': `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${name}`,
        'AWS::S3::Bucket': `arn:aws:s3:::${name}`,
        'AWS::Lambda::Function': `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`,
        'AWS::SQS::Queue': `arn:aws:sqs:${REGION}:${ACCOUNT}:${name}`,
        'AWS::Logs::LogGroup': `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${name}:*`,
      };
      return arns[resources[id]?.Type ?? ''];
    };
    const pseudo: Record<string, string> = {
      'AWS::Partition': 'aws',
      'AWS::Region': REGION,
      'AWS::AccountId': ACCOUNT,
      'AWS::URLSuffix': 'amazonaws.com',
      'AWS::StackName': stack,
      'AWS::StackId': `arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${stack}/guid`,
    };
    // A part of an ARN: a reference to an own resource renders to its name (or id).
    const render = (v: unknown): { arn: string; own: boolean } | undefined => {
      if (typeof v === 'string') return { arn: v, own: false };
      const o = (v ?? {}) as Record<string, unknown>;
      if (typeof o.Ref === 'string') {
        return o.Ref in pseudo ? { arn: pseudo[o.Ref], own: false } : { arn: nameOf(o.Ref), own: true };
      }
      if (Array.isArray(o['Fn::GetAtt'])) {
        const [id, attribute] = o['Fn::GetAtt'].map(String);
        if (attribute !== 'Arn') return { arn: nameOf(id), own: true };
        const arn = arnOf(id);
        return arn === undefined ? undefined : { arn, own: true };
      }
      const join = o['Fn::Join'] as [string, unknown[]] | undefined;
      if (Array.isArray(join)) {
        const parts = join[1].map(render);
        if (parts.some((p) => p === undefined)) return undefined;
        return { arn: parts.map((p) => p?.arn).join(join[0]), own: parts.some((p) => p?.own) };
      }
      return undefined;
    };
    const docs: { doc: unknown; logRetention?: string }[] = [];
    for (const r of Object.values(resources)) {
      if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') docs.push({ doc: r.Properties?.PolicyDocument });
      if (r.Type === 'AWS::IAM::Role') for (const p of list(r.Properties?.Policies as { PolicyDocument: unknown }[] | undefined)) docs.push({ doc: p.PolicyDocument });
      // CDK's log-retention provider is granted `*`: check it against the log group it actually manages.
      if (r.Type === 'Custom::LogRetention') {
        const group = render(r.Properties?.LogGroupName);
        if (group) {
          const arn = `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${group.arn}`;
          for (const action of ['logs:CreateLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy']) {
            out.push({ action, arn, own: true }, { action, arn: `${arn}:*`, own: true });
          }
        }
      }
    }
    for (const { doc } of docs) {
      for (const s of list((doc as { Statement?: Statement[] } | undefined)?.Statement)) {
        if (s.Effect !== 'Allow') continue;
        for (const resource of list(s.Resource as unknown)) {
          // A whole-ARN reference (`Fn::GetAtt [X, Arn]`, `Ref` to a queue) is the own resource itself:
          // only an ARN the template spells out (`Fn::Join`, a literal) is rendered.
          const whole = typeof resource === 'object' && resource !== null && !('Fn::Join' in resource);
          const rendered = whole ? undefined : render(resource);
          // `*` (or something unrenderable): the target isn't known here; the action must be allowed on something.
          for (const action of list(s.Action)) {
            if (!rendered) {
              out.push({ action, arn: '?', own: true });
              continue;
            }
            // A wildcard on a tag-scoped service reaches the app's own (tagged) resources only.
            const tagScoped = TAG_SCOPED.has(action.split(':')[0]) && rendered.arn.split(':').slice(5).join(':').includes('*');
            out.push({ action, arn: rendered.arn, own: rendered.own || tagScoped });
          }
        }
      }
    }
  }
  return out;
}

/**
 * Whether the boundary allows the grant. Own resources carry `app=<id>`; a literal
 * ARN with no own reference (an AWS-owned model, a wildcard) is untagged. For `*`
 * and unrenderable resources, only whether any boundary statement allows the action.
 */
function evaluate(boundary: { Statement: Statement[] }, g: Grant): boolean {
  const sub = (v: string) => v.replaceAll('$' + '{aws:PrincipalTag/app}', APP_ID);
  return boundary.Statement.some((s) => {
    if (s.Effect !== 'Allow' || !list(s.Action).some((a) => glob(a, g.action, 'i'))) return false;
    if (g.arn === '*' || g.arn === '?') return true;
    if (!list(s.Resource).some((p) => glob(sub(p), g.arn))) return false;
    for (const [op, keys] of Object.entries(s.Condition ?? {})) {
      for (const [key, value] of Object.entries(keys)) {
        if (op === 'StringEquals' && key === 'aws:ResourceTag/app') {
          if (!(g.own && sub(String(value)) === APP_ID)) return false;
        } else if (op === 'StringLike' && key === 'kms:ViaService') {
          // Only reachable through those services: assume the grant is used through them.
        } else {
          throw new Error(`the evaluator doesn't know ${op} ${key}`);
        }
      }
    }
    return true;
  });
}

describe('defaults.app: every Building Block stays inside the app', () => {
  let outdir: string;

  before(() => {
    outdir = mkdtempSync(join(tmpdir(), 'blocks-app-identity-'));
    // AGENTS.md Core rule 1: synth needs `--conditions=cdk`.
    const nodeOptions = process.env.NODE_OPTIONS ?? '';
    execFileSync(
      'npx',
      [
        'cdk', 'synth', '--app', 'npx tsx -C cdk aws-blocks/index.cdk.ts', '--output', outdir, '--quiet',
        '--context', 'sandboxMode=true', '--context', 'blocksPermissionsBoundary=apps-boundary',
        '--context', `blocksAppId=${APP_ID}`,
        // On a shared platform each app's bootstrap qualifier is its app id.
        '--context', `@aws-cdk/core:bootstrapQualifier=${APP_ID}`,
      ],
      {
        cwd: APP_ROOT,
        stdio: 'pipe',
        env: {
          ...process.env,
          NODE_OPTIONS: nodeOptions.includes('--conditions=cdk') ? nodeOptions : `${nodeOptions} --conditions=cdk`.trim(),
        },
      },
    );
  });

  after(() => rmSync(outdir, { recursive: true, force: true }));

  test('the IAM report names the app and lists no violations', () => {
    const reports = readdirSync(outdir).filter((f) => f.endsWith('.blocks-iam.json'));
    assert.strictEqual(reports.length, 1, `expected one report, found ${reports}`);
    const report = JSON.parse(readFileSync(join(outdir, reports[0]), 'utf8')) as {
      app?: { id: string };
      violations?: { rule: string; message: string }[];
    };
    assert.strictEqual(report.app?.id, APP_ID);
    assert.deepStrictEqual(
      (report.violations ?? []).map((v) => `[${v.rule}] ${v.message}`),
      [],
      'a Building Block reached outside the app',
    );
  });

  test('every AWS::IAM::Role in every template carries app=<id>', () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of readdirSync(outdir).filter((f) => f.endsWith('.template.json'))) {
      const { Resources = {} } = JSON.parse(readFileSync(join(outdir, file), 'utf8')) as {
        Resources?: Record<string, Resource>;
      };
      for (const [id, r] of Object.entries(Resources)) {
        if (r.Type !== 'AWS::IAM::Role') continue;
        checked++;
        const tag = r.Properties?.Tags?.find((t) => t.Key === 'app')?.Value;
        if (tag !== APP_ID) missing.push(`${file}: ${id} → ${JSON.stringify(tag ?? 'NONE')}`);
      }
    }
    assert.ok(checked >= 10, `expected the full app's roles, found only ${checked}`);
    assert.deepStrictEqual(missing, [], `roles without app=${APP_ID}:\n  ${missing.join('\n  ')}`);
  });

  /** The generator module (`@aws-blocks/core` resolves to `<pkg>/dist/index.js`; the generator sits beside it). */
  type Policies = {
    generateBoundaryPolicy: (o?: { executeApiIds?: string[] }) => { Statement: Statement[] };
    generateExecutionPolicy: (types: Iterable<string>, o: { appId: string; account: string }) => { unscoped: string[]; accepted: string[] };
    resourceTypesOf: (templates: Iterable<Template>) => Set<string>;
  };
  const policies = async (): Promise<Policies> => {
    const core = dirname(createRequire(import.meta.url).resolve('@aws-blocks/core'));
    return (await import(pathToFileURL(join(core, 'scripts', 'iam-policies.js')).href)) as Policies;
  };
  const templates = (): Template[] =>
    readdirSync(outdir)
      .filter((f) => f.endsWith('.template.json'))
      .map((f) => ({ ...(JSON.parse(readFileSync(join(outdir, f), 'utf8')) as Template), stackName: f.replace(/\.template\.json$/, '') }));

  test("every action a Building Block's roles are granted, on the resource it names, is allowed by the generated boundary", async () => {
    const { generateBoundaryPolicy } = await policies();
    // The per-app boundary for an app that calls its own APIs through execute-api,
    // with the ids its APIs get (placeholders for the template's own APIs).
    const perApp = generateBoundaryPolicy({ executeApiIds: [...API_IDS] });
    const shared = generateBoundaryPolicy();
    const deniedPerApp = new Set<string>();
    const deniedShared = new Set<string>();
    for (const grant of grants(templates())) {
      const key = `${grant.action} on ${grant.arn}`;
      if (!evaluate(perApp, grant)) deniedPerApp.add(key);
      if (!evaluate(shared, grant)) deniedShared.add(key);
    }
    assert.deepStrictEqual([...deniedPerApp].sort(), [], 'grants the per-app boundary would deny at runtime');
    // The shared boundary denies execute-api by design (another app could post to this
    // app's sockets): exactly the Realtime / Agent-streaming grants, nothing else.
    const nonExecuteApi = [...deniedShared].filter((k) => !k.startsWith('execute-api:'));
    assert.deepStrictEqual(nonExecuteApi.sort(), [], 'grants the shared boundary would deny, besides execute-api');
    assert.ok(deniedShared.size > 0, 'the app uses Realtime, so the shared boundary must deny its execute-api grants');
  });

  test("every resource type the app's templates use has an execution-policy rule (AgentCore excepted, on purpose)", async () => {
    const { generateExecutionPolicy, resourceTypesOf } = await policies();
    const { unscoped, accepted } = generateExecutionPolicy(resourceTypesOf(templates()), { appId: APP_ID, account: '111111111111' });
    // The only allowed entries: types the generator leaves to the platform on purpose
    // (see UNSCOPED_REASONS in iam-policies.ts). A new Building Block whose resource
    // type has no rule fails here, instead of at the platform's first deploy.
    const ALLOWED_UNSCOPED = [
      // Its workload identity lives in the account-wide "default" directory, untagged, and runtime names can't carry `<id>-`.
      'AWS::BedrockAgentCore::Runtime',
    ];
    assert.deepStrictEqual(unscoped.filter((t) => !ALLOWED_UNSCOPED.includes(t)), [], 'resource types with no execution-policy rule');
    assert.deepStrictEqual(accepted, [], 'this app has no CloudFront, so no accepted exception');
  });

  test('blocks-iam-check passes on the synthesized templates', () => {
    // `@aws-blocks/core` resolves to `<pkg>/dist/index.js`; the CLI sits beside it.
    const cli = join(dirname(createRequire(import.meta.url).resolve('@aws-blocks/core')), 'scripts', 'iam-check-cli.js');
    const output = execFileSync(process.execPath, [cli, outdir, '--app', APP_ID], { encoding: 'utf8' });
    assert.match(output, /no violations/);
  });
});
