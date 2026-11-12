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
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
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
        /**
         * A string enum that keeps a value this client was generated without as [Unknown].
         */
        @Serializable(with = Severity.Serializer::class)
        public sealed class Severity {
          /**
           * The value as it is sent on the wire.
           */
          public abstract val `value`: String

          public data object Low : Severity() {
            override val `value`: String = "low"
          }

          public data object High : Severity() {
            override val `value`: String = "high"
          }

          /**
           * A value this client was generated without, as the server sent it.
           */
          public data class Unknown(
            override val `value`: String,
          ) : Severity()

          public companion object {
            /**
             * The known values, in the spec's order.
             */
            public val entries: List<Severity> by lazy { listOf(Low, High) }

            /**
             * The case for [value]: a known one, else [Unknown].
             */
            public fun fromValue(`value`: String): Severity = entries.firstOrNull { it.value == value } ?: Unknown(value)
          }

          public object Serializer : KSerializer<Severity> {
            override val descriptor: SerialDescriptor =
                PrimitiveSerialDescriptor("com.example.app.Severity", PrimitiveKind.STRING)

            override fun serialize(encoder: Encoder, `value`: Severity) {
              encoder.encodeString(value.value)
            }

            override fun deserialize(decoder: Decoder): Severity = fromValue(decoder.decodeString())
          }
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
      /**
       * A string enum that keeps a value this client was generated without as [Unknown].
       */
      @Serializable(with = Change.Serializer::class)
      public sealed class Change {
        /**
         * The value as it is sent on the wire.
         */
        public abstract val `value`: String

        public data object Created : Change() {
          override val `value`: String = "created"
        }

        public data object Deleted : Change() {
          override val `value`: String = "deleted"
        }

        /**
         * A value this client was generated without, as the server sent it.
         */
        public data class Unknown(
          override val `value`: String,
        ) : Change()

        public companion object {
          /**
           * The known values, in the spec's order.
           */
          public val entries: List<Change> by lazy { listOf(Created, Deleted) }

          /**
           * The case for [value]: a known one, else [Unknown].
           */
          public fun fromValue(`value`: String): Change = entries.firstOrNull { it.value == value } ?: Unknown(value)
        }

        public object Serializer : KSerializer<Change> {
          override val descriptor: SerialDescriptor =
              PrimitiveSerialDescriptor("com.example.app.Change", PrimitiveKind.STRING)

          override fun serialize(encoder: Encoder, `value`: Change) {
            encoder.encodeString(value.value)
          }

          override fun deserialize(decoder: Decoder): Change = fromValue(decoder.decodeString())
        }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
