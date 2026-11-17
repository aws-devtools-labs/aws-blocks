// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import kotlinx.serialization.Serializable

@Serializable
data class OidcUser(
    val userId: String,
    val username: String
)
