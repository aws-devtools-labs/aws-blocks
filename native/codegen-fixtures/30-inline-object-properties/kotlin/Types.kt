package com.example.app

import kotlin.Double
import kotlin.Int
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

@Serializable
public data class Invoice(
  public val id: String,
  public val meta: Meta,
) {
  @Serializable
  public data class Meta(
    public val `value`: Int,
  )
}

@Serializable
public data class Receipt(
  public val id: String,
  public val meta: Meta,
) {
  @Serializable
  public data class Meta(
    public val `value`: String,
  )
}

@Serializable
public data class Shipment(
  public val id: String,
  public val destination: Destination,
  public val insurance: Insurance? = null,
  public val signature: Signature?,
  public val parcels: List<Parcels>,
  public val customs: Map<String, Customs>? = null,
) {
  @Serializable
  public data class Customs(
    public val code: String,
    public val `value`: Double,
  )

  @Serializable
  public data class Destination(
    public val city: String,
    public val geo: Geo,
  ) {
    @Serializable
    public data class Geo(
      public val lat: Double,
      public val lng: Double,
      public val accuracy: Accuracy? = null,
    ) {
      @Serializable
      public data class Accuracy(
        public val meters: Double,
        public val source: Source,
      ) {
        /**
         * A string enum that keeps a value this client was generated without as [Unknown].
         */
        @Serializable(with = Source.Serializer::class)
        public sealed class Source {
          /**
           * The value as it is sent on the wire.
           */
          public abstract val `value`: String

          public data object Gps : Source() {
            override val `value`: String = "gps"
          }

          public data object Cell : Source() {
            override val `value`: String = "cell"
          }

          /**
           * A value this client was generated without, as the server sent it.
           */
          public data class Unknown(
            override val `value`: String,
          ) : Source()

          public companion object {
            /**
             * The known values, in the spec's order.
             */
            public val entries: List<Source> by lazy { listOf(Gps, Cell) }

            /**
             * The case for [value]: a known one, else [Unknown].
             */
            public fun fromValue(`value`: String): Source = entries.firstOrNull { it.value == value } ?: Unknown(value)
          }

          public object Serializer : KSerializer<Source> {
            override val descriptor: SerialDescriptor =
                PrimitiveSerialDescriptor("com.example.app.Source", PrimitiveKind.STRING)

            override fun serialize(encoder: Encoder, `value`: Source) {
              encoder.encodeString(value.value)
            }

            override fun deserialize(decoder: Decoder): Source = fromValue(decoder.decodeString())
          }
        }
      }
    }
  }

  @Serializable
  public data class Insurance(
    public val provider: String,
    public val amount: Double? = null,
  )

  @Serializable
  public data class Parcels(
    public val sku: String,
    public val weightKg: Double,
  )

  @Serializable
  public data class Signature(
    public val signedBy: String,
    public val signedAt: String,
  )
}
