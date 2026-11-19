# __BB_CLASS__

TODO: one-sentence summary of what this Building Block does. (The first sentence
becomes the block's blurb in the `aws-cdk-blocks` catalog table.)

**Keywords:** TODO, comma, separated

TODO: delete this paragraph. A **primitive** block provisions and owns its own
AWS infrastructure. The generated code is a storage-agnostic `Scope` skeleton
with one example method: replace it with your block's real API and
infrastructure. See `bb-kv-store` for a worked key/value example,
`bb-file-bucket` for object storage.

## API

### `new __BB_CLASS__(scope, id, options?)`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `label` | `string` | TODO | TODO — replace with your real options. |

### Methods

- `echo(input): Promise<string>` — TODO: replace with your block's methods.

## Errors

Match an error with `isBlocksError(e, __BB_CLASS__Errors.<Constant>)`.

| Constant | `error.name` | Thrown when |
| --- | --- | --- |
| `InvalidInput` | `InvalidInputException` | TODO — one row per entry of `src/errors.ts`. |

## Examples

```ts
import { Scope, ApiNamespace } from 'aws-cdk-blocks';
import { __BB_CLASS__ } from '__BB_PKG_NAME__';

const scope = new Scope('my-app');
const thing = new __BB_CLASS__(scope, 'thing');

export const api = new ApiNamespace(scope, 'api', () => ({
	echo: (input: string) => thing.echo(input),
}));
```

## Local Development

`npm run dev` runs the mock entry (`index.mock.ts`) — no AWS account required.

TODO: say where the mock keeps its data (in memory, or on disk under
`.cdk-blocks/local/data/`, which `rm -rf .cdk-blocks/local/data .bb-data` resets along with legacy data).

TODO: list each difference between the mock and AWS that an app can observe.
Write "None." if there is none.
