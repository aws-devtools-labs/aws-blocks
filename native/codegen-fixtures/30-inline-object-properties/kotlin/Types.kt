package com.example.app

import kotlin.Double
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
        @Serializable
        public enum class Source {
          @SerialName("gps")
          Gps,
          @SerialName("cell")
          Cell,
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
