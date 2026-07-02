# Required @aws-blocks Building Blocks

All Building Blocks are imported from `@aws-blocks/blocks`. The implementation must route the task's core behavior through the real block API below — not an in-memory Map/array, a hardcoded result, or an inline stub.

- AuthBasic — provides sign-up / sign-in / sign-out and the current-user identity. Expect `auth.requireAuth(context)` (or `auth.getCurrentUser(context)`) gating the note API, plus `auth.signUp` / `auth.signIn`.
- KVStore — holds each user's single note, keyed per user (e.g. `note:{username}`). Expect `store.put('note:'+user, text)` and `store.get('note:'+user)`.
