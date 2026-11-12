package com.example.app

import kotlin.Boolean
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

@Serializable
public data class AuthAction(
  public val name: String,
  public val label: String,
  public val fields: List<AuthField>,
  public val url: String? = null,
  public val method: Method? = null,
  public val capability: Capability? = null,
  public val unavailable: String? = null,
) {
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Capability.Serializer::class)
  public sealed class Capability {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object WebauthnGet : Capability() {
      override val `value`: String = "webauthn-get"
    }

    public data object WebauthnCreate : Capability() {
      override val `value`: String = "webauthn-create"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Capability()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Capability> by lazy { listOf(WebauthnGet, WebauthnCreate) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Capability = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Capability> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Capability", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Capability) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Capability = fromValue(decoder.decodeString())
    }
  }

  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Method.Serializer::class)
  public sealed class Method {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Get : Method() {
      override val `value`: String = "GET"
    }

    public data object Post : Method() {
      override val `value`: String = "POST"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Method()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Method> by lazy { listOf(Get, Post) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Method = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Method> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Method", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Method) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Method = fromValue(decoder.decodeString())
    }
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
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Type.Serializer::class)
  public sealed class Type {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Number : Type() {
      override val `value`: String = "number"
    }

    public data object Password : Type() {
      override val `value`: String = "password"
    }

    public data object Email : Type() {
      override val `value`: String = "email"
    }

    public data object Text : Type() {
      override val `value`: String = "text"
    }

    public data object Tel : Type() {
      override val `value`: String = "tel"
    }

    public data object Hidden : Type() {
      override val `value`: String = "hidden"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Type()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Type> by lazy { listOf(Number, Password, Email, Text, Tel, Hidden) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Type = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Type> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Type", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Type) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Type = fromValue(decoder.decodeString())
    }
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
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = State.Serializer::class)
  public sealed class State {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object SignedOut : State() {
      override val `value`: String = "signedOut"
    }

    public data object SignedIn : State() {
      override val `value`: String = "signedIn"
    }

    public data object ConfirmingSignUp : State() {
      override val `value`: String = "confirmingSignUp"
    }

    public data object ConfirmingSignIn : State() {
      override val `value`: String = "confirmingSignIn"
    }

    public data object ConfirmingMfa : State() {
      override val `value`: String = "confirmingMfa"
    }

    public data object ConfirmingPasswordReset : State() {
      override val `value`: String = "confirmingPasswordReset"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : State()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<State> by
          lazy { listOf(SignedOut, SignedIn, ConfirmingSignUp, ConfirmingSignIn, ConfirmingMfa, ConfirmingPasswordReset) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): State = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<State> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.State", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: State) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): State = fromValue(decoder.decodeString())
    }
  }
}

@Serializable
public data class AuthUser(
  public val userId: String,
  public val username: String,
  public val displayName: String? = null,
)
