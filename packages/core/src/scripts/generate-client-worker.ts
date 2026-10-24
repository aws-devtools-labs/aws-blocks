// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker script for generating client code.
 * Usage: node [--conditions=aws-runtime] --import tsx generate-client-worker.js <foundationPath> <outputPath> [registryOutPath]
 *
 * When `registryOutPath` is given, the Scope BB registry populated by importing
 * the backend is also written there as JSON (see `Scope._registryEntries`), so
 * the parent CLI can report the app's blocks in telemetry without importing the
 * backend itself.
 */
import { generateClientCode } from './generate-client.js';
import { Scope } from '../common/index.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const [foundationPath, outputPath, registryOutPath] = process.argv.slice(2);
const code = await generateClientCode(foundationPath);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, code);
if (registryOutPath) {
	// Telemetry only: a failure here must never fail the deploy that waits on this worker.
	try {
		writeFileSync(registryOutPath, JSON.stringify(Scope._registryEntries()));
	} catch {
		// The caller merges the registry best-effort and treats a missing file as empty.
	}
}
// The client is written; this process has nothing left to do. Exit explicitly so
// a handle opened while importing the backend (a Building Block's runtime client,
// a pool, a timer) can never keep the caller — `deploy()`/`startSandbox()`,
// blocked on this worker — waiting forever.
process.exit(0);
