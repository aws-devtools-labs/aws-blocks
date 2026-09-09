/**
 * Regenerates aws-blocks/client.js from the backend exports.
 *
 * Run: npm run blocks:generate-client
 *
 * Uses generateClientCode() to discover ApiNamespace exports,
 * then injects the Amplify auth middleware and URL configuration.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { generateClientCode } from '@aws-blocks/blocks/scripts';

const awsBlocksDir = resolve(dirname(new URL(import.meta.url).pathname), '..');
const foundationPath = join(awsBlocksDir, 'index.ts');
const clientPath = join(awsBlocksDir, 'client.js');

// Generate the standard client code (namespace discovery + proxy exports)
let code = await generateClientCode(foundationPath);

// Inject URL option into all ApiNamespaceClient calls
// Standard: __BLOCKS_ApiNamespaceClient__('name')
// Amplify:  __BLOCKS_ApiNamespaceClient__('name', { url: BLOCKS_API_URL })
code = code.replace(
	/__BLOCKS_ApiNamespaceClient__\('([^']+)'\)/g,
	"__BLOCKS_ApiNamespaceClient__('$1', { url: BLOCKS_API_URL })",
);

// Replace the auto-generated header and imports with Amplify-specific preamble
const importLine = "import { ApiNamespaceClient as __BLOCKS_ApiNamespaceClient__ } from '@aws-blocks/blocks/client';";
const codeFromImports = code.slice(code.indexOf(importLine));

const preamble = `// ============================================================
// AUTO-GENERATED FILE — DO NOT EDIT
//
// Regenerate with: npm run blocks:generate-client
// ============================================================

import { fetchAuthSession } from 'aws-amplify/auth';
import { registerMiddleware } from '@aws-blocks/blocks/client';
import outputs from '../amplify_outputs.json';

const BLOCKS_API_URL = outputs.custom?.blocks_api_url;
if (!BLOCKS_API_URL) {
  throw new Error('Blocks API URL not found in amplify_outputs.json. Did you deploy the backend?');
}

// Attach Cognito bearer token to every Blocks API call
registerMiddleware({
  async onRequest(req) {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (token) req.headers['Authorization'] = \`Bearer \${token}\`;
    return req;
  }
});

`;

mkdirSync(dirname(clientPath), { recursive: true });
writeFileSync(clientPath, preamble + codeFromImports);
console.log(`✅ Generated ${clientPath}`);
