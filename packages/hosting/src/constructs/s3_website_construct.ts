/**
 * S3 static-website front-door construct — the simplest, cheapest possible
 * door for a PURE static site / SPA, with no CloudFront and no Lambda.
 *
 * Unlike every other door, this does NOT use the private assets bucket +
 * `builds/<buildId>/` layout: S3 website hosting serves from the bucket ROOT
 * with an index/error document, so this construct creates its OWN public
 * website bucket and deploys the built static dir to it. That means:
 *   - **no HTTPS** (S3 website endpoints are HTTP-only — front with a CDN for TLS),
 *   - **public bucket** (website hosting requires public read),
 *   - **no atomic build-id cutover** (deploy overwrites the root).
 *
 * SPA fallback uses the website error document → `index.html` (served with a
 * 404 status, which client-side routers tolerate). Declared on
 * {@link S3WebsiteAdapter}'s matrix so the negotiator makes these trade-offs
 * explicit.
 */
import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import type { CapabilityPlan } from '../plan/types.js';

export type S3WebsiteConstructProps = {
  plan: CapabilityPlan;
  /** The built static assets directory (manifest.staticAssets.directory) to publish. */
  staticDir: string;
};

export class S3WebsiteConstruct extends Construct {
  readonly bucket: Bucket;
  readonly url: string;

  constructor(scope: Construct, id: string, props: S3WebsiteConstructProps) {
    super(scope, id);
    const { plan, staticDir } = props;

    // SPA → error doc is index.html (client router handles deep links); a
    // multi-page static site uses 404.html when present, else index.html.
    const errorDoc = plan.policies.spaFallback ? 'index.html' : '404.html';

    this.bucket = new Bucket(this, 'WebsiteBucket', {
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: errorDoc,
      publicReadAccess: true,
      // Website hosting needs public bucket-policy reads; keep ACLs blocked.
      blockPublicAccess: BlockPublicAccess.BLOCK_ACLS,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Publish the built static dir to the bucket ROOT (no build-id prefix).
    new BucketDeployment(this, 'WebsiteDeployment', {
      sources: [Source.asset(staticDir)],
      destinationBucket: this.bucket,
      prune: true,
    });

    this.url = this.bucket.bucketWebsiteUrl; // http://<bucket>.s3-website-<region>.amazonaws.com
    new CfnOutput(this, 'WebsiteUrl', { value: this.url, description: 'S3 static-website front-door URL (HTTP only)' });
  }
}
