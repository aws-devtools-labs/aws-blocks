package com.aws.blocks.kotlin.oidc

/**
 * A provider an [OidcClient] can sign in with.
 *
 * A spec that names its providers generates an enum of them that implements this, so
 * [OidcClient.signIn] takes only the providers its own backend configured. A spec that doesn't
 * leaves the client's provider [ProviderName], which carries any name.
 */
interface OidcProvider {
    /** The name the backend knows this provider by, as it appears in the spec. */
    val providerName: String
}

/**
 * Any provider name, for a client whose providers the spec didn't name.
 *
 * `OidcClient<ProviderName>` signs in with a name rather than a generated provider, and its
 * [signIn] and [exchange] take that name directly: `client.signIn("google")`.
 */
data class ProviderName(override val providerName: String) : OidcProvider
