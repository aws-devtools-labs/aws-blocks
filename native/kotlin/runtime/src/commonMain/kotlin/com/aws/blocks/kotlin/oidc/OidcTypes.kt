package com.aws.blocks.kotlin.oidc

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

@Serializable
data class OidcClientConfig(
    val providers: List<String>,
    val providerConfigs: Map<String, ProviderConfig>,
    val exchangePath: String,
    val signOutPath: String,
    val signInBasePath: String,
    val authorizeParamsBasePath: String,
    val callbackPath: String,
    @Transient val relayTo: String = ""
)

@Serializable
data class ProviderConfig(
    val authorizeUrl: String,
    val clientId: String,
    val scopes: List<String>,
    val kind: String
)

@Serializable
data class AuthorizeParamsResponse(
    val authorizeUrl: String,
    val clientId: String,
    val scopes: List<String>,
    val kind: String,
    val state: String,
    val nonce: String? = null,
)

@Serializable
data class StatePayload(
    val v: Int,
    val csrf: String,
    val relay: String? = null,
    val app: String? = null,
)
