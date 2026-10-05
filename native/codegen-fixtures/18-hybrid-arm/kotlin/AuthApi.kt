@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.OptIn
import kotlin.String
import kotlin.collections.Map
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class AuthApi(
  private val client: BlocksClient,
) {
  public suspend fun setAuthState(input: SetAuthState.Input): AuthState {
    val request = BlocksRequest(method = "authApi.setAuthState", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SetAuthState {
    @Serializable
    @JsonClassDiscriminator("action")
    public sealed class Input {
      @Serializable
      @SerialName("signIn")
      public data class SignIn(
        public val username: String,
        public val password: String,
      ) : Input()

      @Serializable
      @SerialName("signUp")
      public data class SignUp(
        public val username: String,
        public val password: String,
        public val attributes: Map<String, String> = emptyMap(),
      ) : Input()

      @Serializable
      @SerialName("confirmSignUp")
      public data class ConfirmSignUp(
        public val username: String,
        public val code: String,
        public val password: String? = null,
      ) : Input()

      @Serializable
      @SerialName("resendSignUpCode")
      public data class ResendSignUpCode(
        public val username: String,
      ) : Input()

      @Serializable
      @SerialName("signOut")
      public data object SignOut : Input()

      @Serializable
      @SerialName("resetPassword")
      public data class ResetPassword(
        public val username: String,
      ) : Input()

      @Serializable
      @SerialName("confirmResetPassword")
      public data class ConfirmResetPassword(
        public val username: String,
        public val code: String,
        public val newPassword: String,
      ) : Input()

      @Serializable
      @SerialName("autoSignIn")
      public data class AutoSignIn(
        public val username: String,
      ) : Input()

      @Serializable
      @SerialName("confirmSignIn")
      public data class ConfirmSignIn(
        public val session: String,
        public val challenge: Challenge,
      ) : Input() {
        @Serializable
        @JsonClassDiscriminator("challenge")
        public sealed class Challenge {
          @Serializable
          @SerialName("code")
          public data class Code(
            public val code: String,
          ) : Challenge()

          @Serializable
          @SerialName("mfaType")
          public data class MfaType(
            public val mfaType: String,
          ) : Challenge()

          @Serializable
          @SerialName("newPassword")
          public data class NewPassword(
            public val newPassword: String,
          ) : Challenge()

          @Serializable
          @SerialName("totpSetup")
          public data class TotpSetup(
            public val sharedSecret: String,
            public val code: String,
          ) : Challenge()

          @Serializable
          @SerialName("email")
          public data class Email(
            public val email: String,
          ) : Challenge()

          @Serializable
          @SerialName("password")
          public data class Password(
            public val password: String,
          ) : Challenge()

          @Serializable
          @SerialName("firstFactor")
          public data class FirstFactor(
            public val firstFactor: String,
          ) : Challenge()
        }
      }
    }
  }
}

public val Blocks.authApi: AuthApi
  get() = AuthApi(client)
