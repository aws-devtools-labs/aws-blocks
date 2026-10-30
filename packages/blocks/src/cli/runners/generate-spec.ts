// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs under `tsx`, started by `blocks generate spec`. Under tsx the default
 * loader of `writeSpec` imports a TypeScript backend directly. The output
 * matches the `blocks-generate-spec` CLI of `@aws-blocks/core`.
 */

import { log, readNativeDeclarations, writeSpec } from '@aws-blocks/core/scripts';

const { backendPath, outputPath } = JSON.parse(process.argv[2]) as { backendPath: string; outputPath: string };

// Progress through core's logger: the CLI sets `BLOCKS_LOG_STREAM=stderr`, so
// stdout carries only the `✅` result line.
log.progress('📝 Generating OpenRPC spec...');
log.detail('   backend:', backendPath);
log.detail('   output: ', outputPath);

try {
	const nativeDeclarations = readNativeDeclarations(backendPath);
	if (nativeDeclarations.length > 0) {
		const declarers = nativeDeclarations.map((source) => source.sourcePackage).sort();
		log.detail('   native declarations:', declarers.join(', '));
	}
	await writeSpec(backendPath, outputPath, undefined, { nativeDeclarations });
	console.log('✅ OpenRPC spec written to', outputPath);
} catch (error) {
	console.error('❌ Spec generation failed:', error instanceof Error ? error.message : String(error));
	process.exit(1);
}
