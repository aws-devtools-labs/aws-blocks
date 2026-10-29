'use client';

import { useEffect } from 'react';

/**
 * Test-only hydration signal for the e2e suite: sets `data-hydrated="true"` on `<html>` once
 * React has hydrated the page.
 *
 * Every interactive control here is server-rendered, so Playwright sees it as visible and
 * clickable before React attaches its handlers. A click or `fill()` that lands in that window
 * is lost. Next exposes no public "hydrated" flag, so the root layout renders this marker and
 * `waitForHydration()` in `test/e2e.test.ts` waits for it.
 *
 * Effects run only after a hydration commit, so the attribute appears once the layout and
 * everything rendered with it are live. That covers each page the tests interact with,
 * because none of them sits behind a `loading.tsx` or `<Suspense>` boundary, which would
 * hydrate in a later pass.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = 'true';
  }, []);
  return null;
}
