// Generates cdk-blocks/blocks.spec.json from the backend entry point.
//
// Mirrors server.ts / deploy-sandbox.ts: a tsx script that imports the helper from
// `aws-cdk-blocks/scripts` to exercise the native declarations directly.
// Running under tsx lets writeSpec load the TypeScript backend directly.
import { readNativeDeclarations, writeSpec } from 'aws-cdk-blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const backendPath = join(here, '..', 'index.ts');
const outputPath = join(here, '..', 'blocks.spec.json');

try {
	const nativeDeclarations = readNativeDeclarations(backendPath);
	await writeSpec(backendPath, outputPath, undefined, { nativeDeclarations });
	console.log('✅ OpenRPC spec written to', outputPath);
} catch (err) {
	console.error('❌ Spec generation failed:', err instanceof Error ? err.message : String(err));
	process.exit(1);
}
