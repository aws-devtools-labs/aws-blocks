---
"@aws-blocks/bb-auth-cognito": patch
"@aws-blocks/blocks": patch
---

fix(bb-auth-cognito): `requireRole` reads group membership live so admin group changes take effect without a re-login

`requireRole` checked the signed-in user's `cognito:groups` **token claim**, which
is a snapshot from sign-in. After an admin ran `auth.admin.addUserToGroup(user,
'admins')`, that user's live session kept getting **403** until their token
refreshed or they re-logged in — the "admin surface is unreachable / `requireRole`
returns 403 for everyone" symptom. The mirror bug: `removeUserFromGroup` did **not**
revoke a live session, so a removed member kept access until their stale token
expired.

`requireRole` now reads membership live at call time — AWS: `AdminListGroupsForUser`
(paginated); mock: in-process `state.groups` — mirroring how `fetchUserAttributes`
reads live rather than trusting the token. The returned `CognitoUser.groups`
reflects the live read. Grants and revocations now apply on the user's next
request, with no re-login.

- Costs one extra Cognito call per guarded request. The cheaper identity reads
  (`requireAuth` / `getCurrentUser` / `signIn`) still surface the cached
  `cognito:groups` claim — use `requireRole` when you need live membership.
- `cognito-idp:AdminListGroupsForUser` is now granted to the execution role
  unconditionally (it backs a client-facing guard), independent of the opt-in
  `admin` surface. Every other `Admin*` action still requires opt-in.
- Added `admin.test.ts` cases covering the sign-in-then-mutate ordering in both
  directions (grant is honored, revocation locks out); updated the CDK IAM
  least-privilege test for the new baseline grant.
