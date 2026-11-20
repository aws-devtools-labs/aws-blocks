// Import backend APIs directly - fully type-safe
import { api } from 'cdk-blocks';
import { html, render } from 'lit-html';

// Backend APIs are defined in cdk-blocks/index.ts
// Building Block docs: npm run docs lists the blocks; npm run docs <Block>... prints their docs (--help for more)

async function main() {
  const result = await api.greet("World");
  
  render(html`
    <div>
      <h1>CDK Blocks App</h1>
      <p>${result.message}</p>
      <p>Timestamp: ${new Date(result.timestamp).toLocaleString()}</p>
    </div>
  `, document.getElementById('app')!);
}

main();
