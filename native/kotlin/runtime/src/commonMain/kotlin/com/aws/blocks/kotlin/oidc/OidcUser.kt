package com.aws.blocks.kotlin.oidc

import kotlinx.serialization.Serializable

/**
 * The authenticated user surfaced after token exchange.
 *
 * The values are what the server's exchange response reports; these values are not verified by this
 * client, so they are for display only. Do not use them to decide what the user may see or do: make
 * authorization decisions on the server, which verifies the token sent with each request.
 *
 * @property userId The user's identifier (the token's `sub` claim). For display only; not verified by this client.
 * @property username The user's name. For display only; not verified by this client.
 */
@Serializable
data class OidcUser(
    val userId: String,
    val username: String
)
