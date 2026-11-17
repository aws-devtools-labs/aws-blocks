import { createLambdaHandler } from '@aws-blocks/blocks/lambda-handler';

export const handler = createLambdaHandler(() => import('./index.js'));
