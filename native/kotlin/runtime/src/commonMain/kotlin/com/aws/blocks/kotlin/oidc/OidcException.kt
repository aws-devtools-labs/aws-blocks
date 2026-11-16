package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.exceptions.BlocksException

sealed class OidcException(message: String, cause: Throwable? = null) : BlocksException(message, cause)

class OidcUnknownProviderException(val provider: String) :
    OidcException("Provider not configured: $provider")

class OidcExchangeException(message: String, cause: Throwable? = null) :
    OidcException(message, cause)

class OidcCallbackException(message: String) :
    OidcException(message)

class OidcCancelledException(message: String = "Sign-in cancelled") :
    OidcException(message)

/**
 * The backend could not read the session for [OidcClient.restore].
 *
 * It extends [BlocksException] rather than [OidcException], so a `when` over the sealed
 * [OidcException] subclasses stays exhaustive.
 *
 * @property statusCode the HTTP status the backend answered with. 404 means it serves no session
 *   route: an `Auth` block serves one only when it has federated providers.
 * @property errorName the error name in the backend's response, if it sent one.
 */
class OidcSessionException(
    message: String,
    val statusCode: Int,
    val errorName: String?,
) : BlocksException(message)
