---
"aws-blocks-kotlin": minor
---

`OidcUser` gains the optional fields an AWS Blocks `Auth` block reports: `userSub`,
`signInProvider`, `groups`, `attributes` and `displayName`. `groups` is empty when the backend omits
it; each of the others is `null`.
