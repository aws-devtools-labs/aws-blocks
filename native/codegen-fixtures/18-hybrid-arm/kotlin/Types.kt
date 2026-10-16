package com.example.app

import kotlin.Boolean
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class AuthAction(
  public val name: String,
  public val label: String,
  public val fields: List<AuthField>,
  public val url: String? = null,
  public val method: Method? = null,
  public val capability: Capability? = null,
) {
  @Serializable
  public enum class Capability {
    @SerialName("webauthn-get")
    WebauthnGet,
    @SerialName("webauthn-create")
    WebauthnCreate,
  }

  @Serializable
  public enum class Method {
    @SerialName("GET")
    Get,
    @SerialName("POST")
    Post,
  }
}

@Serializable
public data class AuthField(
  public val name: String,
  public val label: String,
  public val type: Type,
  public val required: Boolean,
  public val defaultValue: String? = null,
) {
  @Serializable
  public enum class Type {
    @SerialName("number")
    Number,
    @SerialName("password")
    Password,
    @SerialName("email")
    Email,
    @SerialName("text")
    Text,
    @SerialName("tel")
    Tel,
    @SerialName("hidden")
    Hidden,
  }
}

@Serializable
public data class AuthState(
  public val state: State,
  public val user: AuthUser? = null,
  public val actions: List<AuthAction>,
  public val error: String? = null,
  public val errorName: String? = null,
  public val retriable: Boolean? = null,
) {
  @Serializable
  public enum class State {
    @SerialName("signedOut")
    SignedOut,
    @SerialName("signedIn")
    SignedIn,
    @SerialName("confirmingSignUp")
    ConfirmingSignUp,
    @SerialName("confirmingSignIn")
    ConfirmingSignIn,
    @SerialName("confirmingMfa")
    ConfirmingMfa,
    @SerialName("confirmingPasswordReset")
    ConfirmingPasswordReset,
  }
}

@Serializable
public data class AuthUser(
  public val userId: String,
  public val username: String,
  public val displayName: String? = null,
)
