/**
 * Regenerate the typed client that `src/` imports from the local `aws-blocks`
 * package.
 *
 * The package's exports map the `browser` and `import` conditions to
 * ./client.js, which is generated and gitignored. The dev server writes it as a
 * side effect, so development machines always have one; a fresh checkout does
 * not, and `vite build` then fails to resolve the package. Because the Hosting
 * block runs the frontend build during CDK synthesis, a missing client file
 * breaks `cdk synth` on any clean clone, not just the frontend.
 *
 * Wired as a `prebuild` hook so every path that builds the frontend (a direct
 * `npm run build`, CI, and the Hosting block during synth or deploy)
 * regenerates the file with nothing extra to remember.
 */
import { writeClientCode } from '@aws-blocks/blocks/scripts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const foundation = join(root, 'aws-blocks', 'index.ts');
const output = join(root, 'aws-blocks', 'client.js');

if (!existsSync(foundation)) {
  console.error(`generate-client: cannot find ${foundation}`);
  process.exit(2);
}

await writeClientCode(foundation, output);
console.log(`generate-client: wrote ${output}`);
