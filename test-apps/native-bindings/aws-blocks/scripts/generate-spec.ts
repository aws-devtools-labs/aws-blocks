// Generates aws-blocks/blocks.spec.json from the backend entry point.
//
// Mirrors server.ts / deploy.ts: a tsx script that imports the helper from
// `@aws-blocks/blocks/scripts`, rather than invoking the `blocks-generate-spec`
// bin. In the monorepo, npm does not link a workspace package's bin into the
// resolution path, so `npx blocks-generate-spec` 404s in CI — but `tsx` is a
// published dependency that resolves normally, and running under tsx lets
// writeSpec load the TypeScript backend directly (no explicit loader needed).
import { readNativeDeclarations, writeSpec } from '@aws-blocks/blocks/scripts';
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
