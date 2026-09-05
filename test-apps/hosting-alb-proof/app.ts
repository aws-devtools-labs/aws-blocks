// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal standalone CDK app proving the ALB front door end-to-end.
 *
 * It builds a service-agnostic CapabilityPlan for a tiny static site, uploads
 * the assets to a PRIVATE S3 bucket under `builds/<buildId>/`, and renders the
 * plan onto an Application Load Balancer via the AlbAdapter — NO CloudFront.
 * The ALB routes every request to the asset-proxy Lambda, which streams the
 * objects out of the private bucket (the ALB analogue of CloudFront's S3+OAC).
 */
import { join } from 'node:path';
import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Bucket, BlockPublicAccess } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { AlbAdapter, buildCapabilityPlan, type DeployManifest } from '@aws-blocks/hosting/constructs';

const app = new App();
const stack = new Stack(app, 'blocks-hosting-alb-proof', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});

const buildId = 'albproof';
const siteDir = join(import.meta.dirname, 'site');

// Private assets bucket (no public access — proves the asset-proxy path).
const bucket = new Bucket(stack, 'Assets', {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  enforceSSL: true,
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true,
});

// Upload the static site under the build-id prefix the asset-proxy reads.
new BucketDeployment(stack, 'AssetDeployment', {
  sources: [Source.asset(siteDir)],
  destinationBucket: bucket,
  destinationKeyPrefix: `builds/${buildId}`,
});

// A tiny static manifest → the neutral CapabilityPlan (SPA fallback so the
// catch-all serves index.html; no server, no image origin).
const manifest: DeployManifest = {
  version: 1,
  compute: {},
  staticAssets: { directory: siteDir, spaFallback: true },
  routes: [
    { pattern: '/assets/*', target: 'static' },
    { pattern: '/*', target: 'static' },
  ],
};

const plan = buildCapabilityPlan({ manifest, buildId, hasServer: false, hasImage: false });

// Render the plan onto an ALB (creates a default VPC since none is passed).
new AlbAdapter().render(stack, plan, { bucket });
