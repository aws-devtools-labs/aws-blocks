---
"@aws-blocks/bb-auth": patch
---

docs: state the propagation window when a password reset ends sessions on AWS

The README said a password reset rejects the user's other sessions from the next request on, locally and on AWS. On AWS the reset is read with an eventually consistent DynamoDB `GetItem`, so for about a second after it a request served by a stale read can still be accepted. The README now says so and links to the design note.
