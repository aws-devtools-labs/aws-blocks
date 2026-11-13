package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement

@Serializable
public data class AuthenticatedUser(
  public val userSub: String,
  public val groups: List<Groups>,
  public val attributes: Map<String, String?>,
  public val signInProvider: SignInProvider,
  public val claims: Map<String, JsonElement>? = null,
  public val federatedIdentity: FederatedIdentity? = null,
  public val userId: String,
  public val username: String,
) {
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = Groups.Serializer::class)
  public sealed class Groups {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Admins : Groups() {
      override val `value`: String = "admins"
    }

    public data object Users : Groups() {
      override val `value`: String = "users"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : Groups()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<Groups> by lazy { listOf(Admins, Users) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): Groups = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<Groups> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.Groups", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: Groups) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): Groups = fromValue(decoder.decodeString())
    }
  }

  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = SignInProvider.Serializer::class)
  public sealed class SignInProvider {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Password : SignInProvider() {
      override val `value`: String = "password"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : SignInProvider()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<SignInProvider> by lazy { listOf(Password) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): SignInProvider = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<SignInProvider> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.SignInProvider", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: SignInProvider) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): SignInProvider = fromValue(decoder.decodeString())
    }
  }
}

@Serializable
public data class CodeDeliveryDetails(
  public val destination: String,
  public val deliveryMedium: DeliveryMedium,
  public val attributeName: String,
) {
  /**
   * A string enum that keeps a value this client was generated without as [Unknown].
   */
  @Serializable(with = DeliveryMedium.Serializer::class)
  public sealed class DeliveryMedium {
    /**
     * The value as it is sent on the wire.
     */
    public abstract val `value`: String

    public data object Sms : DeliveryMedium() {
      override val `value`: String = "SMS"
    }

    public data object Email : DeliveryMedium() {
      override val `value`: String = "EMAIL"
    }

    public data object PhoneNumber : DeliveryMedium() {
      override val `value`: String = "PHONE_NUMBER"
    }

    /**
     * A value this client was generated without, as the server sent it.
     */
    public data class Unknown(
      override val `value`: String,
    ) : DeliveryMedium()

    public companion object {
      /**
       * The known values, in the spec's order.
       */
      public val entries: List<DeliveryMedium> by lazy { listOf(Sms, Email, PhoneNumber) }

      /**
       * The case for [value]: a known one, else [Unknown].
       */
      public fun fromValue(`value`: String): DeliveryMedium = entries.firstOrNull { it.value == value } ?: Unknown(value)
    }

    public object Serializer : KSerializer<DeliveryMedium> {
      override val descriptor: SerialDescriptor =
          PrimitiveSerialDescriptor("com.example.app.DeliveryMedium", PrimitiveKind.STRING)

      override fun serialize(encoder: Encoder, `value`: DeliveryMedium) {
        encoder.encodeString(value.value)
      }

      override fun deserialize(decoder: Decoder): DeliveryMedium = fromValue(decoder.decodeString())
    }
  }
}

@Serializable
public data class FederatedIdentity(
  public val providerId: String,
  public val sub: String,
)
