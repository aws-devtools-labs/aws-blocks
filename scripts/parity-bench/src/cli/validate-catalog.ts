// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// parity validate-catalog — fail (exit 1) if the bundled catalog breaks a structural rule (see ../core/catalog.ts).

import { validateCatalog } from '../core/catalog.js';
import { PACK_IDS, PARITY_CASES } from '../packs/catalog.js';

const problems = validateCatalog(PARITY_CASES, PACK_IDS);
for (const p of problems) console.error(`${p.caseId}: ${p.problem}`);
const sliders = PARITY_CASES.filter((c) => c.sweep).length;
console.log(`${PARITY_CASES.length} cases (${sliders} sliders), ${problems.length} problem(s)`);
process.exit(problems.length ? 1 : 0);
