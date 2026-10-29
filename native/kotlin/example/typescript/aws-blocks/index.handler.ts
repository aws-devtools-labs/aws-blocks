import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';

// Lazy import: the handler loads its injected configuration before the backend
// module (and the Building Blocks it constructs) is evaluated.
export const handler = createLambdaHandler(() => import('./index.js'));