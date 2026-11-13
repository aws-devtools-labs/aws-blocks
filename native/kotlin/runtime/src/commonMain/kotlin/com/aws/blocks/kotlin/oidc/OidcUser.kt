package com.aws.blocks.kotlin.oidc

import kotlinx.serialization.Serializable

/**
 * The signed-in user, as the backend reports it.
 *
 * Only [userId] and [username] are always present. An AWS Blocks `Auth` block also reports the
 * optional fields; a backend that omits one leaves it `null`, or [groups] empty.
 *
 * @property userId the backend's id for the user.
 * @property username the user's name.
 * @property userSub the identity provider's subject, stable for the user's lifetime. Key your own
 *   data on it.
 * @property signInProvider how the user signed in: the provider id, or `password` for an email and
 *   password sign-in.
 * @property groups the user's groups. Empty when the user is in none, or the backend omits them.
 * @property attributes the user's attributes the backend reads, keyed by name.
 * @property displayName the name a sign-in UI shows for the user ("Signed in as ...").
 */
@Serializable
data class OidcUser(
    val userId: String,
    val username: String,
    val userSub: String? = null,
    val signInProvider: String? = null,
    val groups: List<String> = emptyList(),
    val attributes: Map<String, String>? = null,
    val displayName: String? = null,
)
