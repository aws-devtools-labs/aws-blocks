package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlin.uuid.Uuid
import kotlinx.datetime.Instant
import kotlinx.datetime.LocalDate
import kotlinx.datetime.LocalTime
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getEvent(id: Uuid): GetEvent.Result {
    val request = BlocksRequest(method = "api.getEvent", params = listOf(JsonPrimitive(id.toString())), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetEvent {
    @Serializable
    public data class Result(
      public val id: Uuid,
      public val createdAt: Instant,
      public val date: LocalDate,
      public val time: LocalTime,
      public val url: String,
      public val email: String,
    ) {
      init {
        require(url.startsWith("http://") || url.startsWith("https://")) { "url must be a valid URI" }
        require(email.contains("@") && email.contains(".")) { "email must be a valid email address" }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
