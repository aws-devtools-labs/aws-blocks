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
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

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
    @Serializable(with = Result.ResultSerializer::class)
    public sealed class Result {
      /**
       * Reads and writes [Result] with its discriminator `status` as the JSON value
       * the spec gives it.
       */
      public object ResultSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = when (value) {
            is ContinueSignIn -> buildJsonObject {
              put("status", JsonPrimitive("continueSignIn"))
              output.json.encodeToJsonElement(ContinueSignIn.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is SignedIn -> buildJsonObject {
              put("status", JsonPrimitive("signedIn"))
              output.json.encodeToJsonElement(SignedIn.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is Unknown -> value.json
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          if (element is JsonObject) {
            val fields = JsonObject(element - "status")
            when (element["status"]) {
              JsonPrimitive("continueSignIn") -> return input.json.decodeFromJsonElement(ContinueSignIn.serializer(), fields)
              JsonPrimitive("signedIn") -> return input.json.decodeFromJsonElement(SignedIn.serializer(), fields)
              else -> return Unknown(element)
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected an object with \"status\": \"continueSignIn\"; or an object with \"status\": \"signedIn\"")
        }
      }

      /**
       * An arm this client was generated without: the object as the server sent it.
       */
      public data class Unknown(
        public val json: JsonObject,
      ) : Result()

      @Serializable
      @SerialName("continueSignIn")
      public data class ContinueSignIn(
        public val nextStep: ContinueSignIn.NextStep,
      ) : Result() {
        @Serializable(with = NextStep.NextStepSerializer::class)
        public sealed class NextStep {
          /**
           * Reads and writes [NextStep] with its discriminator `name` as the JSON value
           * the spec gives it.
           */
          public object NextStepSerializer : KSerializer<NextStep> {
            override val descriptor: SerialDescriptor = buildClassSerialDescriptor("NextStep")

            override fun serialize(encoder: Encoder, `value`: NextStep) {
              val output = encoder as? JsonEncoder ?: throw SerializationException("NextStep can only be written as JSON")
              val element = when (value) {
                is ConfirmSignInWithSmsCode -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_SMS_CODE"))
                  output.json.encodeToJsonElement(ConfirmSignInWithSmsCode.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithTotpCode -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_TOTP_CODE"))
                  output.json.encodeToJsonElement(ConfirmSignInWithTotpCode.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithEmailCode -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_EMAIL_CODE"))
                  output.json.encodeToJsonElement(ConfirmSignInWithEmailCode.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithMfaSelection -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SELECTION"))
                  output.json.encodeToJsonElement(ContinueSignInWithMfaSelection.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithMfaSetupSelection -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION"))
                  output.json.encodeToJsonElement(ContinueSignInWithMfaSetupSelection.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithTotpSetup -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_TOTP_SETUP"))
                  output.json.encodeToJsonElement(ContinueSignInWithTotpSetup.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithEmailSetup -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP"))
                  output.json.encodeToJsonElement(ContinueSignInWithEmailSetup.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithNewPasswordRequired -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"))
                  output.json.encodeToJsonElement(ConfirmSignInWithNewPasswordRequired.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithFirstFactorSelection -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION"))
                  output.json.encodeToJsonElement(ContinueSignInWithFirstFactorSelection.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithPassword -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_PASSWORD"))
                  output.json.encodeToJsonElement(ConfirmSignInWithPassword.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithFirstFactorEmailOtp -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP"))
                  output.json.encodeToJsonElement(ConfirmSignInWithFirstFactorEmailOtp.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithFirstFactorSmsOtp -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP"))
                  output.json.encodeToJsonElement(ConfirmSignInWithFirstFactorSmsOtp.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithWebAuthn -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_WEB_AUTHN"))
                  output.json.encodeToJsonElement(ConfirmSignInWithWebAuthn.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ResetPassword -> buildJsonObject {
                  put("name", JsonPrimitive("RESET_PASSWORD"))
                }
                is ConfirmSignUp -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_UP"))
                  output.json.encodeToJsonElement(ConfirmSignUp.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is Unknown -> value.json
              }
              output.encodeJsonElement(element)
            }

            override fun deserialize(decoder: Decoder): NextStep {
              val input = decoder as? JsonDecoder ?: throw SerializationException("NextStep can only be read from JSON")
              val element = input.decodeJsonElement()
              if (element is JsonObject) {
                val fields = JsonObject(element - "name")
                when (element["name"]) {
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_SMS_CODE") -> return input.json.decodeFromJsonElement(ConfirmSignInWithSmsCode.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_TOTP_CODE") -> return input.json.decodeFromJsonElement(ConfirmSignInWithTotpCode.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_EMAIL_CODE") -> return input.json.decodeFromJsonElement(ConfirmSignInWithEmailCode.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SELECTION") -> return input.json.decodeFromJsonElement(ContinueSignInWithMfaSelection.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION") -> return input.json.decodeFromJsonElement(ContinueSignInWithMfaSetupSelection.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_TOTP_SETUP") -> return input.json.decodeFromJsonElement(ContinueSignInWithTotpSetup.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP") -> return input.json.decodeFromJsonElement(ContinueSignInWithEmailSetup.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") -> return input.json.decodeFromJsonElement(ConfirmSignInWithNewPasswordRequired.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION") -> return input.json.decodeFromJsonElement(ContinueSignInWithFirstFactorSelection.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_PASSWORD") -> return input.json.decodeFromJsonElement(ConfirmSignInWithPassword.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP") -> return input.json.decodeFromJsonElement(ConfirmSignInWithFirstFactorEmailOtp.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP") -> return input.json.decodeFromJsonElement(ConfirmSignInWithFirstFactorSmsOtp.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_WEB_AUTHN") -> return input.json.decodeFromJsonElement(ConfirmSignInWithWebAuthn.serializer(), fields)
                  JsonPrimitive("RESET_PASSWORD") -> return ResetPassword
                  JsonPrimitive("CONFIRM_SIGN_UP") -> return input.json.decodeFromJsonElement(ConfirmSignUp.serializer(), fields)
                  else -> return Unknown(element)
                }
              }
              throw SerializationException("No variant of NextStep matches this JSON value; expected an object with \"name\": \"CONFIRM_SIGN_IN_WITH_SMS_CODE\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_TOTP_CODE\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_EMAIL_CODE\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_MFA_SELECTION\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_TOTP_SETUP\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_EMAIL_SETUP\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_PASSWORD\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_WEB_AUTHN\"; an object with \"name\": \"RESET_PASSWORD\"; or an object with \"name\": \"CONFIRM_SIGN_UP\"")
            }
          }

          /**
           * An arm this client was generated without: the object as the server sent it.
           */
          public data class Unknown(
            public val json: JsonObject,
          ) : NextStep()

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
    @Serializable(with = Result.ResultSerializer::class)
    public sealed class Result {
      /**
       * Reads and writes [Result] with its discriminator `status` as the JSON value
       * the spec gives it.
       */
      public object ResultSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = when (value) {
            is ContinueSignIn -> buildJsonObject {
              put("status", JsonPrimitive("continueSignIn"))
              output.json.encodeToJsonElement(ContinueSignIn.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is SignedIn -> buildJsonObject {
              put("status", JsonPrimitive("signedIn"))
              output.json.encodeToJsonElement(SignedIn.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is Unknown -> value.json
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          if (element is JsonObject) {
            val fields = JsonObject(element - "status")
            when (element["status"]) {
              JsonPrimitive("continueSignIn") -> return input.json.decodeFromJsonElement(ContinueSignIn.serializer(), fields)
              JsonPrimitive("signedIn") -> return input.json.decodeFromJsonElement(SignedIn.serializer(), fields)
              else -> return Unknown(element)
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected an object with \"status\": \"continueSignIn\"; or an object with \"status\": \"signedIn\"")
        }
      }

      /**
       * An arm this client was generated without: the object as the server sent it.
       */
      public data class Unknown(
        public val json: JsonObject,
      ) : Result()

      @Serializable
      @SerialName("continueSignIn")
      public data class ContinueSignIn(
        public val nextStep: ContinueSignIn.NextStep,
      ) : Result() {
        @Serializable(with = NextStep.NextStepSerializer::class)
        public sealed class NextStep {
          /**
           * Reads and writes [NextStep] with its discriminator `name` as the JSON value
           * the spec gives it.
           */
          public object NextStepSerializer : KSerializer<NextStep> {
            override val descriptor: SerialDescriptor = buildClassSerialDescriptor("NextStep")

            override fun serialize(encoder: Encoder, `value`: NextStep) {
              val output = encoder as? JsonEncoder ?: throw SerializationException("NextStep can only be written as JSON")
              val element = when (value) {
                is ConfirmSignInWithSmsCode -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_SMS_CODE"))
                  output.json.encodeToJsonElement(ConfirmSignInWithSmsCode.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithTotpCode -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_TOTP_CODE"))
                  output.json.encodeToJsonElement(ConfirmSignInWithTotpCode.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithEmailCode -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_EMAIL_CODE"))
                  output.json.encodeToJsonElement(ConfirmSignInWithEmailCode.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithMfaSelection -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SELECTION"))
                  output.json.encodeToJsonElement(ContinueSignInWithMfaSelection.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithMfaSetupSelection -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION"))
                  output.json.encodeToJsonElement(ContinueSignInWithMfaSetupSelection.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithTotpSetup -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_TOTP_SETUP"))
                  output.json.encodeToJsonElement(ContinueSignInWithTotpSetup.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithEmailSetup -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP"))
                  output.json.encodeToJsonElement(ContinueSignInWithEmailSetup.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithNewPasswordRequired -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED"))
                  output.json.encodeToJsonElement(ConfirmSignInWithNewPasswordRequired.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ContinueSignInWithFirstFactorSelection -> buildJsonObject {
                  put("name", JsonPrimitive("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION"))
                  output.json.encodeToJsonElement(ContinueSignInWithFirstFactorSelection.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithPassword -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_PASSWORD"))
                  output.json.encodeToJsonElement(ConfirmSignInWithPassword.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithFirstFactorEmailOtp -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP"))
                  output.json.encodeToJsonElement(ConfirmSignInWithFirstFactorEmailOtp.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithFirstFactorSmsOtp -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP"))
                  output.json.encodeToJsonElement(ConfirmSignInWithFirstFactorSmsOtp.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ConfirmSignInWithWebAuthn -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_IN_WITH_WEB_AUTHN"))
                  output.json.encodeToJsonElement(ConfirmSignInWithWebAuthn.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is ResetPassword -> buildJsonObject {
                  put("name", JsonPrimitive("RESET_PASSWORD"))
                }
                is ConfirmSignUp -> buildJsonObject {
                  put("name", JsonPrimitive("CONFIRM_SIGN_UP"))
                  output.json.encodeToJsonElement(ConfirmSignUp.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
                }
                is Unknown -> value.json
              }
              output.encodeJsonElement(element)
            }

            override fun deserialize(decoder: Decoder): NextStep {
              val input = decoder as? JsonDecoder ?: throw SerializationException("NextStep can only be read from JSON")
              val element = input.decodeJsonElement()
              if (element is JsonObject) {
                val fields = JsonObject(element - "name")
                when (element["name"]) {
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_SMS_CODE") -> return input.json.decodeFromJsonElement(ConfirmSignInWithSmsCode.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_TOTP_CODE") -> return input.json.decodeFromJsonElement(ConfirmSignInWithTotpCode.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_EMAIL_CODE") -> return input.json.decodeFromJsonElement(ConfirmSignInWithEmailCode.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SELECTION") -> return input.json.decodeFromJsonElement(ContinueSignInWithMfaSelection.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION") -> return input.json.decodeFromJsonElement(ContinueSignInWithMfaSetupSelection.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_TOTP_SETUP") -> return input.json.decodeFromJsonElement(ContinueSignInWithTotpSetup.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_EMAIL_SETUP") -> return input.json.decodeFromJsonElement(ContinueSignInWithEmailSetup.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") -> return input.json.decodeFromJsonElement(ConfirmSignInWithNewPasswordRequired.serializer(), fields)
                  JsonPrimitive("CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION") -> return input.json.decodeFromJsonElement(ContinueSignInWithFirstFactorSelection.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_PASSWORD") -> return input.json.decodeFromJsonElement(ConfirmSignInWithPassword.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP") -> return input.json.decodeFromJsonElement(ConfirmSignInWithFirstFactorEmailOtp.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP") -> return input.json.decodeFromJsonElement(ConfirmSignInWithFirstFactorSmsOtp.serializer(), fields)
                  JsonPrimitive("CONFIRM_SIGN_IN_WITH_WEB_AUTHN") -> return input.json.decodeFromJsonElement(ConfirmSignInWithWebAuthn.serializer(), fields)
                  JsonPrimitive("RESET_PASSWORD") -> return ResetPassword
                  JsonPrimitive("CONFIRM_SIGN_UP") -> return input.json.decodeFromJsonElement(ConfirmSignUp.serializer(), fields)
                  else -> return Unknown(element)
                }
              }
              throw SerializationException("No variant of NextStep matches this JSON value; expected an object with \"name\": \"CONFIRM_SIGN_IN_WITH_SMS_CODE\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_TOTP_CODE\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_EMAIL_CODE\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_MFA_SELECTION\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_TOTP_SETUP\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_EMAIL_SETUP\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED\"; an object with \"name\": \"CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_PASSWORD\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP\"; an object with \"name\": \"CONFIRM_SIGN_IN_WITH_WEB_AUTHN\"; an object with \"name\": \"RESET_PASSWORD\"; or an object with \"name\": \"CONFIRM_SIGN_UP\"")
            }
          }

          /**
           * An arm this client was generated without: the object as the server sent it.
           */
          public data class Unknown(
            public val json: JsonObject,
          ) : NextStep()

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
