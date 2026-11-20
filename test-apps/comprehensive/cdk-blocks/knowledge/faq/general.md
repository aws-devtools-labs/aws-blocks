# Frequently Asked Questions

## What is AWS CDK Blocks?

CDK Blocks is a fullstack application framework that provides pre-built Building Blocks for common backend needs. It supports authentication, data storage, real-time messaging, background jobs, and knowledge base retrieval out of the box.

## How do I get started with CDK Blocks?

To get started with CDK Blocks, create a new Scope and instantiate the Building Blocks you need. Each Building Block works locally with mock implementations and deploys to AWS in production without code changes.

## What databases does CDK Blocks support?

CDK Blocks supports DynamoDB through the KVStore Building Block for NoSQL workloads: a string-keyed store with no options, or records with a schema, a declared key, and indexes. For SQL workloads, the Database Building Block provides PostgreSQL on Aurora DSQL or Aurora PostgreSQL Serverless v2, with a Kysely dialect.

## How does authentication work?

CDK Blocks provides the Auth Building Block for authentication: email and password sign-in backed by a Cognito user pool, social sign-in, OIDC and SAML. It includes HTTP-only cookie sessions, email-confirmed signup, and password reset flows.

## Can I use CDK Blocks for real-time features?

Yes, the Realtime Building Block provides typed pub/sub messaging backed by AppSync Events. It supports chat, notifications, live dashboards, and collaborative editing with typed namespaces and schema validation.
