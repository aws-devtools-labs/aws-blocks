// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Template test for the VPC endpoints of this app (runs in Unit Tests, no AWS).
 *
 * E2E Compute Smoke deploys this app with `provisionEndpoints: false` into a VPC
 * with permanent endpoints, so on every PR it no longer checks what the
 * framework does when it creates the endpoints itself. This test synthesizes
 * the app both ways against an imported VPC shaped like the test VPCs, and
 * checks, with `provisionEndpoints: true`:
 * - the endpoint set is S3 + DynamoDB (gateway) and SQS + Logs (interface), the
 *   same set test-infra gives BlocksComputeTestVpc;
 * - the gateway endpoints are on every subnet's route table;
 * - the interface endpoints have private DNS on and sit in the private subnets;
 * - their security group admits 443 only from the Blocks compute security
 *   group, and that is the group both the Lambda and the Fargate services use.
 * With `provisionEndpoints: false` the stack adds no endpoint at all (one would
 * collide with the permanent ones). The E2E Compute Endpoints workflow deploys
 * the `true` variant for real.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMPUTE_TEST_VPC_ENDPOINTS, endpointServiceName } from '../../../test-infra/vpc-test-stack.js';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const VPC_ID = 'vpc-0123456789abcdef0';

// What Vpc.fromLookup would return for a test VPC (2 AZs, public, private with
// egress, isolated; one route table per subnet).
const SUBNETS = {
  Public: ['a', 'b'].map((az, i) => subnet(`pub${az}`, `10.0.${i}.0/24`, az)),
  Private: ['a', 'b'].map((az, i) => subnet(`priv${az}`, `10.0.${i + 2}.0/24`, az)),
  Isolated: ['a', 'b'].map((az, i) => subnet(`iso${az}`, `10.0.${i + 4}.0/24`, az)),
};
function subnet(name: string, cidr: string, az: string) {
  return { subnetId: `subnet-${name}`, cidr, availabilityZone: `${REGION}${az}`, routeTableId: `rtb-${name}` };
}
const VPC_LOOKUP = {
  [`vpc-provider:account=${ACCOUNT}:filter.vpc-id=${VPC_ID}:region=${REGION}:returnAsymmetricSubnets=true`]: {
    vpcId: VPC_ID,
    vpcCidrBlock: '10.0.0.0/16',
    ownerAccountId: ACCOUNT,
    availabilityZones: [],
    subnetGroups: Object.entries(SUBNETS).map(([type, subnets]) => ({ name: type.toLowerCase(), type, subnets })),
  },
};
const ALL_ROUTE_TABLES = Object.values(SUBNETS)
  .flat()
  .map((s) => s.routeTableId)
  .sort();
const PRIVATE_SUBNETS = SUBNETS.Private.map((s) => s.subnetId).sort();

type Resource = { Type: string; Properties?: Record<string, any> };
type Resources = Record<string, Resource>;

const tmpDirs: string[] = [];

