// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
export declare const MARKER: string;
export declare function roundTrip(): Promise<{ wrote: boolean; read: unknown }>;
export declare function dbRoundTrip(): Promise<{ latest: unknown; count: number }>;
