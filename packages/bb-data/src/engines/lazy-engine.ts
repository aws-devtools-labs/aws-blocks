// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';

/**
 * A {@link DatabaseEngine} whose real backing engine is produced asynchronously.
 *
 * This exists for the local-dev `extensions` option: the extension-loaded
 * {@link PGliteEngine} is built via dynamic `import()` (see
 * {@link PGliteEngine.create}), which the synchronous `Database` constructor
 * cannot await. Rather than install a throwaway placeholder engine and then
 * swap `Database.base` (which `crud()` captures synchronously and would freeze
 * to the discarded placeholder), the constructor installs ONE stable
 * `LazyEngine` and every data path — `query`, `crud()`, `withRLS()`,
 * `migrationsPath` — routes through it. Each engine method awaits the factory
 * once (the resolved engine is cached), so callers never observe the pre-resolve
 * state and the real engine is never recreated or discarded.
 *
 * The factory is invoked lazily on first use and memoized, so a `Database` that
 * declares extensions but is never queried never resolves (nor imports) the
 * extension packages — and a factory rejection surfaces on the first database
 * interaction with its original, actionable message.
 */
export class LazyEngine implements DatabaseEngine {
  private resolved: Promise<DatabaseEngine> | null = null;

  /**
   * @param factory - produces the real engine; invoked at most once (memoized,
   *   including its rejection) on the first engine call.
   */
  constructor(private readonly factory: () => Promise<DatabaseEngine>) {}

  /** Resolve (once) and cache the backing engine. */
  private engine(): Promise<DatabaseEngine> {
    if (!this.resolved) {
      this.resolved = this.factory();
    }
    return this.resolved;
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return (await this.engine()).query<T>(sql, params);
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    return (await this.engine()).execute(sql, params);
  }

  async beginTransaction(): Promise<TransactionHandle> {
    return (await this.engine()).beginTransaction();
  }

  async commitTransaction(handle: TransactionHandle): Promise<void> {
    return (await this.engine()).commitTransaction(handle);
  }

  async rollbackTransaction(handle: TransactionHandle): Promise<void> {
    return (await this.engine()).rollbackTransaction(handle);
  }

  async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
    return (await this.engine()).queryInTransaction<T>(handle, sql, params);
  }

  async executeInTransaction(
    handle: TransactionHandle,
    sql: string,
    params?: unknown[],
  ): Promise<{ rowCount: number }> {
    return (await this.engine()).executeInTransaction(handle, sql, params);
  }

  async destroy(): Promise<void> {
    // Only tear down if the engine was actually resolved; a Database that
    // declared extensions but was never used has nothing to close.
    if (this.resolved) {
      await (await this.resolved).destroy();
    }
  }
}
