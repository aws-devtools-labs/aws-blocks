---
'@aws-blocks/hosting': patch
---

`secret set` of a key that `secret remove` scheduled for deletion restores the secret and sets the new value, instead of failing with Secrets Manager's raw "already scheduled for deletion" error.

`secret remove KEY --force --yes` of a key that does not exist reports that it was not set, instead of claiming it was permanently removed.
