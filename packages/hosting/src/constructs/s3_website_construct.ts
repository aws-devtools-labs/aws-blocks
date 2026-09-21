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
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
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
      // Website hosting needs the public bucket-policy read to take effect. Use
      // BLOCK_ACLS_ONLY (blocks ACLs, but sets blockPublicPolicy AND
      // restrictPublicBuckets to FALSE) — the deprecated BLOCK_ACLS leaves those
      // two unset, so S3 defaults them to true and SILENTLY neutralizes the
      // public-read policy (anonymous website reads then 403).
      blockPublicAccess: BlockPublicAccess.BLOCK_ACLS_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // SPA deep-link fallback: without public `s3:ListBucket`, a request for a
    // missing key returns 403 (AccessDenied), and S3 website hosting then serves
    // its OWN 403 page instead of the `index.html` error document — so client-side
    // deep links (e.g. `/auth`) break with a 403. Granting anonymous `ListBucket`
    // makes a missing key a 404 (NoSuchKey), which S3 routes to the error document
    // (→ `index.html`), so the client router can take over. (`publicReadAccess`
    // only grants object reads, not this.) Trade-off: the object list is publicly
    // enumerable — acceptable for a public static-website bucket.
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        principals: [new AnyPrincipal()],
        actions: ['s3:ListBucket'],
        resources: [this.bucket.bucketArn],
      }),
    );

    // Publish the built static dir to the bucket ROOT (no build-id prefix).
    // EXCLUDE `.blocks-sandbox/*`: the build ships a placeholder
    // `.blocks-sandbox/config.json` (`{_placeholder:true}`), and the REAL config
    // (with the absolute cross-origin `apiUrl` this door needs) is written to the
    // same key by the separate `BlocksConfigDeployment`. Uploading the placeholder
    // here — plus `prune` — races/ clobbers that real config, leaving the SPA with
    // no `apiUrl` (it then falls back to a relative `/aws-blocks/api`, which the
    // S3 website 405s). Excluding the prefix and not pruning lets the config
    // deployment solely own `.blocks-sandbox/config.json`, deterministically.
    new BucketDeployment(this, 'WebsiteDeployment', {
      sources: [Source.asset(staticDir)],
      destinationBucket: this.bucket,
      exclude: ['.blocks-sandbox/*'],
      prune: false,
    });

    this.url = this.bucket.bucketWebsiteUrl; // http://<bucket>.s3-website-<region>.amazonaws.com
    new CfnOutput(this, 'WebsiteUrl', { value: this.url, description: 'S3 static-website front-door URL (HTTP only)' });
  }
}
