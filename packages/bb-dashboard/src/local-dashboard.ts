// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { escapeHtml } from '@aws-cdk-blocks/core/bb-utils';
import type { DashboardOptions } from './types.js';

/** Local-only view. Never read log payloads, trace files, or cloud credentials on this public route. */
export function renderLocalDashboard(title: string, options?: DashboardOptions): string {
	const sources = options?.metrics;
	const metrics = (Array.isArray(sources) ? sources : sources ? [sources] : [])
		.map(({ metrics, metricConfigs }) => {
			const names = (metricConfigs ?? []).map(({ name }) => `<li><code>${escapeHtml(name)}</code></li>`).join('');
			return names ? `<h3>${escapeHtml(metrics.namespace)}</h3><ul>${names}</ul>` : '';
		})
		.join('');

	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Local dashboard</title>
<style>:root{color-scheme:light dark}body{font:1rem/1.6 system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem}section{margin:2rem 0}pre{overflow:auto}</style>
</head><body><main>
<p>CDK Blocks · Local dashboard</p><h1>${escapeHtml(title)}</h1>
<p>The dev server is running. CloudWatch charts are available after deployment; this view does not connect to AWS.</p>
${options?.logs === false ? '' : '<section><h2>Logs</h2><p>Read structured log entries in the terminal running the dev server.</p></section>'}
<section><h2>Metrics</h2><p>The Metrics block writes EMF records to the dev server terminal.</p>${metrics}</section>
${options?.traces === false ? '' : '<section><h2>Traces</h2><p>If your app uses Tracer, find its local traces in <code>.cdk-blocks/local/data/&lt;tracer-fullId&gt;/traces.json</code>.</p></section>'}
<section><h2>Explore the app</h2><p>To browse local block data in the Admin UI, run this in a second terminal from the app directory:</p>
<pre><code>node --input-type=module -e "import { dashboard } from 'aws-cdk-blocks/scripts'; await dashboard()"</code></pre>
<p>Open the session URL it prints. No AWS credentials or deployment are required.</p></section>
</main></body></html>`;
}
