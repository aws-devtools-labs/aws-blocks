package com.aws.blocks.kotlin.oidc

import kotlinx.serialization.Serializable

@Serializable
data class OidcUser(
    val userId: String,
    val username: String
)
