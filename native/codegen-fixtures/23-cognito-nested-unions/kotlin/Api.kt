@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

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
            @Serializable
            public enum class AllowedMFATypes {
              @SerialName("SMS")
              Sms,
              @SerialName("TOTP")
              Totp,
              @SerialName("EMAIL")
              Email,
            }
          }

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION")
          public data class ContinueSignInWithMfaSetupSelection(
            public val session: String,
            public val allowedMFATypes: List<ContinueSignInWithMfaSetupSelection.AllowedMFATypes>,
          ) : NextStep() {
            @Serializable
            public enum class AllowedMFATypes {
              @SerialName("TOTP")
              Totp,
              @SerialName("EMAIL")
              Email,
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
            @Serializable
            public enum class AvailableChallenges {
              @SerialName("PASSWORD")
              Password,
              @SerialName("EMAIL_OTP")
              EmailOtp,
              @SerialName("SMS_OTP")
              SmsOtp,
              @SerialName("WEB_AUTHN")
              WebAuthn,
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
        public val user: CognitoUser,
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
            @Serializable
            public enum class AllowedMFATypes {
              @SerialName("SMS")
              Sms,
              @SerialName("TOTP")
              Totp,
              @SerialName("EMAIL")
              Email,
            }
          }

          @Serializable
          @SerialName("CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION")
          public data class ContinueSignInWithMfaSetupSelection(
            public val session: String,
            public val allowedMFATypes: List<ContinueSignInWithMfaSetupSelection.AllowedMFATypes>,
          ) : NextStep() {
            @Serializable
            public enum class AllowedMFATypes {
              @SerialName("TOTP")
              Totp,
              @SerialName("EMAIL")
              Email,
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
            @Serializable
            public enum class AvailableChallenges {
              @SerialName("PASSWORD")
              Password,
              @SerialName("EMAIL_OTP")
              EmailOtp,
              @SerialName("SMS_OTP")
              SmsOtp,
              @SerialName("WEB_AUTHN")
              WebAuthn,
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
        public val user: CognitoUser,
      ) : Result()
    }
  }
}
