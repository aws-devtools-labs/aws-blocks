// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
// Installed as /opt/playwright/index.mjs: the image's Playwright with its preinstalled Chromium,
// for the verifier and for any user, with no environment setup. Playwright reads the browser
// directory once, while its registry module loads, so the variable is set only around that import
// and restored afterwards; child processes and later `playwright install` runs keep their default.
const previous = process.env.PLAYWRIGHT_BROWSERS_PATH;
process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/playwright/browsers';
let playwright;
try {
	playwright = await import('/opt/playwright/node_modules/playwright/index.mjs');
} finally {
	if (previous === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
	else process.env.PLAYWRIGHT_BROWSERS_PATH = previous;
}
export const { chromium, firefox, webkit, devices, errors, request, selectors } = playwright;
export default playwright.default;
