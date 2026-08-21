# __BB_CLASS__

TODO: one-sentence summary of what this Building Block does. (The first sentence
here becomes the block's blurb in the `@aws-blocks/blocks` catalog table.)

**Keywords:** TODO, comma, separated

## API

### `new __BB_CLASS__(scope, id, options?)`

| Option | Type | Notes |
| --- | --- | --- |
| `table` | `ExternalTableRef` | Wrap an existing DynamoDB table (`__BB_CLASS__.fromExisting(name)`). |
| `removalPolicy` | `'destroy' \| 'retain'` | CDK-only. Defaults to the stack preset. |

### Methods

- `get(key): Promise<string | null>` — read a value; `null` when absent.
- `put(key, value): Promise<void>` — write/overwrite a value.
- `delete(key): Promise<void>` — remove a value (no-op if absent).
- `static fromExisting(tableName): ExternalTableRef` — bind to a pre-deployed table.

## Examples

```ts
import { Scope, ApiNamespace } from '@aws-blocks/blocks';
import { __BB_CLASS__ } from '__BB_PKG_NAME__';

const scope = new Scope('my-app');
const store = new __BB_CLASS__(scope, 'store');

export const api = new ApiNamespace(scope, 'api', () => ({
	get: (key: string) => store.get(key),
	put: (key: string, value: string) => store.put(key, value),
}));
```

## Local Development

`npm run dev` uses the in-process mock (an on-disk map under `.bb-data/`). No AWS
account is required. Wipe local state with `rm -rf .bb-data`.
