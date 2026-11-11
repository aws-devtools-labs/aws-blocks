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
 * default user is root. Blocks doesn't run it as root: the task definition sets
 * the container user to {@link DEFAULT_CONTAINER_USER} (the image's built-in
 * `node` user) and boots from {@link DEFAULT_CONTAINER_APP_DIR}, which that user
 * owns, starting in {@link DEFAULT_CONTAINER_WORKDIR}. When bumping the digest,
 * confirm the image still ships `node` as uid/gid 1000 with `/home/node` as its
 * home directory.
 *
 * **Bumping it.** Dependabot doesn't track this constant. To pick up a newer
 * `24-slim` (security patches, Node minor releases), run
 * `node scripts/container-default-image-digest.mjs` from the repo root; it
 * prints the current index digest and whether this constant matches, and
 * verifies the pinned digest resolves to an image index that lists linux/arm64.
 * Replace the digest below, run this package's tests (they fail unless the
 * constant is a `node@sha256:<64 hex>` reference), and add a changeset; the
 * `Container default image digest` workflow re-runs the registry check on the
 * pull request. A change of
 * Node major is a separate decision: it must move together with the Lambda
 * runtime.
 *
 * @internal
 */
export const DEFAULT_CONTAINER_IMAGE =
	'public.ecr.aws/docker/library/node@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9'; // node:24-slim

/**
 * Container user (`uid:gid`) the default image runs as: the unprivileged `node`
 * user (uid/gid 1000) that the Docker official Node images create. Numeric, so
 * ECS doesn't need to look the name up in the image's `/etc/passwd`. Applied only
 * to {@link DEFAULT_CONTAINER_IMAGE}; a custom `image` runs as its own default
 * user.
 *
 * @internal
 */
export const DEFAULT_CONTAINER_USER = '1000:1000';

/**
 * Directory the default image boots from (bootstrap, `main.js`, `worker.js`).
 * Under the `node` user's home directory, which that user owns — the root-owned
 * `/app` isn't writable by {@link DEFAULT_CONTAINER_USER}. A custom `image` keeps
 * {@link CUSTOM_IMAGE_APP_DIR}.
 *
 * @internal
 */
export const DEFAULT_CONTAINER_APP_DIR = '/home/node/app';

/**
 * Working directory the default image's process starts in: the `node` user's
 * home, which that user owns. The image sets no `WorkingDir`, so without this the
 * process would start in the root-owned `/` and a relative write (for example
 * `writeFile('report.csv')`) would fail with EACCES. It isn't
 * {@link DEFAULT_CONTAINER_APP_DIR} because that directory doesn't exist when the
 * container starts, and a working directory the container runtime has to create
 * may be created as root, which would leave the boot directory unwritable. A custom
 * `image` keeps its own `WORKDIR`.
 *
 * @internal
 */
export const DEFAULT_CONTAINER_WORKDIR = '/home/node';

/**
 * Directory a custom `image` boots from. Unchanged from earlier releases, so an
 * image that prepared `/app` for its own (possibly non-root) user keeps working.
 *
 * @internal
 */
export const CUSTOM_IMAGE_APP_DIR = '/app';
