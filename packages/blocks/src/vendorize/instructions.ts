// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Write a VENDORIZE.md file with migration instructions into the vendor directory.
 *
 * `binNames` lists the package's commands that were kept and now run the
 * vendorized source through tsx.
 */
export function writeMigrationInstructions(
  destDir: string,
  packageName: string,
  shortName: string,
  binNames: string[] = [],
): void {
  const binNote = binNames.length > 0
    ? `- \`bin\` commands (${binNames.map(n => `\`${n}\``).join(', ')}) kept; they run \`src/\` through \`tsx\` via \`vendor/${shortName}/bin/\`\n`
    : '';

  const content = `# Vendorized: ${packageName}

This package was ejected from \`${packageName}\` into your local project.
Your imports remain unchanged — the local workspace takes priority over the
registry version via npm workspace resolution.

## What happened

- Source copied to \`vendor/${shortName}/src/\`
- \`package.json\` generated with exports remapped from \`dist/\` to \`src/\`
${binNote}- \`vendor/${shortName}\` added to your root \`workspaces\` array
- \`npm install\` re-linked workspaces

## Making changes

Edit files in \`vendor/${shortName}/src/\` directly. Changes take effect
immediately when using \`tsx\` (the default Blocks dev server and CDK synth).

## Updating from upstream

When a new version of \`${packageName}\` is published, you can compare
your vendorized source against the upstream:

\`\`\`bash
# Download the latest published source into .upstream/ and compare
mkdir -p .upstream
npm pack ${packageName}@latest --pack-destination .upstream
tar -xzf .upstream/*.tgz -C .upstream
diff -ru .upstream/package/src vendor/${shortName}/src
rm -rf .upstream
\`\`\`

To re-vendorize (overwrites local changes with the published source of the
version in \`vendor/${shortName}/package.json\`):

\`\`\`bash
npx blocks-vendorize ${packageName} --force
\`\`\`

## Reverting vendorization

To go back to the published package:

\`\`\`bash
rm -rf vendor/${shortName}
\`\`\`

Then remove \`"vendor/${shortName}"\` from the \`workspaces\` array in your
root \`package.json\` and run \`npm update ${packageName}\`.
`;

  writeFileSync(join(destDir, 'VENDORIZE.md'), content);
}
