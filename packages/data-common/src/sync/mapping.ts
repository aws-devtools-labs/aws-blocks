// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Column ↔ field name mapping for `columnMapping`. Browser-safe. */

export type ColumnMapping = 'snakeCamel' | undefined;

/** `owner_id` → `ownerId`. */
export const snakeToCamel = (name: string): string => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** `ownerId` → `owner_id`. */
export const camelToSnake = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const columnToField = (column: string, mapping: ColumnMapping): string =>
  mapping === 'snakeCamel' ? snakeToCamel(column) : column;

export const fieldToColumn = (field: string, mapping: ColumnMapping): string =>
  mapping === 'snakeCamel' ? camelToSnake(field) : field;

/** A row with its column names mapped to field names. Returns the same object when there is no mapping. */
export function mapRow<R extends Record<string, unknown>>(row: R, mapping: ColumnMapping): R {
  if (!mapping) return row;
  const mapped: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) mapped[columnToField(column, mapping)] = value;
  return mapped as R;
}
