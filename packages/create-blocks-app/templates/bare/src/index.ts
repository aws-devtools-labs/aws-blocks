// Import backend APIs directly - fully type-safe
import { api } from 'aws-blocks';
import { html, render } from 'lit-html';

// Backend APIs are defined in aws-blocks/index.ts
// Building Block docs: npx --no -- cdk-blocks docs lists the blocks; npx --no -- cdk-blocks docs <Block>... prints their docs (--help for more)

async function main() {
  const result = await api.greet("World");
  
  render(html`
    <div>
      <h1>Blocks App</h1>
      <p>${result.message}</p>
      <p>Timestamp: ${new Date(result.timestamp).toLocaleString()}</p>
    </div>
  `, document.getElementById('app')!);
}

main();
