package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun setStatus(status: SetStatus.Status): SetStatus.Result {
    val request = BlocksRequest(method = "api.setStatus", params = listOf(BlocksJson.encodeToJsonElement(status)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object SetStatus {
    @Serializable
    public data class Result(
      public val status: Result.Status,
      public val updatedAt: String,
    ) {
      @Serializable
      public enum class Status {
        @SerialName("active")
        Active,
        @SerialName("inactive")
        Inactive,
        @SerialName("pending")
        Pending,
      }
    }

    @Serializable
    public enum class Status {
      @SerialName("active")
      Active,
      @SerialName("inactive")
      Inactive,
      @SerialName("pending")
      Pending,
    }
  }
}

public val Blocks.api: Api
  get() = Api(client)
