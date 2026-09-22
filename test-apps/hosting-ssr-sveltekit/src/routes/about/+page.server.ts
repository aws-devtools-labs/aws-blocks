import type { PageServerLoad } from './$types';

// Prerendered (SSG): built to static HTML and served frozen from S3.
//
// The timestamp is computed in a SERVER load — it runs ONLY on the server (at
// build time for a prerendered page) and its return value is serialized into
// the built HTML, never recomputed in the browser. A *universal* load
// (`+page.ts`) would re-run during client hydration and recompute `new Date()`,
// making a genuinely-frozen page LOOK dynamic (the DOM text changes on reload);
// a component-<script> `new Date()` has the same defect. Server load is the only
// place that stays truly frozen.
export const prerender = true;

export const load: PageServerLoad = () => {
  return { buildTimestamp: new Date().toISOString() };
};
