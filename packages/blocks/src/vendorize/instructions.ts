// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Write a VENDORIZE.md file with migration instructions into the vendor directory. */
export function writeMigrationInstructions(destDir: string, packageName: string, shortName: string): void {
  const content = `# Vendorized: ${packageName}

This package was ejected from \`${packageName}\` into your local project.
Your imports remain unchanged — the local workspace takes priority over the
registry version via npm workspace resolution.

## What happened

- Source copied to \`vendor/${shortName}/src/\`
- \`package.json\` generated with exports remapped from \`dist/\` to \`src/\`
- \`vendor/${shortName}\` added to your root \`workspaces\` array
- \`npm install\` re-linked workspaces

## Making changes

Edit files in \`vendor/${shortName}/src/\` directly. Changes take effect
immediately when using \`tsx\` (the default AWS CDK Blocks dev server and CDK synth).

## Updating from upstream

When a new version of \`${packageName}\` is published, you can compare
your vendorized source against the upstream:

\`\`\`bash
# View upstream source for comparison
npx -y -p ${packageName}@latest node -e "console.log(require('path').dirname(require.resolve('${packageName}/package.json')))"
\`\`\`

To re-vendorize (overwrites local changes):

\`\`\`bash
npm run vendorize ${packageName} -- --force
\`\`\`

## Reverting vendorization

To go back to the published package:

\`\`\`bash
rm -rf vendor/${shortName}
\`\`\`

Then remove \`"vendor/${shortName}"\` from the \`workspaces\` array in your
root \`package.json\` and run \`npm install\`.
`;

  writeFileSync(join(destDir, 'VENDORIZE.md'), content);
}
