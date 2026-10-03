// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { openConsole, parseStageArg } from '@aws-blocks/blocks/scripts';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Stage-driven, like the scaffolded templates: no argument means the sandbox.
// `projectRoot` is passed for the same reason they pass it — the project root is
// this file's location, not the caller's cwd, so the script resolves the right
// project when it is not run through `npm run` from the app directory.
openConsole({
  projectRoot: join(__dirname, '..', '..'),
  stage: parseStageArg(process.argv.slice(2)),
});
