package com.aws.blocks.kotlin.oidc

/**
 * A provider an [OidcClient] can sign in with.
 *
 * A spec that names its providers generates an enum of them that implements this, so
 * [OidcClient.signIn] takes only the providers that spec named. Those are what the backend was
 * configured with when the spec was generated, which is not necessarily what it reports now:
 * [OidcClient.providers] is the deployed backend's own list, and the two drift when an app ships
 * against an older spec or a provider is added or removed server-side.
 *
 * A spec that doesn't name them leaves the client's provider [AnyProvider], which carries any
 * name.
 */
interface OidcProvider {
    /** The name the backend knows this provider by, as it appears in the spec. */
    val providerName: String
}

/**
 * Any provider the backend names, for a client whose providers the spec didn't name.
 *
 * `OidcClient<AnyProvider>` signs in with a name rather than a generated provider, and its
 * [signIn] and [exchange] take that name directly: `client.signIn("google")`.
 */
data class AnyProvider(override val providerName: String) : OidcProvider
