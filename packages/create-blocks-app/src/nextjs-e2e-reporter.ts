import type { TestEvent } from 'node:test/reporters';

// Keep completion events machine-readable; the parallel TAP reporter preserves diagnostics.
export default async function* (source: AsyncIterable<TestEvent>) {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      yield `${JSON.stringify(event)}\n`;
    }
  }
}
