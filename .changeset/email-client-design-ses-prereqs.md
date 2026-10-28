---
"@aws-blocks/bb-email-client": patch
---

docs(bb-email-client): `DESIGN.md` now describes the infrastructure the block actually creates

The "Infrastructure (CDK)" section no longer lists an SES configuration set or SES email identity: the block creates neither. It now describes what the CDK layer does (the `ses:SendEmail` / `ses:SendBulkEmail` grants, the SES VPC endpoint requirement, the synth prerequisite warning) and the out-of-band prerequisites: create and verify the sender identity in SES, and request production access to leave the SES sandbox.
