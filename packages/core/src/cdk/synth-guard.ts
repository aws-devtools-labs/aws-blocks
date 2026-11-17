// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Throws an actionable error when a runtime-only method is called during CDK synth.
 *
 * Under `--conditions=cdk` Building Block modules resolve to their CDK construct,
 * which only provisions infrastructure. Data/runtime methods live in the runtime
 * build. Calling them at module top-level (which runs during synth) would otherwise
 * fail with a cryptic `X is not a function` TypeError; this utility turns that into
 * an actionable message directing the user to the correct execution context.
 *
 * @param className - The Building Block class name (e.g. "KVStore", "FileBucket")
 * @param method - The method that was called (e.g. "get", "put")
 */
export function synthGuard(className: string, method: string): never {
	throw new Error(
		`${className}.${method}() cannot be called during CDK synth. ` +
		`Data methods run at request time — call them inside an ApiNamespace method, ` +
		`RawRoute handler, job handler, or a runtime script (run with --conditions=aws-runtime), ` +
		`not at the top level of your backend module.`,
	);
}
