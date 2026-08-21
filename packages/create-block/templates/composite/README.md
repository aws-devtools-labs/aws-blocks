# __BB_CLASS__

TODO: one-sentence summary of what this Building Block does. (The first sentence
becomes the block's blurb in the `@aws-blocks/blocks` catalog table.)

**Keywords:** TODO, comma, separated

This is a **composite** block: it composes other Building Blocks (a `KVStore` for
storage in the generated skeleton) and owns no infrastructure of its own.

## API

### `new __BB_CLASS__(scope, id, options?)`

### Methods

- `set(key, value): Promise<void>` — store a value.
- `read(key): Promise<string | null>` — read a value; `null` when absent.

## Examples

```ts
import { Scope, ApiNamespace } from '@aws-blocks/blocks';
import { __BB_CLASS__ } from '__BB_PKG_NAME__';

const scope = new Scope('my-app');
const thing = new __BB_CLASS__(scope, 'thing');

export const api = new ApiNamespace(scope, 'api', () => ({
	set: (key: string, value: string) => thing.set(key, value),
	read: (key: string) => thing.read(key),
}));
```

## Local Development

`npm run dev` runs entirely on the composed blocks' mocks (on-disk under
`.bb-data/`). No AWS account required. Wipe local state with `rm -rf .bb-data`.
