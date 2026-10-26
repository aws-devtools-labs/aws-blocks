// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AwsCredentialIdentity } from '@smithy/types';
import { REGION_CODE } from './deployment-target.js';

/**
 * Pre-deploy CDK bootstrap check. For internal use only.
 *
 * CDK deploys through resources that `cdk bootstrap` creates once per account and
 * Region. In an account and Region that were never bootstrapped, `cdk deploy`
 * fails only after synthesis and the asset builds, with
 * `SSM parameter /cdk-bootstrap/<qualifier>/version not found`. Reading that
 * parameter before the deploy turns it into an immediate message with the command
 * that bootstraps this account and Region.
 *
 * Only a missing parameter stops the deploy. Any other result, such as a denied
 * read, a network error or a timeout, is inconclusive and the deploy continues:
 * CDK reads the parameter with its bootstrap roles, so credentials that cannot
 * read it may still deploy.
 *
 * The check never bootstraps. Bootstrapping creates IAM roles and other resources
 * in the account, which is the user's decision.
 */

/** The qualifier of the default stack synthesizer (`DefaultStackSynthesizer.DEFAULT_QUALIFIER` in aws-cdk-lib). */
export const DEFAULT_BOOTSTRAP_QUALIFIER = 'hnb659fds';

/** The qualifiers that the bootstrap template accepts. */
const QUALIFIER = /^[A-Za-z0-9_-]{1,10}$/;

const ACCOUNT_ID = /^\d{12}$/;

const BOOTSTRAP_DOCS_URL = 'https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html';

/** Where to read the bootstrap version parameter, with the credentials that the credential check verified. */
export interface BootstrapTarget {
	region: string;
	/** The profile passed to the SDK client, if any. */
	profile?: string;
	credentials: AwsCredentialIdentity;
}

/**
 * Read the SSM parameter `name` in the target Region. Rejects with the SDK error,
 * whose `name` is `ParameterNotFound` when the parameter does not exist.
 * Injectable so tests send no requests.
 */
export type BootstrapVersionReader = (target: BootstrapTarget, name: string) => Promise<unknown>;

/** Default reader: SSM GetParameter, with one attempt and short timeouts. */
export const sdkBootstrapVersionReader: BootstrapVersionReader = async ({ region, profile, credentials }, Name) => {
	// Loaded on demand, like the STS client, so that the dev server and mock tests never load it.
	const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
	const client = new SSMClient({
		region,
		profile,
		credentials,
		maxAttempts: 1,
		// Without throwOnRequestTimeout the handler only logs a warning when the request times out.
		requestHandler: { connectionTimeout: 1000, requestTimeout: 2000, throwOnRequestTimeout: true },
	});
	try {
		return await client.send(new GetParameterCommand({ Name }));
	} finally {
		client.destroy();
	}
};

/** Input for {@link cdkBootstrapFailure}. */
export interface CdkBootstrapCheckOptions extends BootstrapTarget {
	/** The npm script name, used in the message (for example `sandbox` or `deploy`). */
	command: string;
	/** The account ID from STS GetCallerIdentity. */
	account: string;
	/** The `@aws-cdk/core:bootstrapQualifier` context value; the default qualifier when unset. */
	qualifier?: string;
	read?: BootstrapVersionReader;
}

/**
 * Check that CDK has been bootstrapped in the account and Region. Resolves to the
 * message for the user when the bootstrap version parameter does not exist, and to
 * `undefined` when it exists or the check is inconclusive. Never rejects.
 *
 * The printed command passes `--app=` so that `cdk bootstrap` does not synthesize
 * the app in `cdk.json` to find environments: the command names the environment.
 * Run in the project directory, CDK still reads the profile and the bootstrap
 * qualifier from `cdk.json`.
 */
export async function cdkBootstrapFailure({
	command,
	account,
	region,
	profile,
	credentials,
	qualifier = DEFAULT_BOOTSTRAP_QUALIFIER,
	read = sdkBootstrapVersionReader,
}: CdkBootstrapCheckOptions): Promise<string | undefined> {
	// CDK rejects a qualifier that the template does not accept; leave that error to CDK.
	if (!QUALIFIER.test(qualifier)) return undefined;
	const parameterName = `/cdk-bootstrap/${qualifier}/version`;
	try {
		await read({ region, profile, credentials }, parameterName);
		return undefined;
	} catch (error) {
		if (!(error instanceof Error) || error.name !== 'ParameterNotFound') return undefined;
	}
	const accountArg = ACCOUNT_ID.test(account) ? account : '<account-id>';
	const regionArg = REGION_CODE.test(region) ? region : '<region>';
	return [
		`CDK is not bootstrapped in Region ${regionArg} of account ${accountArg}, so \`npm run ${command}\` cannot deploy there ` +
			`(SSM parameter ${parameterName} not found).`,
		'  Bootstrap once per account and Region. From this project directory, run:',
		`    npx cdk bootstrap aws://${accountArg}/${regionArg} --app=`,
		'  This creates the CDKToolkit CloudFormation stack: the S3 bucket, ECR repository and IAM roles that CDK deploys with.',
		...(qualifier === DEFAULT_BOOTSTRAP_QUALIFIER
			? [
					'  If the app sets a custom bootstrap qualifier in code, set the same value as',
					'  "@aws-cdk/core:bootstrapQualifier" in the cdk.json context, so that this check reads it.',
				]
			: []),
		`  See ${BOOTSTRAP_DOCS_URL}`,
		`Then re-run \`npm run ${command}\`.`,
	].join('\n');
}
