# __BB_CLASS__

TODO: one-sentence summary of what this Building Block does. (The first sentence
becomes the block's blurb in the `@aws-blocks/blocks` catalog table.)

**Keywords:** TODO, comma, separated

This is a **client-facing** block: it ships browser-side code (`index.browser.ts`)
to drive a non-HTTP protocol and re-hydrate a server "Transferable" into a live
client object.

> ⚠️ **This is a starting skeleton.** The generated `index.browser.ts` is a stub.
> Study [`packages/bb-realtime`](../bb-realtime) — the canonical example of the
> Transferable + client-middleware pattern — and model your client plugin on it.

## API

### `new __BB_CLASS__(scope, id, options?)`

Server methods live in `index.mock.ts` / `index.aws.ts`; the client plugin lives
in `index.browser.ts`.

## Local Development

`npm run dev` uses the in-process mock. No AWS account required. Wipe local state
with `rm -rf .bb-data`.
