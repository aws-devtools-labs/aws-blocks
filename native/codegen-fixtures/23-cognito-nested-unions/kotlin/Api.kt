@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun cognitoConfirmSignIn(session: String, challengeResponse: String): CognitoConfirmSignIn.Result {
    val request = BlocksRequest(method = "api.cognitoConfirmSignIn", params = listOf(JsonPrimitive(session), JsonPrimitive(challengeResponse)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun cognitoSignIn(username: String, password: String): CognitoSignIn.Result {
    val request = BlocksRequest(method = "api.cognitoSignIn", params = listOf(JsonPrimitive(username), JsonPrimitive(password)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object CognitoConfirmSignIn {
    @Serializable
    @JsonClassDiscriminator("status")
    public sealed class Result {
      @Serializable
      @SerialName("continueSignIn")
      public data class ContinueSignIn(
        public val nextStep: ContinueSignIn.NextStep,
      ) : Result() {
        @Serializable
        @JsonClassDiscriminator("name")
        public sealed class NextStep {
          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_SMS_CODE")
          public data class ConfirmSignInWithSmsCode(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_TOTP_CODE")
          public data class ConfirmSignInWithTotpCode(
            public val session: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_EMAIL_CODE")
          public data class ConfirmSignInWithEmailCode(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SELECTION")
          public data class ContinueSignInWithMfaSelection(
            public val session: String,
            public val allowedMFATypes: List<ContinueSignInWithMfaSelection.AllowedMFATypes>,
          ) : NextStep() {
            /**
             * A string enum that keeps a value this client was generated without as [Unknown].
             */
            @Serializable(with = AllowedMFATypes.Serializer::class)
            public sealed class AllowedMFATypes {
              /**
               * The value as it is sent on the wire.
               */
              public abstract val `value`: String

              public data object Sms : AllowedMFATypes() {
                override val `value`: String = "SMS"
              }

              public data object Totp : AllowedMFATypes() {
                override val `value`: String = "TOTP"
              }

              public data object Email : AllowedMFATypes() {
                override val `value`: String = "EMAIL"
              }

              /**
               * A value this client was generated without, as the server sent it.
               */
              public data class Unknown(
                override val `value`: String,
              ) : AllowedMFATypes()

              public companion object {
                /**
                 * The known values, in the spec's order.
                 */
                public val entries: List<AllowedMFATypes> by lazy { listOf(Sms, Totp, Email) }

                /**
                 * The case for [value]: a known one, else [Unknown].
                 */
                public fun fromValue(`value`: String): AllowedMFATypes = entries.firstOrNull { it.value == value } ?: Unknown(value)
              }

              public object Serializer : KSerializer<AllowedMFATypes> {
                override val descriptor: SerialDescriptor =
                    PrimitiveSerialDescriptor("com.example.app.AllowedMFATypes", PrimitiveKind.STRING)

                override fun serialize(encoder: Encoder, `value`: AllowedMFATypes) {
                  encoder.encodeString(value.value)
                }

                override fun deserialize(decoder: Decoder): AllowedMFATypes = fromValue(decoder.decodeString())
              }
            }
          }

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION")
          public data class ContinueSignInWithMfaSetupSelection(
            public val session: String,
            public val allowedMFATypes: List<ContinueSignInWithMfaSetupSelection.AllowedMFATypes>,
          ) : NextStep() {
            /**
             * A string enum that keeps a value this client was generated without as [Unknown].
             */
            @Serializable(with = AllowedMFATypes.Serializer::class)
            public sealed class AllowedMFATypes {
              /**
               * The value as it is sent on the wire.
               */
              public abstract val `value`: String

              public data object Totp : AllowedMFATypes() {
                override val `value`: String = "TOTP"
              }

              public data object Email : AllowedMFATypes() {
                override val `value`: String = "EMAIL"
              }

              /**
               * A value this client was generated without, as the server sent it.
               */
              public data class Unknown(
                override val `value`: String,
              ) : AllowedMFATypes()

              public companion object {
                /**
                 * The known values, in the spec's order.
                 */
                public val entries: List<AllowedMFATypes> by lazy { listOf(Totp, Email) }

                /**
                 * The case for [value]: a known one, else [Unknown].
                 */
                public fun fromValue(`value`: String): AllowedMFATypes = entries.firstOrNull { it.value == value } ?: Unknown(value)
              }

              public object Serializer : KSerializer<AllowedMFATypes> {
                override val descriptor: SerialDescriptor =
                    PrimitiveSerialDescriptor("com.example.app.AllowedMFATypes", PrimitiveKind.STRING)

                override fun serialize(encoder: Encoder, `value`: AllowedMFATypes) {
                  encoder.encodeString(value.value)
                }

                override fun deserialize(decoder: Decoder): AllowedMFATypes = fromValue(decoder.decodeString())
              }
            }
          }

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_TOTP_SETUP")
          public data class ContinueSignInWithTotpSetup(
            public val session: String,
            public val sharedSecret: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP")
          public data class ContinueSignInWithEmailSetup(
            public val session: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED")
          public data class ConfirmSignInWithNewPasswordRequired(
            public val session: String,
            public val requiredAttributes: List<String>? = null,
          ) : NextStep()

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION")
          public data class ContinueSignInWithFirstFactorSelection(
            public val session: String,
            public val availableChallenges:
                List<ContinueSignInWithFirstFactorSelection.AvailableChallenges>,
          ) : NextStep() {
            /**
             * A string enum that keeps a value this client was generated without as [Unknown].
             */
            @Serializable(with = AvailableChallenges.Serializer::class)
            public sealed class AvailableChallenges {
              /**
               * The value as it is sent on the wire.
               */
              public abstract val `value`: String

              public data object Password : AvailableChallenges() {
                override val `value`: String = "PASSWORD"
              }

              public data object EmailOtp : AvailableChallenges() {
                override val `value`: String = "EMAIL_OTP"
              }

              public data object SmsOtp : AvailableChallenges() {
                override val `value`: String = "SMS_OTP"
              }

              public data object WebAuthn : AvailableChallenges() {
                override val `value`: String = "WEB_AUTHN"
              }

              /**
               * A value this client was generated without, as the server sent it.
               */
              public data class Unknown(
                override val `value`: String,
              ) : AvailableChallenges()

              public companion object {
                /**
                 * The known values, in the spec's order.
                 */
                public val entries: List<AvailableChallenges> by
                    lazy { listOf(Password, EmailOtp, SmsOtp, WebAuthn) }

                /**
                 * The case for [value]: a known one, else [Unknown].
                 */
                public fun fromValue(`value`: String): AvailableChallenges = entries.firstOrNull { it.value == value } ?: Unknown(value)
              }

              public object Serializer : KSerializer<AvailableChallenges> {
                override val descriptor: SerialDescriptor =
                    PrimitiveSerialDescriptor("com.example.app.AvailableChallenges", PrimitiveKind.STRING)

                override fun serialize(encoder: Encoder, `value`: AvailableChallenges) {
                  encoder.encodeString(value.value)
                }

                override fun deserialize(decoder: Decoder): AvailableChallenges = fromValue(decoder.decodeString())
              }
            }
          }

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_PASSWORD")
          public data class ConfirmSignInWithPassword(
            public val session: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP")
          public data class ConfirmSignInWithFirstFactorEmailOtp(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP")
          public data class ConfirmSignInWithFirstFactorSmsOtp(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_WEB_AUTHN")
          public data class ConfirmSignInWithWebAuthn(
            public val session: String,
            public val credentialRequestOptions: String,
          ) : NextStep()

          @Serializable
          @SerialName("RESET_PASSWORD")
          public data object ResetPassword : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_UP")
          public data class ConfirmSignUp(
            public val codeDeliveryDetails: CodeDeliveryDetails? = null,
          ) : NextStep()
        }
      }

      @Serializable
      @SerialName("signedIn")
      public data class SignedIn(
        public val user: AuthenticatedUser,
      ) : Result()
    }
  }

  public object CognitoSignIn {
    @Serializable
    @JsonClassDiscriminator("status")
    public sealed class Result {
      @Serializable
      @SerialName("continueSignIn")
      public data class ContinueSignIn(
        public val nextStep: ContinueSignIn.NextStep,
      ) : Result() {
        @Serializable
        @JsonClassDiscriminator("name")
        public sealed class NextStep {
          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_SMS_CODE")
          public data class ConfirmSignInWithSmsCode(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_TOTP_CODE")
          public data class ConfirmSignInWithTotpCode(
            public val session: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_EMAIL_CODE")
          public data class ConfirmSignInWithEmailCode(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SELECTION")
          public data class ContinueSignInWithMfaSelection(
            public val session: String,
            public val allowedMFATypes: List<ContinueSignInWithMfaSelection.AllowedMFATypes>,
          ) : NextStep() {
            /**
             * A string enum that keeps a value this client was generated without as [Unknown].
             */
            @Serializable(with = AllowedMFATypes.Serializer::class)
            public sealed class AllowedMFATypes {
              /**
               * The value as it is sent on the wire.
               */
              public abstract val `value`: String

              public data object Sms : AllowedMFATypes() {
                override val `value`: String = "SMS"
              }

              public data object Totp : AllowedMFATypes() {
                override val `value`: String = "TOTP"
              }

              public data object Email : AllowedMFATypes() {
                override val `value`: String = "EMAIL"
              }

              /**
               * A value this client was generated without, as the server sent it.
               */
              public data class Unknown(
                override val `value`: String,
              ) : AllowedMFATypes()

              public companion object {
                /**
                 * The known values, in the spec's order.
                 */
                public val entries: List<AllowedMFATypes> by lazy { listOf(Sms, Totp, Email) }

                /**
                 * The case for [value]: a known one, else [Unknown].
                 */
                public fun fromValue(`value`: String): AllowedMFATypes = entries.firstOrNull { it.value == value } ?: Unknown(value)
              }

              public object Serializer : KSerializer<AllowedMFATypes> {
                override val descriptor: SerialDescriptor =
                    PrimitiveSerialDescriptor("com.example.app.AllowedMFATypes", PrimitiveKind.STRING)

                override fun serialize(encoder: Encoder, `value`: AllowedMFATypes) {
                  encoder.encodeString(value.value)
                }

                override fun deserialize(decoder: Decoder): AllowedMFATypes = fromValue(decoder.decodeString())
              }
            }
          }

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION")
          public data class ContinueSignInWithMfaSetupSelection(
            public val session: String,
            public val allowedMFATypes: List<ContinueSignInWithMfaSetupSelection.AllowedMFATypes>,
          ) : NextStep() {
            /**
             * A string enum that keeps a value this client was generated without as [Unknown].
             */
            @Serializable(with = AllowedMFATypes.Serializer::class)
            public sealed class AllowedMFATypes {
              /**
               * The value as it is sent on the wire.
               */
              public abstract val `value`: String

              public data object Totp : AllowedMFATypes() {
                override val `value`: String = "TOTP"
              }

              public data object Email : AllowedMFATypes() {
                override val `value`: String = "EMAIL"
              }

              /**
               * A value this client was generated without, as the server sent it.
               */
              public data class Unknown(
                override val `value`: String,
              ) : AllowedMFATypes()

              public companion object {
                /**
                 * The known values, in the spec's order.
                 */
                public val entries: List<AllowedMFATypes> by lazy { listOf(Totp, Email) }

                /**
                 * The case for [value]: a known one, else [Unknown].
                 */
                public fun fromValue(`value`: String): AllowedMFATypes = entries.firstOrNull { it.value == value } ?: Unknown(value)
              }

              public object Serializer : KSerializer<AllowedMFATypes> {
                override val descriptor: SerialDescriptor =
                    PrimitiveSerialDescriptor("com.example.app.AllowedMFATypes", PrimitiveKind.STRING)

                override fun serialize(encoder: Encoder, `value`: AllowedMFATypes) {
                  encoder.encodeString(value.value)
                }

                override fun deserialize(decoder: Decoder): AllowedMFATypes = fromValue(decoder.decodeString())
              }
            }
          }

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_TOTP_SETUP")
          public data class ContinueSignInWithTotpSetup(
            public val session: String,
            public val sharedSecret: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP")
          public data class ContinueSignInWithEmailSetup(
            public val session: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED")
          public data class ConfirmSignInWithNewPasswordRequired(
            public val session: String,
            public val requiredAttributes: List<String>? = null,
          ) : NextStep()

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION")
          public data class ContinueSignInWithFirstFactorSelection(
            public val session: String,
            public val availableChallenges:
                List<ContinueSignInWithFirstFactorSelection.AvailableChallenges>,
          ) : NextStep() {
            /**
             * A string enum that keeps a value this client was generated without as [Unknown].
             */
            @Serializable(with = AvailableChallenges.Serializer::class)
            public sealed class AvailableChallenges {
              /**
               * The value as it is sent on the wire.
               */
              public abstract val `value`: String

              public data object Password : AvailableChallenges() {
                override val `value`: String = "PASSWORD"
              }

              public data object EmailOtp : AvailableChallenges() {
                override val `value`: String = "EMAIL_OTP"
              }

              public data object SmsOtp : AvailableChallenges() {
                override val `value`: String = "SMS_OTP"
              }

              public data object WebAuthn : AvailableChallenges() {
                override val `value`: String = "WEB_AUTHN"
              }

              /**
               * A value this client was generated without, as the server sent it.
               */
              public data class Unknown(
                override val `value`: String,
              ) : AvailableChallenges()

              public companion object {
                /**
                 * The known values, in the spec's order.
                 */
                public val entries: List<AvailableChallenges> by
                    lazy { listOf(Password, EmailOtp, SmsOtp, WebAuthn) }

                /**
                 * The case for [value]: a known one, else [Unknown].
                 */
                public fun fromValue(`value`: String): AvailableChallenges = entries.firstOrNull { it.value == value } ?: Unknown(value)
              }

              public object Serializer : KSerializer<AvailableChallenges> {
                override val descriptor: SerialDescriptor =
                    PrimitiveSerialDescriptor("com.example.app.AvailableChallenges", PrimitiveKind.STRING)

                override fun serialize(encoder: Encoder, `value`: AvailableChallenges) {
                  encoder.encodeString(value.value)
                }

                override fun deserialize(decoder: Decoder): AvailableChallenges = fromValue(decoder.decodeString())
              }
            }
          }

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_PASSWORD")
          public data class ConfirmSignInWithPassword(
            public val session: String,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP")
          public data class ConfirmSignInWithFirstFactorEmailOtp(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP")
          public data class ConfirmSignInWithFirstFactorSmsOtp(
            public val session: String,
            public val codeDeliveryDetails: CodeDeliveryDetails,
          ) : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_IN_WITH_WEB_AUTHN")
          public data class ConfirmSignInWithWebAuthn(
            public val session: String,
            public val credentialRequestOptions: String,
          ) : NextStep()

          @Serializable
          @SerialName("RESET_PASSWORD")
          public data object ResetPassword : NextStep()

          @Serializable
          @SerialName("CONFIRM_SIGN_UP")
          public data class ConfirmSignUp(
            public val codeDeliveryDetails: CodeDeliveryDetails? = null,
          ) : NextStep()
        }
      }

      @Serializable
      @SerialName("signedIn")
      public data class SignedIn(
        public val user: AuthenticatedUser,
      ) : Result()
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
