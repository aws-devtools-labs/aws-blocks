# Migrating an existing DistributedTable stack to native GSIs

## Who needs this

Only stacks that were **deployed before** the GSI declaration moved onto the
`AWS::DynamoDB::Table` resource. A brand-new stack does not need this — it takes
the create-time native path with no prior drift. If you have only ever deployed
this table with the current code, skip this document.

## Why

Before this change the Table resource declared **no** GSIs and the retained
custom resource added them out-of-band via `UpdateTable`. So on an old stack:

- CloudFormation's **stored template** for the Table records **zero** GSIs.
- The **live table** physically has the GSIs (created by the custom resource).

After the change the Table resource declares those same GSIs natively. On the
next redeploy of such a stack, CloudFormation compares its stored state (0 GSIs)
against the new template (N GSIs) and plans them as **additions** — it issues
`UpdateTable` to *create* indexes that already exist physically, which DynamoDB
rejects (`ResourceInUseException` / already-exists). The redeploy is not clean.

This was confirmed against a live stack: CloudFormation's own drift detection
reports the Table as `MODIFIED` because its stored template has no GSIs while the
live table has them.

The one-time migration below makes CloudFormation **adopt** the existing indexes
into its stored state, so the stored template matches the live table and no
create is ever planned. It keeps the native-GSI fast path for every future
deploy of the stack, with no index recreation and no data movement.

## Precondition (already met in production)

The Table must carry `DeletionPolicy: Retain` so the import step can remove it
from the stack without deleting the physical table. Production DistributedTable
resolves to `RemovalPolicy.RETAIN` by default, so this precondition holds without
any action. (Sandbox tables are `DESTROY`, but sandbox uses the drop-and-recreate
fast path and is never subject to this drift — do not run this migration against
a sandbox stack.)

Confirm the physical resource id of the Table before starting:

```
aws cloudformation describe-stack-resources \
  --stack-name <your-stack> \
  --logical-resource-id <DistributedTable logical id> \
  --query 'StackResources[0].PhysicalResourceId'
```

## The migration — resolve the drift with an import operation

This follows the AWS-documented procedure for resolving resource drift by
re-importing the resource so CloudFormation adopts its current physical state.
The GSIs are properties of the Table, not standalone resources, so the whole
Table is re-imported; the physical table is never deleted.

### Step 1 — retain and remove the Table from the stack

The Table already has `DeletionPolicy: Retain`. Deploy a template (or use the
console **Stack actions → Import resources into stack** flow) that **removes** the
Table resource. Because of the retain policy, CloudFormation records the removal
as `DELETE_SKIPPED` — the physical table (and its live GSIs) survives, now
unmanaged by the stack.

### Step 2 — re-import the Table with the native GSIs declared

Import the same physical table back into the stack using a template whose Table
resource declares the native GSIs (i.e. the current code's synthesized template).
CloudFormation reads the live table's actual configuration and adopts the
existing indexes into its stored state — **no create, no recreate**. This is the
step that closes the drift.

CLI form (console equivalent under **Stack actions → Import resources into stack**):

```
aws cloudformation create-change-set \
  --stack-name <your-stack> \
  --change-set-name adopt-native-gsis \
  --change-set-type IMPORT \
  --resources-to-import '[{
    "ResourceType": "AWS::DynamoDB::Table",
    "LogicalResourceId": "<DistributedTable logical id>",
    "ResourceIdentifier": { "TableName": "<physical table name>" }
  }]' \
  --template-body file://<synthesized-template-with-native-gsis>.json

aws cloudformation execute-change-set \
  --stack-name <your-stack> \
  --change-set-name adopt-native-gsis
```

### Step 3 — verify

Run drift detection and confirm the Table is `IN_SYNC`:

```
aws cloudformation detect-stack-drift --stack-name <your-stack>
# then, once complete:
aws cloudformation describe-stack-resource-drifts \
  --stack-name <your-stack> \
  --query "StackResourceDrifts[?LogicalResourceId=='<DistributedTable logical id>'].StackResourceDriftStatus"
```

Once `IN_SYNC`, subsequent redeploys use the native path cleanly and this
migration never needs to run again for that stack.

## Multi-index changes on an existing stack

DynamoDB permits only **one** GSI mutation in flight per table. After the
migration above, CloudFormation owns single-index mutations via its own
`UpdateTable`; the retained custom resource converges any residual that exceeds
what one CloudFormation update can express. When a redeploy changes more than one
index at once, expect the change to serialize across the two owners rather than
apply in a single pass — plan multi-index add/remove changes one index per
deploy where practical.
