/**
 * Cognito JWT Verifier.
 *
 * Verifies bearer tokens from an external Cognito User Pool.
 * Use this when the client manages its own Cognito session (e.g., Amplify JS,
 * native apps) and the server just needs to validate the incoming JWT.
 *
 * No session store, no sign-in flow, no cookies — pure stateless verification.
 *
 * Implements the `BlocksAuth` contract (the interface the `Auth` block
 * implements), so any drift from that contract is a compile error here, and
 * throws the same error names as `Auth` (`AuthErrors`), so clients can match
 * them with `isBlocksError(e, 'NotAuthenticatedException')`.
 */

import { ApiError, AuthErrors, type BlocksAuth, type BlocksContext } from '@aws-blocks/blocks';
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

/** A string claim, or `undefined` when it is absent or not a string. */
function stringClaim(claims: Record<string, unknown>, name: string): string | undefined {
  const value = claims[name];
  return typeof value === 'string' ? value : undefined;
}

/** A string-array claim (e.g. `cognito:groups`), or `[]` when it is absent or malformed. */
function stringListClaim(claims: Record<string, unknown>, name: string): string[] {
  const value = claims[name];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export class CognitoVerifier implements BlocksAuth {
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
      const claims: Record<string, unknown> = await verifier.verify(token);
      const sub = stringClaim(claims, 'sub');
      if (!sub) return null;
      return {
        userId: sub,
        username: stringClaim(claims, 'cognito:username') || sub,
        sub,
        groups: stringListClaim(claims, 'cognito:groups'),
        email: stringClaim(claims, 'email'),
        claims,
      };
    } catch {
      return null;
    }
  }

  /** Check whether the request has a valid bearer token. */
  async checkAuth(context: BlocksContext): Promise<boolean> {
    return (await this.getCurrentUser(context)) !== null;
  }

  /** Verify the bearer token. Throws 401 `NotAuthenticatedException` if missing or invalid. */
  async requireAuth(context: BlocksContext): Promise<CognitoVerifiedUser> {
    const user = await this.getCurrentUser(context);
    if (!user) {
      throw new ApiError('Unauthorized', 401, { name: AuthErrors.NotAuthenticated });
    }
    return user;
  }

  /**
   * Require the user to be in a specific Cognito group (the token's
   * `cognito:groups` claim). Throws 401 `NotAuthenticatedException` if not
   * signed in, 403 `NotAuthorizedException` if not in the group.
   */
  async requireRole(context: BlocksContext, role: string): Promise<CognitoVerifiedUser> {
    const user = await this.requireAuth(context);
    if (!user.groups.includes(role)) {
      throw new ApiError('Forbidden', 403, { name: AuthErrors.NotAuthorized });
    }
    return user;
  }
}
