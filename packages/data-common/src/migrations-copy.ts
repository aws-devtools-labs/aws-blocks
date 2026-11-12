// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** `p` as one POSIX shell word: single-quoted, so `"`, `$`, backticks and spaces stay literal. */
function shellQuote(p: string): string {
  return `'${p.replaceAll("'", "'\\''")}'`;
}

/** The bundling hook's `sh` command that copies the migrations directory `from` to `to`. */
export function copyMigrationsCommand(from: string, to: string): string {
  return `cp -r ${shellQuote(from)} ${shellQuote(to)}`;
}
