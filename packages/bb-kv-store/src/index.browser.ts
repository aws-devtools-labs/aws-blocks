// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - KVStore runs server-side only. Frontends import this entry
// for the error constants (`isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)`)
// and for the types; the data methods have no browser implementation.
export class KVStore {}
export { KVStoreErrors } from './errors.js';
export type {
	ConditionalDeleteOptions,
	ConditionalWriteOptions,
	DeleteOptions,
	Entry,
	Expiry,
	ExternalKmsKeyRef,
	ExternalTableRef,
	GetOptions,
	IndexConfig,
	KeyConfig,
	KeyOf,
	KVStoreOptions,
	Page,
	PutBatchEntry,
	PutOptions,
	QueryOptions,
	ReadValidationMode,
	Results,
	ScanOptions,
	SortCondition,
	ValueOf,
	Where,
} from './types.js';
