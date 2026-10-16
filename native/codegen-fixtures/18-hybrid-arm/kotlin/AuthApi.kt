@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.OptIn
import kotlin.String
import kotlin.collections.Map
import kotlin.collections.Set
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

public class AuthApi(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun setAuthState(input: SetAuthState.Input): AuthState {
    val request = BlocksRequest(method = "authApi.setAuthState", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SetAuthState {
    @Serializable
    @JsonClassDiscriminator("action")
    public sealed class Input {
      @Serializable(with = SignUp.OpenRecordSerializer::class)
      @SerialName("signUp")
      public data class SignUp(
        public val username: String,
        public val password: String,
        public val attributes: Map<String, String> = emptyMap(),
      ) : Input() {
        @Serializable
        private data class OpenRecordFields(
          public val username: String,
          public val password: String,
          public val attributes: Map<String, String> = emptyMap(),
        )

        /**
         * Writes [attributes] flat into the JSON object, beside the properties (the wire shape of
         * `additionalProperties`), and reads every key that isn't a property or `action` back into it.
         */
        internal object OpenRecordSerializer : KSerializer<SignUp> {
          private val fieldKeys: Set<String> = setOf("username", "password")

          override val descriptor: SerialDescriptor = buildClassSerialDescriptor("signUp")

          override fun serialize(encoder: Encoder, `value`: SignUp) {
            val output = encoder as JsonEncoder
            val fields = output.json.encodeToJsonElement(SignUp.OpenRecordFields.serializer(), SignUp.OpenRecordFields(value.username, value.password, value.attributes)).jsonObject
            val flat = buildJsonObject {
              for ((key, element) in fields) if (key != "attributes") put(key, element)
              fields["attributes"]?.jsonObject?.forEach { (key, element) -> if (key !in fieldKeys && key != "action") put(key, element) }
            }
            output.encodeJsonElement(flat)
          }

          override fun deserialize(decoder: Decoder): SignUp {
            val input = decoder as JsonDecoder
            val flat = input.decodeJsonElement().jsonObject
            val nested = buildJsonObject {
              for ((key, element) in flat) if (key in fieldKeys) put(key, element)
              put("attributes", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys && key != "action") put(key, element) })
            }
            val fields = input.json.decodeFromJsonElement(SignUp.OpenRecordFields.serializer(), nested)
            return SignUp(fields.username, fields.password, fields.attributes)
          }
        }
      }

      @Serializable
      @SerialName("resetPassword")
      public data class ResetPassword(
        public val username: String,
      ) : Input()

      @Serializable
      @SerialName("signIn")
      public data class SignIn(
        public val username: String,
        public val password: String,
      ) : Input()

      @Serializable
      @SerialName("signInWithPasskey")
      public data class SignInWithPasskey(
        public val username: String,
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

      @Serializable(with = ConfirmSignIn.HybridArmSerializer::class)
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

          @Serializable
          @SerialName("webauthn")
          public data class Webauthn(
            public val credential: String,
          ) : Challenge()
        }

        @Serializable
        private data class HybridArmFields(
          public val session: String,
        )

        /**
         * Writes [challenge] and the arm's own properties as one flat JSON object, the hybrid arm's wire shape.
         */
        internal object HybridArmSerializer : KSerializer<ConfirmSignIn> {
          private val fieldKeys: Set<String> = setOf("session")

          override val descriptor: SerialDescriptor = buildClassSerialDescriptor("confirmSignIn")

          override fun serialize(encoder: Encoder, `value`: ConfirmSignIn) {
            val output = encoder as? JsonEncoder ?: throw SerializationException("ConfirmSignIn can only be written as JSON")
            val fields = output.json.encodeToJsonElement(ConfirmSignIn.HybridArmFields.serializer(), ConfirmSignIn.HybridArmFields(value.session)).jsonObject
            val union = output.json.encodeToJsonElement(Challenge.serializer(), value.challenge).jsonObject
            output.encodeJsonElement(JsonObject(fields + union))
          }

          override fun deserialize(decoder: Decoder): ConfirmSignIn {
            val input = decoder as? JsonDecoder ?: throw SerializationException("ConfirmSignIn can only be read from JSON")
            val flat = input.decodeJsonElement().jsonObject
            val fields = input.json.decodeFromJsonElement(ConfirmSignIn.HybridArmFields.serializer(), JsonObject(flat.filterKeys { it in fieldKeys }))
            val challenge = input.json.decodeFromJsonElement(Challenge.serializer(), JsonObject(flat.filterKeys { key -> key !in fieldKeys && key != "action" }))
            return ConfirmSignIn(session = fields.session, challenge = challenge)
          }
        }
      }

      @Serializable
      @SerialName("startPasskeyRegistration")
      public data object StartPasskeyRegistration : Input()

      @Serializable
      @SerialName("completePasskeyRegistration")
      public data class CompletePasskeyRegistration(
        public val credential: String,
      ) : Input()

      @Serializable
      @SerialName("listPasskeys")
      public data object ListPasskeys : Input()

      @Serializable
      @SerialName("deletePasskey")
      public data class DeletePasskey(
        public val credentialId: String,
      ) : Input()
    }
  }
}
