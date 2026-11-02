// Import backend APIs directly - fully type-safe
import { api } from 'aws-blocks';
import { StatusMessage } from '@aws-blocks/blocks/ui';
import { html, render } from 'lit-html';

// Backend APIs are defined in aws-blocks/index.ts
// Full docs: node_modules/@aws-blocks/blocks/README.md

async function main() {
  let result: Awaited<ReturnType<typeof api.greet>>;
  try {
    result = await api.greet("World");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = StatusMessage({ kind: 'error', text: `Could not greet: ${message}`, testId: 'greet-status' });
    document.getElementById('app')!.replaceChildren(status.element);
    return;
  }

  render(html`
    <div>
      <h1>Blocks App</h1>
      <p>${result.message}</p>
      <p>Timestamp: ${new Date(result.timestamp).toLocaleString()}</p>
    </div>
  `, document.getElementById('app')!);
}

main();
