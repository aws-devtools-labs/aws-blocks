// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pinned constants for the OTel building blocks. Zero runtime dependencies.
 */

/**
 * AWS account that owns the standalone `opentelemetry-collector` Lambda layers
 * (the `open-telemetry/opentelemetry-lambda` project). Same across regions.
 */
export const COLLECTOR_LAYER_ACCOUNT = '184161586896';

/**
 * Default version token of the `opentelemetry-collector-<arch>-<ver>` layer.
 * Verified present in us-east-1 (both `amd64` and `arm64`). Re-verify / bump as
 * newer versions ship; override per instance via `layerVersion`/`layerArn`.
 */
export const DEFAULT_COLLECTOR_LAYER_VERSION = '0_15_0';

/** Port the collector's OTLP/HTTP receiver listens on inside the Lambda sandbox. */
export const COLLECTOR_LOCAL_PORT = 4318;
