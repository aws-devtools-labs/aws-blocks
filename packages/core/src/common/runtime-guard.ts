// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Detect whether the current process is a deployed AWS Lambda execution
 * environment.
 *
 * The Lambda runtime always sets `AWS_LAMBDA_FUNCTION_NAME`, and the managed
 * runtimes additionally set `AWS_EXECUTION_ENV` (e.g. `AWS_Lambda_nodejs22.x`).
 * Either being present is a strong, cheap signal that we are running inside a
 * deployed function rather than a local `npm run dev` / test process.
 */
function isDeployedLambdaRuntime(): boolean {
	return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) || Boolean(process.env.AWS_EXECUTION_ENV);
}

/**
 * Fail closed if a Building Block's MOCK implementation is loaded inside a
 * deployed environment.
 *
 * Building Block packages swap mock <-> real implementations through npm
 * conditional exports: the `aws-runtime` condition selects the real
 * (`index.aws.js`) entry, while the `default` condition falls back to the mock
 * (`index.mock.js`). CDK synth is already protected by
 * {@link assertCdkConditionActive}, but there is no equivalent twin for the
 * `aws-runtime` condition at execution time. If an artifact is bundled WITHOUT
 * `--conditions=aws-runtime`, module resolution silently picks the `default`
 * (mock) entry, and the deployed function would run an in-memory stub — for the
 * auth BBs that means accepting forged/stub sessions instead of real ones.
 *
 * This guard is a no-op locally (`AWS_LAMBDA_FUNCTION_NAME` is unset), so it
 * never interferes with `npm run dev` or the test suite, but throws immediately
 * when a mock is reached in a deployed Lambda.
 *
 * Call it at the earliest safe runtime point of a mock entry (module load or
 * class constructor) so a mis-bundled deploy fails fast at startup.
 *
 * @param bbName - Human-readable Building Block name for the error message
 *   (e.g. `'bb-auth-oidc'`).
 * @throws {Error} when a deployed Lambda runtime is detected.
 */
export function assertNotDeployedMock(bbName: string): void {
	if (!isDeployedLambdaRuntime()) {
		return;
	}

	throw new Error(
		`Mock implementation of ${bbName} loaded in a deployed environment: this artifact ` +
			'was bundled WITHOUT the `aws-runtime` export condition, so module resolution fell ' +
			'back to the mock (`default`) entry instead of the real AWS runtime. A deployed mock ' +
			'would serve in-memory stub behavior (for auth BBs, this means accepting forged/stub ' +
			'sessions).\n\n' +
			'Fix: bundle the backend with the `aws-runtime` condition so conditional exports ' +
			'resolve the real implementation:\n' +
			'  esbuild --conditions=aws-runtime ...\n' +
			'  (or set `conditions: ["aws-runtime", "node"]` in your esbuild build() options)\n\n' +
			'See the "export conditions" guidance in docs/guides/extending-with-existing-aws-resources.md.',
	);
}
