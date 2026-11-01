---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): a failed sandbox deploy suggests destroying the sandbox only when a stack is actually left failed

Every failed sandbox deploy used to print the same advice: destroy the sandbox and redeploy from a clean slate. Destroying a healthy sandbox throws its data away and fixes nothing. The hint now depends on the cause:

- the app failed to synthesize: no AWS resource was changed; fix the error and re-run;
- another CDK command is using the app's `.blocks-sandbox` output: let it finish, and run one sandbox command at a time;
- CloudFormation is still updating the stack, for example after an interrupted deploy: wait for it, then re-run, and don't destroy;
- the stack is left `*_FAILED` or `ROLLBACK_COMPLETE`, or its state can't be read: the destroy-and-redeploy advice, as before;
- otherwise: no stack is in a failed state, so there's nothing to destroy.
