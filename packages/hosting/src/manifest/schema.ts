import { z } from 'zod';
import { BUILD_ID_PATTERN } from '../defaults.js';

/**
 * Zod schema for a ComputeResource.
 */
export const computeResourceSchema = z
  .object({
    type: z.enum(['handler', 'http-server', 'edge']),
    bundle: z.string().min(1, 'Bundle path must not be empty'),
    handler: z.string().optional(),
    entrypoint: z.string().optional(),
    port: z.number().positive().optional(),
    placement: z.enum(['regional', 'global']),
    streaming: z.boolean().optional(),
    runtime: z.string().optional(),
    memorySize: z.number().positive().optional(),
    timeout: z.number().positive().optional(),
    environment: z.record(z.string()).optional(),
    provisionedConcurrency: z.number().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'handler' && !data.handler) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'handler field is required when type is "handler"',
        path: ['handler'],
      });
    }
    if (data.type === 'http-server' && !data.handler && !data.entrypoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'http-server type requires either handler or entrypoint field',
        path: ['entrypoint'],
      });
    }
    if (data.type === 'edge' && data.placement !== 'global') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'edge type requires placement to be "global"',
        path: ['placement'],
      });
    }
  });

/**
 * Zod schema for a RouteBehavior.
 */
export const routeBehaviorSchema = z.object({
  pattern: z.string().min(1, 'Route pattern must not be empty'),
  target: z.string().min(1, 'Route target must not be empty'),
  fallback: z.string().optional(),
});

/**
 * Zod schema for CacheConfig.
 */
export const cacheConfigSchema = z.object({
  computeResource: z.string().min(1),
  driver: z.enum(['opennext', 'nitro-s3']).optional(),
  tagRevalidation: z.boolean().optional(),
  revalidationQueue: z.boolean().optional(),
  revalidationFunction: z
    .object({
      bundle: z.string().min(1),
      handler: z.string().min(1),
    })
    .optional(),
  seedDirectory: z.string().min(1).optional(),
  initFunction: z
    .object({
      bundle: z.string().min(1),
      handler: z.string().min(1),
    })
    .optional(),
});

/**
 * Zod schema for ImageConfig.
 */
export const remotePatternSchema = z.object({
  protocol: z.enum(['http', 'https']).optional(),
  hostname: z.string().min(1),
  port: z.string().optional(),
  pathname: z.string().optional(),
});

export const imageConfigSchema = z.object({
  bundle: z.string().min(1),
  handler: z.string().min(1),
  formats: z.array(z.string()),
  sizes: z.array(z.number().positive()),
  baseURL: z
    .string()
    .regex(/^\/[^?#\s]*$/, 'baseURL must be an absolute path starting with /')
    .optional(),
  environment: z.record(z.string(), z.string()).optional(),
  domains: z.array(z.string()).optional(),
  remotePatterns: z.array(remotePatternSchema).optional(),
  dangerouslyAllowSVG: z.boolean().optional(),
  minimumCacheTTL: z.number().int().nonnegative().optional(),
});

/**
 * Zod schema for MiddlewareConfig.
 */
export const middlewareConfigSchema = z.object({
  bundle: z.string().min(1),
  handler: z.string().min(1),
  matchers: z.array(z.string()),
});

/**
 * Zod schema for Redirect.
 */
export const redirectSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
  statusCode: z.union([
    z.literal(301),
    z.literal(302),
    z.literal(307),
    z.literal(308),
  ]),
});

/**
 * Zod schema for Rewrite.
 */
export const rewriteSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
});

/**
 * Zod schema for CustomHeader.
 */
export const customHeaderSchema = z.object({
  source: z.string().min(1),
  headers: z.record(z.string()),
});

/** Reserved route targets that don't need a corresponding compute entry. */
const RESERVED_TARGETS = new Set(['static', 's3', 'image-optimization']);

/**
 * Zod schema for the complete DeployManifest.
 */
export const deployManifestSchema = z
  .object({
    version: z.literal(1),
    compute: z.record(computeResourceSchema),
    staticAssets: z.object({
      directory: z.string().min(1, 'Static assets directory must not be empty'),
      cacheControl: z.string().optional(),
      immutablePaths: z.array(z.string().min(1)).optional(),
      noCachePaths: z.array(z.string().min(1)).optional(),
    }),
    routes: z
      .array(routeBehaviorSchema)
      .min(1, 'At least one route is required'),
    cache: cacheConfigSchema.optional(),
    imageOptimization: imageConfigSchema.optional(),
    middleware: middlewareConfigSchema.optional(),
    redirects: z.array(redirectSchema).optional(),
    rewrites: z.array(rewriteSchema).optional(),
    headers: z.array(customHeaderSchema).optional(),
    assetPrefix: z
      .string()
      .regex(
        /^\/[a-zA-Z0-9_/-]+$/,
        'assetPrefix must start with / and contain only letters, digits, dashes, underscores, and slashes',
      )
      .optional(),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    errorPages: z
      .object({
        // eslint-disable-next-line @typescript-eslint/naming-convention
        404: z.string().optional(),
        // eslint-disable-next-line @typescript-eslint/naming-convention
        500: z.string().optional(),
      })
      .partial()
      .optional(),
    buildId: z
      .string()
      .regex(
        BUILD_ID_PATTERN,
        'buildId must be alphanumeric with hyphens, max 64 chars',
      )
      .optional(),
    lifecycle: z
      .array(
        z.object({
          prefix: z.string().min(1),
          days: z.number().int().positive(),
        }),
      )
      .optional(),
    invalidationPaths: z.array(z.string().min(1)).optional(),
    basePath: z
      .string()
      .regex(
        /^\/[a-zA-Z0-9_/-]+$/,
        'basePath must start with /, must not end with /, and must contain only letters, digits, dashes, underscores, and slashes',
      )
      .refine((v) => !v.endsWith('/'), 'basePath must not end with /')
      .optional(),
  })
  .superRefine((data, ctx) => {
    // Validate route targets reference existing compute resources or reserved targets
    const computeKeys = new Set(Object.keys(data.compute));
    const hasInvalidTarget = data.routes.some(
      (route) =>
        !RESERVED_TARGETS.has(route.target) && !computeKeys.has(route.target),
    );
    if (hasInvalidTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Route target must reference an existing compute resource or a reserved target (static, s3, default)',
        path: ['routes'],
      });
    }

    // Check for duplicate route patterns
    const patterns = data.routes.map((r) => r.pattern);
    const duplicates = patterns.filter((p, i) => patterns.indexOf(p) !== i);
    if (duplicates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate route patterns: ${[...new Set(duplicates)].join(', ')}`,
        path: ['routes'],
      });
    }
  });
