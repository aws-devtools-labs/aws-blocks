# Frequently Asked Questions

## What is Blocks?

Blocks is a fullstack application framework that provides pre-built Building Blocks for common backend needs. It supports authentication, data storage, real-time messaging, background jobs, and knowledge base retrieval out of the box.

## How do I get started with Blocks?

To get started with Blocks, create a new Scope and instantiate the Building Blocks you need. Each Building Block works locally with mock implementations and deploys to AWS in production without code changes.

## What databases does Blocks support?

Blocks supports DynamoDB through KVStore and DistributedTable Building Blocks for NoSQL workloads. For SQL workloads, the Database Building Block provides Aurora Serverless v2 with a Kysely query builder.

## How does authentication work?

Blocks provides the Auth Building Block for authentication: email and password sign-in backed by a Cognito user pool, social sign-in, OIDC and SAML. It includes HTTP-only cookie sessions, email-confirmed signup, and password reset flows.

## Can I use Blocks for real-time features?

Yes, the Realtime Building Block provides typed pub/sub messaging backed by AppSync Events. It supports chat, notifications, live dashboards, and collaborative editing with typed namespaces and schema validation.
