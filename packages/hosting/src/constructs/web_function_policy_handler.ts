/**
 * Custom-resource Lambda that owns the resource-based policy of a Lambda Web
 * Function.
 *
 * Why a custom resource: a Web Function's resource-based policy is managed with
 * the `lambda-web` `PutResourcePolicy` / `DeleteResourcePolicy` APIs, and
 * CloudFormation has no resource type for it (`AWS::Lambda::ResourcePolicy` and
 * `AWS::Lambda::Permission` only accept classic function ARNs). The policy is
 * what lets the CloudFront distribution (via OAC) invoke an `IamAuth` endpoint,
 * so without it every origin request is a 403.
 *
 * A Web Function has exactly ONE resource-based policy; `PutResourcePolicy`
 * replaces it wholesale. This resource is therefore the single owner of that
 * document — the construct renders the complete policy and Create/Update put it
 * verbatim, Delete removes it.
 *
 * Bundling: pre-bundled at BUILD time via `scripts/bundle-handlers.mjs`
 * (esbuild → `web_function_policy_handler_bundle.mjs`) because
 * `@aws-sdk/client-lambda-web` is NOT in the Lambda Node.js runtime baseline.
 * See `kv_keys_handler.ts` for why synth-time `NodejsFunction` bundling is not
 * used.
 */
import {
  DeleteResourcePolicyCommand,
  LambdaWebClient,
  PutResourcePolicyCommand,
} from '@aws-sdk/client-lambda-web';

type Event = {
  RequestType: 'Create' | 'Update' | 'Delete';
  PhysicalResourceId?: string;
  ResourceProperties: {
    /** ARN of the Web Function (`arn:…:web-function/<name>`). */
    FunctionArn: string;
    /** The full resource-based policy document, as a JSON string. */
    Policy: string;
  };
};

const client = new LambdaWebClient({});

/** True when the error is the SDK's "resource does not exist" error. */
export function isNotFound(err: unknown): boolean {
  return (err as { name?: unknown } | undefined)?.name === 'ResourceNotFoundException';
}

export const handler = async (event: Event): Promise<{ PhysicalResourceId: string }> => {
  const { FunctionArn: resourceArn, Policy: policy } = event.ResourceProperties;
  // One policy per function → the function ARN is a stable physical id. A
  // changed ARN (function replaced) yields a new id, so CloudFormation issues a
  // Delete for the old function's policy after the Create for the new one.
  const physicalResourceId = `${resourceArn}/resource-policy`;

  if (event.RequestType === 'Delete') {
    try {
      await client.send(new DeleteResourcePolicyCommand({ resourceArn }));
    } catch (err) {
      // The function (and its policy) may already be gone — e.g. the stack is
      // being torn down and the Web Function was deleted first.
      if (!isNotFound(err)) throw err;
    }
    return { PhysicalResourceId: event.PhysicalResourceId ?? physicalResourceId };
  }

  await client.send(new PutResourcePolicyCommand({ resourceArn, policy }));
  return { PhysicalResourceId: physicalResourceId };
};
