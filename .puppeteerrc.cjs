// Puppeteer is a dev dependency only through md-to-pdf and @mermaid-js/mermaid-cli, which
// scripts/build-tech-design-pdf.mjs uses to render docs locally (fetching them on demand instead is
// tracked in https://github.com/aws-devtools-labs/aws-blocks/issues/989). No CI job launches a browser
// through it (Playwright installs its own), so skip the ~640 MB Chrome download its postinstall
// runs on every `npm ci` in GitHub Actions. Local installs are unchanged.
//
// Puppeteer reads this file from any install below this directory, so the skip is limited to
// installs under the repo's own node_modules (where the lockfile hoists Puppeteer): an app
// scaffolded inside the checkout (the agent bench) still gets its browser. A job that needs
// Puppeteer's Chrome can set PUPPETEER_SKIP_DOWNLOAD=false, which takes precedence over this
// file (the per-browser skip variables do not).
//
// Everywhere else this file exports nothing, so Puppeteer keeps looking and any config a
// developer already has (a home-directory .puppeteerrc, the per-user global config) still applies.
// scripts/ci/puppeteerrc.test.mjs tests both conditions.
const { relative, sep } = require('node:path');

module.exports =
	process.env.GITHUB_ACTIONS === 'true' && relative(__dirname, process.cwd()).split(sep)[0] === 'node_modules'
		? { skipDownload: true }
		: undefined;
