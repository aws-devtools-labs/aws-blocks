@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.OptIn
import kotlin.String
import kotlin.collections.Map
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonContentPolymorphicSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun updateAttributes(attributes: Map<String, String>): Map<String, UpdateAttributes.Result?> {
    val request = BlocksRequest(method = "api.updateAttributes", params = listOf(buildJsonObject { attributes.forEach { put(it.key, it.value) } }), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getNotification(id: String): GetNotification.Result? {
    val request = BlocksRequest(method = "api.getNotification", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object UpdateAttributes {
    @Serializable(with = Result.ResultSerializer::class)
    public sealed class Result {
      public object ResultSerializer : JsonContentPolymorphicSerializer<Result>(Result::class) {
        override fun selectDeserializer(element: JsonElement): DeserializationStrategy<Result> {
          val disc = element.jsonObject["isUpdated"]?.jsonPrimitive?.boolean
          return when (disc) {
            true -> Result.IsUpdatedTrue.serializer()
            false -> Result.IsUpdatedFalse.serializer()
            else -> error("Unknown isUpdated value: ${'$'}disc")
          }
        }
      }

      @Serializable
      @SerialName("true")
      public data object IsUpdatedTrue : Result()

      @Serializable
      @SerialName("false")
      public data class IsUpdatedFalse(
        public val nextStep: IsUpdatedFalse.NextStep,
      ) : Result() {
        @Serializable
        public data class NextStep(
          public val name: String,
          public val destination: String,
        )
      }
    }
  }

  public object GetNotification {
    @Serializable
    @JsonClassDiscriminator("type")
    public sealed class Result {
      @Serializable
      @SerialName("email")
      public data class Email(
        public val subject: String,
        public val body: String,
      ) : Result()

      @Serializable
      @SerialName("sms")
      public data class Sms(
        public val message: String,
      ) : Result()
    }
  }
}
