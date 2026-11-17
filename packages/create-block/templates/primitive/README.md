# __BB_CLASS__

TODO: one-sentence summary of what this Building Block does. (The first sentence
becomes the block's blurb in the `@aws-blocks/blocks` catalog table.)

**Keywords:** TODO, comma, separated

A **primitive** block: it provisions and owns its own AWS infrastructure. The
generated code is a storage-agnostic `Scope` skeleton with one example method —
replace it with your block's real API and infrastructure. See `bb-kv-store` for a
worked key/value example, `bb-file-bucket` for object storage.

## API

### `new __BB_CLASS__(scope, id, options?)`

| Option | Type | Notes |
| --- | --- | --- |
| `label` | `string` | TODO — replace with your real options. |

### Methods

- `echo(input): Promise<string>` — TODO: replace with your block's methods.

## Examples

```ts
import { Scope, ApiNamespace } from '@aws-blocks/blocks';
import { __BB_CLASS__ } from '__BB_PKG_NAME__';

const scope = new Scope('my-app');
const thing = new __BB_CLASS__(scope, 'thing');

export const api = new ApiNamespace(scope, 'api', () => ({
	echo: (input: string) => thing.echo(input),
}));
```

## Local Development

`npm run dev` runs the mock entry (`index.mock.ts`) — no AWS account required.
Implement local state there (in-memory or on-disk under `.bb-data/`). Wipe local
state with `rm -rf .bb-data`.
