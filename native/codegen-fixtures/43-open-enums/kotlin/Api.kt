@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Boolean
import kotlin.OptIn
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getTask(id: String): Task {
    val request = BlocksRequest(method = "api.getTask", params = listOf(JsonPrimitive(id)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun updateTask(
    id: String,
    status: Status,
    sort: UpdateTask.Sort? = null,
  ): UpdateTask.Result {
    val args: List<JsonElement> = if (sort != null) listOf(JsonPrimitive(id), BlocksJson.encodeToJsonElement(status), BlocksJson.encodeToJsonElement(sort)) else listOf(JsonPrimitive(id), BlocksJson.encodeToJsonElement(status))
    val request = BlocksRequest(method = "api.updateTask", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getEvent(): GetEvent.Result {
    val request = BlocksRequest(method = "api.getEvent", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun watchTasks(): RealtimeChannel<WatchTasks.Result> {
    val request = BlocksRequest(method = "api.watchTasks", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return RealtimeChannel.fromJson(result) { BlocksJson.decodeFromJsonElement<WatchTasks.Result>(it) }
  }

  public object UpdateTask {
    @Serializable
    public data class Result(
      public val ok: Boolean,
    )

    @Serializable
    public enum class Sort {
      @SerialName("newest")
      Newest,
      @SerialName("oldest")
      Oldest,
    }
  }

  public object GetEvent {
    @Serializable
    @JsonClassDiscriminator("kind")
    public sealed class Result {
      @Serializable
      @SerialName("moved")
      public data class Moved(
        public val to: Status,
      ) : Result()

      @Serializable
      @SerialName("flagged")
      public data class Flagged(
        public val severity: Flagged.Severity,
      ) : Result() {
        @Serializable
        public enum class Severity {
          @SerialName("low")
          Low,
          @SerialName("high")
          High,
        }
      }
    }
  }

  public object WatchTasks {
    @Serializable
    public data class Result(
      public val taskId: String,
      public val change: Result.Change,
    ) {
      @Serializable
      public enum class Change {
        @SerialName("created")
        Created,
        @SerialName("deleted")
        Deleted,
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
