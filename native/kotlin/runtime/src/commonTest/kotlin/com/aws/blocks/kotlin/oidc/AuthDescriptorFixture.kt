// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import io.ktor.client.HttpClient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** The server the descriptor fixtures resolve their routes against. */
internal val fixtureServer = BlocksServer("local", "http://localhost:3001/cdk-blocks/api")

/**
 * The `oidc/client` descriptor a CDK Blocks `Auth` block's `createOidcApi().getClient()` returns
 * for routes under [base], the directory of `redirects.callbackPath`, and sign-out at [signOutPath].
 * [sessionPath] is sent as the backend sends it; pass `null` for a backend from before it did.
 */
internal fun authBlockDescriptor(
    providers: List<String>,
    base: String = "/cdk-blocks/auth",
    signOutPath: String = "$base/signout",
    sessionPath: String? = "$base/session",
    callbackPath: String = "$base/callback",
): JsonElement = buildJsonObject {
    put("__blocks", "oidc/client")
    putJsonArray("providers") { providers.forEach { add(it) } }
    putJsonObject("providerConfigs") {
        providers.forEach { id ->
            putJsonObject(id) {
                put("authorizeUrl", "https://idp.example.com/authorize")
                put("clientId", "cid")
                putJsonArray("scopes") { add("openid") }
                put("kind", "oidc-custom")
            }
        }
    }
    put("callbackPath", callbackPath)
    put("exchangePath", "$base/exchange")
    put("signOutPath", signOutPath)
    put("signInBasePath", "$base/signin")
    put("authorizeParamsBasePath", "$base/authorize-params")
    if (sessionPath != null) put("sessionPath", sessionPath)
}

/** A client hydrated from [authBlockDescriptor], as a generated `getClient()` hydrates it. */
internal fun authBlockClient(
    http: HttpClient,
    providers: List<String>,
    base: String = "/cdk-blocks/auth",
    signOutPath: String = "$base/signout",
    sessionPath: String? = "$base/session",
    server: BlocksServer = fixtureServer,
): OidcClient<AnyProvider> =
    OidcClient.fromJson(authBlockDescriptor(providers, base, signOutPath, sessionPath), http, server, "myapp://auth")
