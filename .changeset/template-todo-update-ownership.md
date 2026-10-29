---
"@aws-blocks/create-blocks-app": patch
"@aws-blocks/blocks": patch
---

Templates: per-user data is keyed on `userSub`, and `updateTodo` can no longer write into another user's list.

- **`updateTodo` (`demo`, `auth`)** spread the caller's `updates` object over the stored todo. The RPC layer passes through properties the TypeScript signature doesn't declare, so a crafted request could set the todo's key fields and overwrite or create a todo in someone else's list. It now copies only `completed`, `priority` and `title`. If you scaffolded an app from either template, make the same change to its `updateTodo`.
- **Keyed on `userSub`** (`default`, `react`, `demo`, `api-only`, `sql`, and the commented example in `bare`): per-user rows used the username as their owner key. They now use `user.userSub`, the id that stays the same for the user's lifetime, as the `auth` template already did. The todo field is renamed from `userId` to `userSub`. This only affects newly scaffolded apps.
- Each template's e2e tests now check that a second user can't list, read, update or delete the first user's items.