/** Synthesize the app the way `cdk synth` would and return the main stack's resources. */
function synth(provisionEndpoints: boolean): Resources {
  const dir = mkdtempSync(join(tmpdir(), 'compute-smoke-synth-'));
  tmpDirs.push(dir);
  const outdir = join(dir, 'cdk.out');
  execFileSync('npx', ['tsx', '-C', 'cdk', 'aws-blocks/index.cdk.ts'], {
    cwd: appDir,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 180_000,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      CDK_OUTDIR: outdir,
      CDK_DEFAULT_ACCOUNT: ACCOUNT,
      CDK_DEFAULT_REGION: REGION,
      // projectRoot keeps the sandbox id file out of the app directory.
      CDK_CONTEXT_JSON: JSON.stringify({ ...VPC_LOOKUP, sandboxMode: 'true', projectRoot: dir }),
      VPC_TEST_VPC_ID: VPC_ID,
      BLOCKS_STACK_SUFFIX: 'synth',
      COMPUTE_SMOKE_PROVISION_ENDPOINTS: provisionEndpoints ? 'true' : '',
    },
  });
  const manifest = JSON.parse(readFileSync(join(outdir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.missing ?? [], [], 'every context lookup is answered (no dummy VPC)');
  const templates = readdirSync(outdir).filter((f) => /^bb-[^.]*\.template\.json$/.test(f) && !f.includes('-vpc-ref'));
  assert.equal(templates.length, 1, `exactly one app stack template in ${outdir}, got ${templates.join(', ')}`);
  return JSON.parse(readFileSync(join(outdir, templates[0]), 'utf8')).Resources;
}

function ofType(resources: Resources, type: string): [string, Resource][] {
  return Object.entries(resources).filter(([, r]) => r.Type === type);
}

const serviceName = (props: Record<string, any>) => endpointServiceName(props.ServiceName);

function logicalId(resources: Resources, pattern: RegExp, type = 'AWS::EC2::SecurityGroup'): string {
  const ids = ofType(resources, type)
    .map(([id]) => id)
    .filter((id) => pattern.test(id));
  assert.equal(ids.length, 1, `exactly one ${type} matching ${pattern}, got ${ids.join(', ')}`);
  return ids[0];
}

const groupId = (id: string) => ({ 'Fn::GetAtt': [id, 'GroupId'] });

/** The Lambda functions and Fargate services in the VPC all use the compute SG, in the private subnets. */
function assertRuntimesUse(resources: Resources, computeSg: string): void {
  const functions = ofType(resources, 'AWS::Lambda::Function').filter(([, r]) => r.Properties?.VpcConfig);
  assert.ok(functions.length >= 1, 'the API Lambda is in the VPC');
  for (const [id, fn] of functions) {
    assert.deepEqual(fn.Properties?.VpcConfig.SecurityGroupIds, [groupId(computeSg)], `${id} security group`);
    assert.deepEqual([...fn.Properties?.VpcConfig.SubnetIds].sort(), PRIVATE_SUBNETS, `${id} subnets`);
  }
  const services = ofType(resources, 'AWS::ECS::Service');
  assert.equal(services.length, 2, 'worker and slow-worker Fargate services');
  for (const [id, svc] of services) {
    const net = svc.Properties?.NetworkConfiguration.AwsvpcConfiguration;
    assert.deepEqual(net.SecurityGroups, [groupId(computeSg)], `${id} security group`);
    assert.deepEqual([...net.Subnets].sort(), PRIVATE_SUBNETS, `${id} subnets`);
  }
}

describe('compute-smoke VPC endpoints (template)', () => {
  let created: Resources;
  let permanent: Resources;

  before(() => {
    created = synth(true);
    permanent = synth(false);
  });

  after(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  describe('provisionEndpoints: true (the framework creates them)', () => {
    test('creates the same endpoint set test-infra gives BlocksComputeTestVpc', () => {
      const endpoints = ofType(created, 'AWS::EC2::VPCEndpoint').map(([, r]) => r.Properties ?? {});
      const names = (type: string) =>
        endpoints
          .filter((p) => (p.VpcEndpointType ?? 'Gateway') === type)
          .map(serviceName)
          .sort();
      assert.deepEqual(names('Gateway'), [...COMPUTE_TEST_VPC_ENDPOINTS.gateway]);
      assert.deepEqual(names('Interface'), [...COMPUTE_TEST_VPC_ENDPOINTS.interface]);
    });

    test('gateway endpoints are on the route table of every subnet', () => {
      for (const [id, ep] of ofType(created, 'AWS::EC2::VPCEndpoint')) {
        if (ep.Properties?.VpcEndpointType === 'Interface') continue;
        assert.equal(ep.Properties?.VpcId, VPC_ID, `${id} VPC`);
        assert.deepEqual([...ep.Properties?.RouteTableIds].sort(), ALL_ROUTE_TABLES, `${id} route tables`);
      }
    });

    test('interface endpoints have private DNS on, in the private subnets, behind the endpoint SG', () => {
      const endpointSg = logicalId(created, /BlocksVpcEndpointSg/);
      const interfaces = ofType(created, 'AWS::EC2::VPCEndpoint').filter(
        ([, r]) => r.Properties?.VpcEndpointType === 'Interface',
      );
      assert.ok(interfaces.length > 0);
      for (const [id, ep] of interfaces) {
        assert.equal(ep.Properties?.PrivateDnsEnabled, true, `${id} private DNS`);
        assert.deepEqual([...ep.Properties?.SubnetIds].sort(), PRIVATE_SUBNETS, `${id} subnets`);
        assert.deepEqual(ep.Properties?.SecurityGroupIds, [groupId(endpointSg)], `${id} security group`);
      }
    });

    test('the endpoint SG admits 443 only from the compute SG the Lambda and Fargate tasks use', () => {
      const endpointSg = logicalId(created, /BlocksVpcEndpointSg/);
      const computeSg = logicalId(created, /BlocksLambdaSg/);
      // Inline rules plus standalone ones (CDK picks either form).
      const ingress = [
        ...(created[endpointSg].Properties?.SecurityGroupIngress ?? []),
        ...ofType(created, 'AWS::EC2::SecurityGroupIngress')
          .map(([, r]) => r.Properties ?? {})
          .filter((p) => JSON.stringify(p.GroupId) === JSON.stringify(groupId(endpointSg)))
          .map(({ GroupId: _, ...rule }) => rule),
      ];
      assert.deepEqual(
        ingress.map(({ Description: _, ...rule }) => rule),
        [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: groupId(computeSg) }],
        'exactly one ingress rule: 443 from the compute SG (no CIDR)',
      );
      assertRuntimesUse(created, computeSg);
    });
  });

  describe('provisionEndpoints: false (CI default, permanent endpoints)', () => {
    test('adds no endpoint and no endpoint SG', () => {
      assert.deepEqual(ofType(permanent, 'AWS::EC2::VPCEndpoint'), []);
      assert.equal(
        ofType(permanent, 'AWS::EC2::SecurityGroup').filter(([id]) => /BlocksVpcEndpointSg/.test(id)).length,
        0,
      );
    });

    test('still places the Lambda and Fargate tasks in the private subnets with the compute SG', () => {
      assertRuntimesUse(permanent, logicalId(permanent, /BlocksLambdaSg/));
    });
  });
});

// This test checks the shape; E2E Compute Endpoints is the only real deploy of
// the endpoints the framework creates. It must run on the PRs that change the
// code deciding them: the core VPC wiring, and each Building Block this app
// imports (a BB declares the endpoints it needs in its index.cdk.ts).
describe('E2E Compute Endpoints workflow', () => {
  const repo = join(appDir, '..', '..');
  const yml = readFileSync(join(repo, '.github/workflows/e2e-compute-endpoints.yml'), 'utf8');
  const block = yml.match(/\n {2}pull_request:\n(?: {4}.*\n)*? {4}paths:\n((?: {6}(?:- |# ).*\n)+)/)?.[1] ?? '';
  // Listed paths only: not a commented-out entry, not a `!` exclusion.
  const paths = [...block.matchAll(/^ {6}- '([^'!][^']*)'\s*$/gm)].map((m) => m[1]);

  test('runs on changes to the core VPC wiring', () => {
    assert.ok(paths.includes('packages/core/src/cdk/**'), `paths: ${paths.join(', ')}`);
  });

  test("runs on changes to the CDK entry of each Building Block the app imports", () => {
    const src = readFileSync(join(appDir, 'aws-blocks/index.ts'), 'utf8');
    const bbs = [...src.matchAll(/from '@aws-blocks\/(bb-[\w-]+)'/g)].map((m) => m[1]);
    assert.ok(bbs.length > 0);
    // Building Blocks the app takes from the umbrella package, and where they live.
    const UMBRELLA: Record<string, string[]> = {
      Compute: ['bb-compute', 'bb-lambda-compute', 'bb-container-compute'],
    };
    const umbrella = src.match(/import \{([^}]+)\} from '@aws-blocks\/blocks'/)?.[1].split(',').map((s) => s.trim()) ?? [];
    for (const name of umbrella) {
      assert.ok(name in UMBRELLA, `index.ts imports ${name} from @aws-blocks/blocks; add it to UMBRELLA`);
      bbs.push(...UMBRELLA[name]);
    }
    if (umbrella.length > 0) {
      assert.ok(paths.includes('packages/blocks/src/index.cdk.ts'), 'e2e-compute-endpoints.yml does not run on packages/blocks');
    }
    for (const bb of bbs) {
      assert.ok(
        paths.includes(`packages/${bb}/src/**`) || paths.includes(`packages/${bb}/src/index.cdk.ts`),
        `e2e-compute-endpoints.yml does not run on changes to ${bb}`,
      );
    }
  });
});
