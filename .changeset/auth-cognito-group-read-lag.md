---
"@aws-blocks/bb-auth-cognito": patch
---

docs(bb-auth-cognito): note that a group change can take a moment to show up

The README's session-freshness note and DESIGN.md now say that on AWS, `addUserToGroup` and `removeUserFromGroup` take effect once Cognito's group-membership read reflects them. Cognito doesn't document read-after-write consistency for that read, and a read sent a fraction of a second after a change has returned the old membership. Code that changes a group and immediately calls `requireRole`, `admin.getUser` or `admin.listGroupsForUser` should retry briefly. Behavior is unchanged.
