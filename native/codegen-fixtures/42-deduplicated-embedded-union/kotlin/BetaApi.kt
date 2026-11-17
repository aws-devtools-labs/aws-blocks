@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.OptIn
import kotlin.String
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
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

public class BetaApi(
  private val client: BlocksClient,
) {
  public suspend fun setState(input: SetState.Input): Boolean {
    val request = BlocksRequest(method = "betaApi.setState", params = listOf(BlocksJson.encodeToJsonElement(input)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SetState {
    @Serializable
    @JsonClassDiscriminator("action")
    public sealed class Input {
      @Serializable
      @SerialName("signIn")
      public data class SignIn(
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
          @SerialName("newPassword")
          public data class NewPassword(
            public val newPassword: String,
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
    }
  }
}

public val Blocks.betaApi: BetaApi
  get() = BetaApi(client())
