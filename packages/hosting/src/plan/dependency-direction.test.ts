/**
 * Dependency-direction guard (Phase 1 exit criterion).
 *
 * The service-agnostic plan layer must not depend on any front-door service.
 * This asserts the boundary structurally so it can't silently re-couple over
 * time: the plan's pure logic (route-table, capability-plan) imports NO CDK at
 * all, and no plan file imports `aws-cdk-lib` (which includes `aws-cloudfront`).
 *
 * Runs against the compiled `dist/plan/*.js` (ESM import statements survive
 * compilation), so it checks exactly what ships.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const planDistDir = dirname(fileURLToPath(import.meta.url));

const planFiles = readdirSync(planDistDir).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));

const sourceOf = (file: string): string => readFileSync(join(planDistDir, file), 'utf8');

describe('plan layer — dependency direction', () => {
  it('has plan files to check (sanity)', () => {
    assert.ok(planFiles.length >= 3, `expected the plan module to be compiled, found ${planFiles.join(', ')}`);
  });

  it('no plan file imports aws-cdk-lib (nor any aws-cloudfront submodule)', () => {
    for (const file of planFiles) {
      const src = sourceOf(file);
      assert.ok(
        !/from ['"]aws-cdk-lib/.test(src),
        `${file} must not import aws-cdk-lib — the plan layer is service-agnostic`,
      );
    }
  });

  it('the pure builders (route-table, capability-plan) import no CDK graph library at all', () => {
    for (const file of ['route-table.js', 'capability-plan.js']) {
      const src = sourceOf(file);
      assert.ok(!/from ['"]constructs['"]/.test(src), `${file} must not import 'constructs'`);
      assert.ok(!/from ['"]aws-cdk-lib/.test(src), `${file} must not import aws-cdk-lib`);
    }
  });
});
