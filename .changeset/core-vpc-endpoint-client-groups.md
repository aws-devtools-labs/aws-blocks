---
"@aws-blocks/core": minor
---

`VpcRequirements` gains `endpointClientSecurityGroups`, letting a Building Block register security groups of compute it provisions itself so they are admitted on the Blocks-managed interface-endpoint security group, and `endpointClientDependents`, so a construct that must not be created before that compute can reach the endpoints is ordered after them. When `provisionEndpoints: false` leaves the endpoints to you, Blocks warns (`blocks:vpc:endpoint-client-unadmitted`) for each registered group instead.
