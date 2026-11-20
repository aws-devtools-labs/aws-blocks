import { createLambdaHandler } from 'aws-cdk-blocks/lambda-handler';

export const handler = createLambdaHandler(() => import('./index.js'));
