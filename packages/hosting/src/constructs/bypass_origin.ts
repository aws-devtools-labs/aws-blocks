// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Construct } from 'constructs';
import {
  AwsIntegration,
  HttpIntegration,
  LambdaIntegration,
  RestApi,
  type IResource,
} from 'aws-cdk-lib/aws-apigateway';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { Fn } from 'aws-cdk-lib';
import type { DeployManifest } from '../manifest/types.js';

/**
 * Props for {@link BypassOriginConstruct}.
 */
export type BypassOriginConstructProps = {
  /** The deploy manifest (routes + static/compute targets). Framework-agnostic. */
  manifest: DeployManifest;
  /** Build id — assets live under `builds/<buildId>/` in the bucket. */
  buildId: string;
  /** The private assets bucket (API Gateway reads it via an IAM role, not public). */
  bucket: IBucket;
  /** Compute functions by manifest name (SSR server, image-opt, etc.). */
  computeFunctions: Map<string, IFunction>;
  /**
   * The SSR/server compute name that owns the catch-all (`'default'` or
   * `'server'`), or undefined for a static/SPA site (no compute).
   */
  serverComputeName?: string;
  /**
   * Backend API Gateway URL (`https://…/aws-blocks/api`) to proxy `/aws-blocks/*`
   * and `/auth/*` through this SAME origin — so the frontend calls the API
   * same-origin (no CORS, `SameSite=Lax` cookies work). Omit for a site with
   * no backend.
   */
  backendApiUrl?: string;
};

// ---- Construct ----

/**
 * **Preview `bypassCdn` — API-Gateway single origin (no CloudFront).**
 *
 * Serves an entire hosting deploy — static assets, SSR compute, and the Blocks
 * backend API — from ONE API Gateway REST API, so the whole app is same-origin
 * (cookies + no CORS) and no CloudFront distribution is created (fast, throwaway
 * preview deploys).
 *
 * Framework-agnostic: routing is derived from the {@link DeployManifest}, not
 * from framework-specific paths. Because API Gateway routes by path resource
 * (not glob like CloudFront), the model is:
 *
 * - **static route prefixes** (`/_next/*`, `/_astro/*`, `/_nuxt/*`, exact files
 *   like `/favicon.ico`) → an S3 `AwsIntegration` (GET, private bucket via an
 *   IAM role) mapping the path to `builds/<buildId>/<path>`.
 * - **`/aws-blocks/{proxy+}` + `/auth/{proxy+}`** → HTTP proxy to the backend
 *   API Gateway (same-origin API — this is what fixes cookie auth in bypass).
 * - **catch-all `/{proxy+}` + `/`** → the SSR server Lambda (the framework's
 *   own router remains the source of truth). For a static/SPA site (no compute)
 *   the catch-all serves `index.html` from S3.
 *
 * Trade-offs (documented, preview-only): HTTP behavior is API-Gateway's
 * (~29 s / ~10 MB / buffered — same as the SSR path already has behind
 * CloudFront), no edge cache, no WAF/security-headers/compression.
 */
export class BypassOriginConstruct extends Construct {
  /** The single public origin URL (`https://{id}.execute-api.{region}.amazonaws.com/prod`). */
  readonly url: string;
  readonly api: RestApi;

  constructor(scope: Construct, id: string, props: BypassOriginConstructProps) {
    super(scope, id);
    const { manifest, buildId, bucket, computeFunctions, serverComputeName, backendApiUrl } = props;

    this.api = new RestApi(this, 'BypassApi', {
      // Binary passthrough so images/fonts/js from S3 aren't corrupted.
      binaryMediaTypes: ['*/*'],
      deployOptions: { stageName: 'prod' },
      // The framework router / S3 handle 404s; don't let API GW inject its own.
      restApiName: `bypass-${buildId}`.substring(0, 128),
    });

    // ---- S3 read role (private bucket, no public access) ----
    const s3Role = new Role(this, 'S3ReadRole', {
      assumedBy: new ServicePrincipal('apigateway.amazonaws.com'),
    });
    bucket.grantRead(s3Role);

    // Build an S3 GET integration for a `{proxy+}` resource. Maps the captured
    // proxy path to `builds/<buildId>/<staticPrefix>/<proxy>` in the bucket.
    const s3ProxyIntegration = (keyPrefix: string) =>
      new AwsIntegration({
        service: 's3',
        integrationHttpMethod: 'GET',
        path: `${bucket.bucketName}/builds/${buildId}/${keyPrefix ? keyPrefix + '/' : ''}{proxy}`,
        options: {
          credentialsRole: s3Role,
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy',
          },
          integrationResponses: [
            {
              statusCode: '200',
              responseParameters: {
                'method.response.header.Content-Type':
                  'integration.response.header.Content-Type',
                'method.response.header.Cache-Control':
                  'integration.response.header.Cache-Control',
              },
            },
            { statusCode: '403', selectionPattern: '403' },
            { statusCode: '404', selectionPattern: '404' },
          ],
        },
      });

