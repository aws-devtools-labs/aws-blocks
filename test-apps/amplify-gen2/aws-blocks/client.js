// ============================================================
// Blocks Client for Amplify Gen 2
//
// This file configures the Blocks typed client with:
// - API URL from amplify_outputs.json
// - Automatic Cognito token injection via middleware
//
// Usage in your frontend:
//   import { api } from 'aws-blocks';
//   const result = await api.greet('World');
// ============================================================

import { ApiNamespaceClient, registerMiddleware } from '@aws-blocks/blocks/client';
import { fetchAuthSession } from 'aws-amplify/auth';
import outputs from '../amplify_outputs.json';

const BLOCKS_API_URL = outputs.custom?.blocks_api_url;
if (!BLOCKS_API_URL) {
  throw new Error('Blocks API URL not found in amplify_outputs.json. Did you deploy the backend?');
}

// Attach the Cognito access token to every Blocks API call (`Auth` accepts
// access tokens only, never ID tokens).
registerMiddleware({
  async onRequest(req) {
    const session = await fetchAuthSession();
    const token = session.tokens?.accessToken?.toString();
    if (token) req.headers['Authorization'] = `Bearer ${token}`;
    return req;
  }
});

export const api = ApiNamespaceClient('api', { url: BLOCKS_API_URL });
