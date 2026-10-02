// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * React binding for live shapes. Browser-safe; needs `react` 18 or later.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DependencyList } from 'react';
import type { Shape } from './types.js';

/** What {@link useShape} returns. */
export interface UseShapeResult<T> {
  /** The current rows. Empty until the shape has loaded. */
  rows: readonly T[];
  /** The live shape, for `get()` and `requestSnapshot()`. `null` until the API call returns. */
  shape: Shape<T> | null;
  /** `true` until the initial rows have arrived. */
  isLoading: boolean;
  /** The error from the API call or the initial sync, if any. */
  error: Error | null;
}

const EMPTY: readonly never[] = [];
const noSubscribe = () => () => {};
const noSnapshot = () => EMPTY;

/**
 * Open a shape with `open` (usually an API method that returns one), keep the
 * component in sync with its rows, and close it when `deps` change or the
 * component unmounts.
 *
 * @example
 * const { rows, isLoading } = useShape(() => api.todos(), []);
 *
 * // Re-opens when the board changes; the previous shape is closed.
 * const { rows: cards, shape } = useShape(() => api.boardCards(boardId), [boardId]);
 */
export function useShape<T>(open: () => Promise<Shape<T>>, deps: DependencyList): UseShapeResult<T> {
  const [shape, setShape] = useState<Shape<T> | null>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let cancelled = false;
    let current: Shape<T> | null = null;
    setShape(null);
    setLoading(true);
    setError(null);
    openRef
      .current()
      .then(async (opened) => {
        if (cancelled) {
          opened.close();
          return;
        }
        current = opened;
        setShape(opened);
        await opened.ready;
        if (!cancelled) setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      current?.close();
    };
    // `open` is read through a ref: callers pass a new closure on every render.
    // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  }, deps);

  const rows = useSyncExternalStore(
    shape ? shape.subscribe : noSubscribe,
    shape ? shape.getSnapshot : (noSnapshot as () => readonly T[]),
    shape ? shape.getSnapshot : (noSnapshot as () => readonly T[]),
  );
  return { rows, shape, isLoading, error };
}
