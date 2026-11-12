@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Boolean
import kotlin.IllegalArgumentException
import kotlin.OptIn
import kotlin.String
import kotlin.Throwable
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
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

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

  public suspend fun getColor(): Color {
    val request = BlocksRequest(method = "api.getColor", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getSwatch(): GetSwatch.Result {
    val request = BlocksRequest(method = "api.getSwatch", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun setMode(mode: Mode): Boolean {
    val request = BlocksRequest(method = "api.setMode", params = listOf(BlocksJson.encodeToJsonElement(mode)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getSettings(): GetSettings.Result {
    val request = BlocksRequest(method = "api.getSettings", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getTree(): Node {
    val request = BlocksRequest(method = "api.getTree", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getRange(): GetRange.Result {
    val request = BlocksRequest(method = "api.getRange", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getLabels(): Labels {
    val request = BlocksRequest(method = "api.getLabels", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
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
    @Serializable(with = Result.ResultSerializer::class)
    public sealed class Result {
      /**
       * Reads and writes [Result] with its discriminator `kind` as the JSON value
       * the spec gives it.
       */
      public object ResultSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = when (value) {
            is Moved -> buildJsonObject {
              put("kind", JsonPrimitive("moved"))
              output.json.encodeToJsonElement(Moved.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is Flagged -> buildJsonObject {
              put("kind", JsonPrimitive("flagged"))
              output.json.encodeToJsonElement(Flagged.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is Unknown -> value.json
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          if (element is JsonObject) {
            val fields = JsonObject(element - "kind")
            when (element["kind"]) {
              JsonPrimitive("moved") -> return input.json.decodeFromJsonElement(Moved.serializer(), fields)
              JsonPrimitive("flagged") -> return input.json.decodeFromJsonElement(Flagged.serializer(), fields)
              else -> return Unknown(element)
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected an object with \"kind\": \"moved\"; or an object with \"kind\": \"flagged\"")
        }
      }

      /**
       * An arm this client was generated without: the object as the server sent it.
       */
      public data class Unknown(
        public val json: JsonObject,
      ) : Result()

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

  public object GetSwatch {
    @Serializable(with = Result.ResultSerializer::class)
    public sealed class Result {
      /**
       * Reads and writes [Result] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object ResultSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = when (value) {
            is Variant1 -> output.json.encodeToJsonElement<String>(value.value)
            is Variant2 -> output.json.encodeToJsonElement<String>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element in setOf(JsonPrimitive("red"), JsonPrimitive("blue"))) {
            try {
              return Variant1(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element in setOf(JsonPrimitive("small"), JsonPrimitive("large"))) {
            try {
              return Variant2(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected \"red\" or \"blue\"; or \"small\" or \"large\"", failure)
        }
      }

      public data class Variant1(
        public val `value`: String,
      ) : Result()

      public data class Variant2(
        public val `value`: String,
      ) : Result()
    }
  }

  public object GetSettings {
    @Serializable
    public data class Result(
      public val mode: Result.Mode,
    ) {
      /**
       * A string enum that keeps a value this client was generated without as [Unknown].
       */
      @Serializable(with = Mode.Serializer::class)
      public sealed class Mode {
        /**
         * The value as it is sent on the wire.
         */
        public abstract val `value`: String

        public data object Light : Mode() {
          override val `value`: String = "light"
        }

        public data object Dark : Mode() {
          override val `value`: String = "dark"
        }

        /**
         * A value this client was generated without, as the server sent it.
         */
        public data class Unknown(
          override val `value`: String,
        ) : Mode()

        public companion object {
          /**
           * The known values, in the spec's order.
           */
          public val entries: List<Mode> by lazy { listOf(Light, Dark) }

          /**
           * The case for [value]: a known one, else [Unknown].
           */
          public fun fromValue(`value`: String): Mode = entries.firstOrNull { it.value == value } ?: Unknown(value)
        }

        public object Serializer : KSerializer<Mode> {
          override val descriptor: SerialDescriptor =
              PrimitiveSerialDescriptor("com.example.app.Mode", PrimitiveKind.STRING)

          override fun serialize(encoder: Encoder, `value`: Mode) {
            encoder.encodeString(value.value)
          }

          override fun deserialize(decoder: Decoder): Mode = fromValue(decoder.decodeString())
        }
      }
    }
  }

  public object GetRange {
    @Serializable(with = Result.TupleSerializer::class)
    public data class Result(
      public val item0: Size,
      public val item1: Result.Item1,
    ) {
      /**
       * Reads and writes [Result] as a JSON array of its elements, in order.
       */
      public object TupleSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = buildJsonArray {
            add(output.json.encodeToJsonElement<Size>(value.item0))
            add(output.json.encodeToJsonElement<Result.Item1>(value.item1))
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Result is a JSON array of 2 elements")
          return Result(
            input.json.decodeFromJsonElement<Size>(element.getOrElse(0) { JsonNull }),
            input.json.decodeFromJsonElement<Result.Item1>(element.getOrElse(1) { JsonNull }),
          )
        }
      }

      /**
       * A string enum that keeps a value this client was generated without as [Unknown].
       */
      @Serializable(with = Item1.Serializer::class)
      public sealed class Item1 {
        /**
         * The value as it is sent on the wire.
         */
        public abstract val `value`: String

        public data object Up : Item1() {
          override val `value`: String = "up"
        }

        public data object Down : Item1() {
          override val `value`: String = "down"
        }

        /**
         * A value this client was generated without, as the server sent it.
         */
        public data class Unknown(
          override val `value`: String,
        ) : Item1()

        public companion object {
          /**
           * The known values, in the spec's order.
           */
          public val entries: List<Item1> by lazy { listOf(Up, Down) }

          /**
           * The case for [value]: a known one, else [Unknown].
           */
          public fun fromValue(`value`: String): Item1 = entries.firstOrNull { it.value == value } ?: Unknown(value)
        }

        public object Serializer : KSerializer<Item1> {
          override val descriptor: SerialDescriptor =
              PrimitiveSerialDescriptor("com.example.app.Item1", PrimitiveKind.STRING)

          override fun serialize(encoder: Encoder, `value`: Item1) {
            encoder.encodeString(value.value)
          }

          override fun deserialize(decoder: Decoder): Item1 = fromValue(decoder.decodeString())
        }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
