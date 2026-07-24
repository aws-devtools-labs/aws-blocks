/**
 * Cognito JWT Verifier.
 *
 * Verifies bearer tokens from an external Cognito User Pool.
 * Use this when the client manages its own Cognito session (e.g., Amplify JS,
 * native apps) and the server just needs to validate the incoming JWT.
 *
 * No session store, no sign-in flow, no cookies — pure stateless verification.
 */

import { ApiError, type BlocksContext } from '@aws-blocks/blocks';
import { CognitoJwtVerifier } from 'aws-jwt-verify';

type CognitoVerifierInstance = ReturnType<typeof CognitoJwtVerifier.create>;

export interface CognitoVerifierOptions {
  /** Cognito User Pool ID (e.g., 'us-east-1_abc123'). */
  userPoolId: string;
  /** Cognito User Pool Client ID. */
  clientId: string;
  /** Which token to verify. Defaults to 'id'. */
  tokenUse?: 'id' | 'access';
}

export interface CognitoVerifiedUser {
  userId: string;
  username: string;
  /** Cognito user sub (unique identifier). */
  sub: string;
  /** Cognito groups the user belongs to. */
  groups: string[];
  /** Email if present in claims. */
  email?: string;
  /** All token claims. */
  claims: Record<string, unknown>;
}

export class CognitoVerifier {
  private options: CognitoVerifierOptions;
  private verifier: CognitoVerifierInstance | null = null;

  constructor(options: CognitoVerifierOptions) {
    this.options = options;
  }

  private async getVerifier() {
    if (!this.verifier) {
      this.verifier = CognitoJwtVerifier.create({
        userPoolId: this.options.userPoolId,
        clientId: this.options.clientId,
        tokenUse: this.options.tokenUse || 'id',
      });
    }
    return this.verifier;
  }

  private extractToken(context: BlocksContext): string | null {
    const authHeader = context.request.headers.get('authorization') ||
                       context.request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return null;
    return authHeader.slice(7);
  }

  /** Get the current user from the bearer token, or null if missing/invalid. */
  async getCurrentUser(context: BlocksContext): Promise<CognitoVerifiedUser | null> {
    const token = this.extractToken(context);
    if (!token) return null;

    try {
      const verifier = await this.getVerifier();
      const payload = await verifier.verify(token) as Record<string, unknown>;
      return {
        userId: payload.sub as string,
        username: (payload['cognito:username'] as string) || (payload.sub as string),
        sub: payload.sub as string,
        groups: (payload['cognito:groups'] as string[]) || [],
        email: payload.email as string | undefined,
        claims: payload,
      };
    } catch {
      return null;
    }
  }

  /** Check whether the request has a valid bearer token. */
  async checkAuth(context: BlocksContext): Promise<boolean> {
    return (await this.getCurrentUser(context)) !== null;
  }

  /** Verify the bearer token. Throws 401 if missing or invalid. */
  async requireAuth(context: BlocksContext): Promise<CognitoVerifiedUser> {
    const user = await this.getCurrentUser(context);
    if (!user) {
      throw new ApiError('Unauthorized', 401);
    }
    return user;
  }

  /** Require the user to be in a specific Cognito group. Throws 403 if not. */
  async requireGroup(context: BlocksContext, group: string): Promise<CognitoVerifiedUser> {
    const user = await this.requireAuth(context);
    if (!user.groups.includes(group)) {
      throw new ApiError('Forbidden', 403);
    }
    return user;
  }
}
