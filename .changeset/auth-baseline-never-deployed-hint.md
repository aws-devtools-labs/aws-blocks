---
"@aws-blocks/bb-auth": patch
"@aws-blocks/blocks": patch
---

When synth refuses a change against the user-pool immutability baseline, the error now names the case it cannot tell apart from a deployed change: one that was synthesized but never deployed. The baseline is rewritten on every passing synth, not after a deploy. So if you synthesize a new custom attribute or `users.caseSensitive` setting and then undo it, synth refuses the undo even though no pool ever had the setting.

- For a change to a user-pool property Cognito cannot change, the error lists what is wrong, then gives the re-baseline command for a change that was never deployed (`If this was never deployed, re-baseline: BLOCKS_AUTH_REBASELINE=<fullId> …`), then the revert advice for a deployed pool.
- For a change that removes the user pool, the error starts with the danger: if the pool was ever deployed, the next deploy deletes it and every user in it, and nothing at deploy time stops that. It then tells you to check your deployed stack, and only after that gives the re-baseline command for a pool that was never deployed.

The guard itself is unchanged, and so is the baseline file.
