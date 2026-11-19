// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
    /** Where [OidcClient.restore] reads the session. Absent, it is derived from [callbackPath]. */
    val sessionPath: String? = null,
    /**
     * The name of the block's session cookie, which a local sign-out removes. Absent (an older
     * backend), a local sign-out leaves the cookie jar to the backend's `Set-Cookie`.
     */
    val sessionCookieName: String? = null,
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