    const addS3Proxy = (resource: IResource, keyPrefix: string) => {
      resource.addMethod('GET', s3ProxyIntegration(keyPrefix), {
        requestParameters: { 'method.request.path.proxy': true },
        methodResponses: [
          {
            statusCode: '200',
            responseParameters: {
              'method.response.header.Content-Type': true,
              'method.response.header.Cache-Control': true,
            },
          },
          { statusCode: '403' },
          { statusCode: '404' },
        ],
      });
    };

    // ---- static route prefixes → S3 ----
    // Distinct top-level path segments of the manifest's static routes
    // (`/_next/static/*` → `_next`, `/_astro/*` → `_astro`, `/favicon.ico` →
    // `favicon.ico`). Framework-agnostic: read from the manifest.
    const staticPrefixes = new Set<string>();
    for (const route of manifest.routes) {
      if (route.target !== 'static') continue;
      const seg = route.pattern.replace(/^\//, '').split('/')[0];
      if (seg && seg !== '*' && seg !== '(.*)') staticPrefixes.add(seg);
    }
    for (const prefix of staticPrefixes) {
      // Wildcard/dir prefix → `<prefix>/{proxy+}` → S3; exact file → GET on it.
      const isGlobPrefix = manifest.routes.some(
        (r) =>
          r.target === 'static' &&
          r.pattern.replace(/^\//, '').startsWith(`${prefix}/`),
      );
      if (isGlobPrefix) {
        const res = this.api.root.addResource(prefix).addResource('{proxy+}');
        addS3Proxy(res, prefix);
      } else {
        // exact file (e.g. favicon.ico): map its own name as the proxy.
        const res = this.api.root.addResource(prefix);
        res.addMethod(
          'GET',
          new AwsIntegration({
            service: 's3',
            integrationHttpMethod: 'GET',
            path: `${bucket.bucketName}/builds/${buildId}/${prefix}`,
            options: {
              credentialsRole: s3Role,
              integrationResponses: [
                {
                  statusCode: '200',
                  responseParameters: {
                    'method.response.header.Content-Type':
                      'integration.response.header.Content-Type',
                  },
                },
                { statusCode: '404', selectionPattern: '4\\d{2}' },
              ],
            },
          }),
          {
            methodResponses: [
              {
                statusCode: '200',
                responseParameters: { 'method.response.header.Content-Type': true },
              },
              { statusCode: '404' },
            ],
          },
        );
      }
    }

    // ---- backend API proxy (/aws-blocks/* + /auth/*) → same origin ----
    if (backendApiUrl) {
      // backendApiUrl is e.g. https://host/prod/aws-blocks/api — strip to the
      // stage root so we can re-mount /aws-blocks and /auth under it.
      const stageRoot = Fn.select(0, Fn.split('/aws-blocks', backendApiUrl));
      for (const prefix of ['aws-blocks', 'auth']) {
        const proxyRes = this.api.root.addResource(prefix).addResource('{proxy+}');
        proxyRes.addMethod(
          'ANY',
          new HttpIntegration(`${stageRoot}/${prefix}/{proxy}`, {
            httpMethod: 'ANY',
            options: {
              requestParameters: {
                'integration.request.path.proxy': 'method.request.path.proxy',
              },
            },
          }),
          { requestParameters: { 'method.request.path.proxy': true } },
        );
      }
    }

    // ---- catch-all: SSR server Lambda (or index.html for static/SPA) ----
    const serverFn = serverComputeName
      ? computeFunctions.get(serverComputeName)
      : undefined;
    if (serverFn) {
      const integration = new LambdaIntegration(serverFn, { proxy: true });
      this.api.root.addMethod('ANY', integration);
      this.api.root.addResource('{proxy+}').addMethod('ANY', integration);
    } else {
      // Static/SPA: serve index.html at the root (client router deep-links).
      const indexIntegration = new AwsIntegration({
        service: 's3',
        integrationHttpMethod: 'GET',
        path: `${bucket.bucketName}/builds/${buildId}/index.html`,
        options: {
          credentialsRole: s3Role,
          integrationResponses: [
            {
              statusCode: '200',
              responseParameters: {
                'method.response.header.Content-Type':
                  "'text/html'",
              },
            },
          ],
        },
      });
      const indexMethodResponses = [
        {
          statusCode: '200',
          responseParameters: { 'method.response.header.Content-Type': true },
        },
      ];
      this.api.root.addMethod('GET', indexIntegration, {
        methodResponses: indexMethodResponses,
      });
      // SPA fallback: any unmatched path → index.html too.
      this.api.root
        .addResource('{proxy+}')
        .addMethod('GET', indexIntegration, { methodResponses: indexMethodResponses });
    }

    this.url = this.api.url;
  }
}
