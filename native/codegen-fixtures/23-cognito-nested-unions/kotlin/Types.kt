package com.example.app

import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
public data class AuthenticatedUser(
  public val userSub: String,
  public val groups: List<Groups>,
  public val attributes: Map<String, String?>,
  public val signInProvider: SignInProvider,
  public val claims: Map<String, JsonElement>? = null,
  public val userId: String,
  public val username: String,
) {
  @Serializable
  public enum class Groups {
    @SerialName("admins")
    Admins,
    @SerialName("users")
    Users,
  }

  @Serializable
  public enum class SignInProvider {
    @SerialName("password")
    Password,
  }
}

@Serializable
public data class CodeDeliveryDetails(
  public val destination: String,
  public val deliveryMedium: DeliveryMedium,
  public val attributeName: String,
) {
  @Serializable
  public enum class DeliveryMedium {
    @SerialName("SMS")
    Sms,
    @SerialName("EMAIL")
    Email,
    @SerialName("PHONE_NUMBER")
    PhoneNumber,
  }
}
