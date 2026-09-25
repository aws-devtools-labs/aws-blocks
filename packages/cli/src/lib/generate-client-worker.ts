// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker script for generating client code.
 * Usage: node [--conditions=aws-runtime] --import tsx generate-client-worker.js <foundationPath> <outputPath>
 */
import { generateClientCode } from './generate-client.js';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const [foundationPath, outputPath] = process.argv.slice(2);
const code = await generateClientCode(foundationPath);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, code);
