// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Default container image when the workload didn't set `image`. A stock, public,
 * AWS-hosted Node image on the SAME Node major as the Lambda runtime
 * ({@link DEFAULT_NODE_RUNTIME}, Node 24), so container and function behavior
 * match. Pulled remotely by ECS at task start — Blocks builds NO image, so a
 * deploy never needs a local Docker daemon. The app code is delivered separately
 * as an S3 asset and fetched at boot (see `bootstrap.mjs`).
 *
 * **Pinned by digest.** The reference is `repository@sha256:<digest>`, the
 * digest form ECS documents for `image`, so every task start pulls the same
 * reviewed bytes — a re-pushed `24-slim` tag can't change what runs under the
 * shared execution role. The digest is the multi-arch index digest of the
 * `24-slim` tag; ECS resolves the arm64 manifest from the index. The tag isn't
 * part of the reference (ECS documents `:tag` or `@digest`, not both), so it's
 * recorded here and in the bump script instead. The image is served from
 * ECR Public's mirror of the Docker official images, not Docker Hub, so pulls
 * aren't subject to Docker Hub rate limits.
 *
 * At this digest, `24-slim` was Node 24.22.2 (Debian slim) and the image's
 * default user is root.
 *
 * **Bumping it.** Dependabot doesn't track this constant. To pick up a newer
 * `24-slim` (security patches, Node minor releases), run
 * `node scripts/container-default-image-digest.mjs` from the repo root; it
 * prints the current index digest and whether this constant matches. Replace
 * the digest below, run this package's tests (they fail unless the constant is
 * a `node@sha256:<64 hex>` reference), and add a changeset. A change of
 * Node major is a separate decision: it must move together with the Lambda
 * runtime.
 *
 * @internal
 */
export const DEFAULT_CONTAINER_IMAGE =
	'public.ecr.aws/docker/library/node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9'; // node:24-slim
