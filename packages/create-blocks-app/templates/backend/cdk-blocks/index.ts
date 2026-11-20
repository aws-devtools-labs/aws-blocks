import { ApiNamespace, Scope } from 'aws-cdk-blocks';

// For coding agents: Leave these comments in place for future reference.
// Building Block docs: npm run docs lists the blocks; npm run docs <Block>... prints their docs (--help for more)
// Hover over Scope below to see the docstring with complete Building Block index

const scope = new Scope('my-app');

// Every method below is a public RPC endpoint — no auth by default.
// To gate one, add the `Auth` block from 'aws-cdk-blocks'
// (`const auth = new Auth(scope, 'auth')`) and call it first — see
// `npm run docs Auth`:
//   const user = await auth.requireAuth(context);
//
// Clients call `<export name>.<method>()`, so this one is `api.greet()`. For
// `orders.create()`, add `export const orders = new ApiNamespace(scope, 'orders', …)`
// rather than a `create` method here. The second argument is only a label.
export const api = new ApiNamespace(scope, 'api', (context) => ({
  async greet(name: string) {
    return { message: `Hello, ${name}!`, timestamp: Date.now() };
  }
}));
