// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server entry point for the browser-facing data API.
 *
 * Browser code should import `@aws-blocks/bb-data/data-api/client` instead, which
 * carries no server dependencies.
 *
 * @module
 */

export { DataApiErrors } from './errors.js';
export {
	createDataApi,
	type DataApi,
	type DataApiOptions,
	type DataApiUser,
	type RlsCapableDatabase,
} from './server.js';
export {
	DATA_API_OPERATIONS,
	DATA_API_OPERATORS,
	type DataApiOperation,
	type DataApiOperator,
	type QueryDescription,
	type ScalarValue,
	type SerializedFilter,
	type SerializedOrder,
} from './types.js';
export { DEFAULT_MAX_LIMIT, validateQueryDescription, type ValidateOptions } from './validate.js';
