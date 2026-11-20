// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The workflows that hold a PR's build and E2E jobs, under .github/workflows/.
// They were one file, pr-checks.yml, split so a failed job can be re-run as
// soon as its own workflow's run finishes. Each starts with the same Detect
// Changes job. The guard tests that check these jobs read every file listed
// here, and e2e-selection.test.mjs checks that the list names every workflow
// that runs scripts/ci/e2e-selection.sh.

export const PR_WORKFLOWS = ['pr-checks.yml', 'pr-e2e.yml', 'pr-e2e-hosting.yml', 'pr-e2e-compute.yml'];
