@file:OptIn(ExperimentalSerializationApi::class)

package com.example.app

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Boolean
import kotlin.Double
import kotlin.IllegalArgumentException
import kotlin.Int
import kotlin.OptIn
import kotlin.String
import kotlin.Throwable
import kotlin.collections.List
import kotlin.collections.Map
import kotlinx.datetime.Instant
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject

public class Api(
  private val server: BlocksServer = Servers.local,
) {
  private val client: BlocksClient = BlocksClient(server)

  public suspend fun echoPrimitive(`value`: EchoPrimitive.Value?): EchoPrimitive.Result? {
    val request = BlocksRequest(method = "api.echoPrimitive", params = listOf(BlocksJson.encodeToJsonElement(value)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun echoCollection(`value`: EchoCollection.Value): EchoCollection.Result {
    val request = BlocksRequest(method = "api.echoCollection", params = listOf(BlocksJson.encodeToJsonElement(value)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun echoShape(`value`: EchoShape.Value): EchoShape.Result {
    val request = BlocksRequest(method = "api.echoShape", params = listOf(BlocksJson.encodeToJsonElement(value)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun echoLiteral(`value`: EchoLiteral.Value): EchoLiteral.Result {
    val request = BlocksRequest(method = "api.echoLiteral", params = listOf(BlocksJson.encodeToJsonElement(value)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun echoTagged(`value`: EchoTagged.Value): EchoTagged.Result {
    val request = BlocksRequest(method = "api.echoTagged", params = listOf(BlocksJson.encodeToJsonElement(value)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun echoMoment(`value`: EchoMoment.Value): EchoMoment.Result {
    val request = BlocksRequest(method = "api.echoMoment", params = listOf(BlocksJson.encodeToJsonElement(value)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getFile(): GetFile.Result {
    val request = BlocksRequest(method = "api.getFile", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object EchoPrimitive {
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
            is Variant2 -> output.json.encodeToJsonElement<Int>(value.value)
            is Variant3 -> output.json.encodeToJsonElement<Double>(value.value)
            is Variant4 -> output.json.encodeToJsonElement<Boolean>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.intOrNull != null) {
            try {
              return Variant2(input.json.decodeFromJsonElement<Int>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.doubleOrNull != null) {
            try {
              return Variant3(input.json.decodeFromJsonElement<Double>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.booleanOrNull != null) {
            try {
              return Variant4(input.json.decodeFromJsonElement<Boolean>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected a string; an integer; a number; or a boolean", failure)
        }
      }

      public data class Variant1(
        public val `value`: String,
      ) : Result()

      public data class Variant2(
        public val `value`: Int,
      ) : Result()

      public data class Variant3(
        public val `value`: Double,
      ) : Result()

      public data class Variant4(
        public val `value`: Boolean,
      ) : Result()
    }

    @Serializable(with = Value.ValueSerializer::class)
    public sealed class Value {
      /**
       * Reads and writes [Value] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object ValueSerializer : KSerializer<Value> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Value")

        override fun serialize(encoder: Encoder, `value`: Value) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Value can only be written as JSON")
          val element = when (value) {
            is Variant1 -> output.json.encodeToJsonElement<String>(value.value)
            is Variant2 -> output.json.encodeToJsonElement<Int>(value.value)
            is Variant3 -> output.json.encodeToJsonElement<Double>(value.value)
            is Variant4 -> output.json.encodeToJsonElement<Boolean>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Value {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Value can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.intOrNull != null) {
            try {
              return Variant2(input.json.decodeFromJsonElement<Int>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.doubleOrNull != null) {
            try {
              return Variant3(input.json.decodeFromJsonElement<Double>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.booleanOrNull != null) {
            try {
              return Variant4(input.json.decodeFromJsonElement<Boolean>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Value matches this JSON value; expected a string; an integer; a number; or a boolean", failure)
        }
      }

      public data class Variant1(
        public val `value`: String,
      ) : Value()

      public data class Variant2(
        public val `value`: Int,
      ) : Value()

      public data class Variant3(
        public val `value`: Double,
      ) : Value()

      public data class Variant4(
        public val `value`: Boolean,
      ) : Value()
    }
  }

  public object EchoCollection {
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
            is Variant1 -> output.json.encodeToJsonElement<List<String>>(value.value)
            is Variant2 -> output.json.encodeToJsonElement<Map<String, Int>>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonArray) {
            try {
              return Variant1(input.json.decodeFromJsonElement<List<String>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject) {
            try {
              return Variant2(input.json.decodeFromJsonElement<Map<String, Int>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected an array; or an object", failure)
        }
      }

      public data class Variant1(
        public val `value`: List<String>,
      ) : Result()

      public data class Variant2(
        public val `value`: Map<String, Int>,
      ) : Result()
    }

    @Serializable(with = Value.ValueSerializer::class)
    public sealed class Value {
      /**
       * Reads and writes [Value] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object ValueSerializer : KSerializer<Value> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Value")

        override fun serialize(encoder: Encoder, `value`: Value) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Value can only be written as JSON")
          val element = when (value) {
            is Variant1 -> output.json.encodeToJsonElement<List<String>>(value.value)
            is Variant2 -> output.json.encodeToJsonElement<Map<String, Int>>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Value {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Value can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonArray) {
            try {
              return Variant1(input.json.decodeFromJsonElement<List<String>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject) {
            try {
              return Variant2(input.json.decodeFromJsonElement<Map<String, Int>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Value matches this JSON value; expected an array; or an object", failure)
        }
      }

      public data class Variant1(
        public val `value`: List<String>,
      ) : Value()

      public data class Variant2(
        public val `value`: Map<String, Int>,
      ) : Value()
    }
  }

  public object EchoShape {
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
            is Point -> output.json.encodeToJsonElement(Point.serializer(), value)
            is Variant2 -> output.json.encodeToJsonElement(Variant2.serializer(), value)
            is Variant3 -> output.json.encodeToJsonElement<List<com.example.app.Point>>(value.value)
            is Variant4 -> output.json.encodeToJsonElement<Map<String, String>>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonObject && "x" in element && "y" in element) {
            try {
              return input.json.decodeFromJsonElement(Point.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject && "label" in element) {
            try {
              return input.json.decodeFromJsonElement(Variant2.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonArray) {
            try {
              return Variant3(input.json.decodeFromJsonElement<List<com.example.app.Point>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject) {
            try {
              return Variant4(input.json.decodeFromJsonElement<Map<String, String>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected an object with \"x\", \"y\"; an object with \"label\"; an array; or an object", failure)
        }
      }

      @Serializable
      public data class Point(
        public val x: Double,
        public val y: Double,
      ) : Result()

      @Serializable
      public data class Variant2(
        public val label: String,
        public val tags: List<String>? = null,
      ) : Result()

      public data class Variant3(
        public val `value`: List<com.example.app.Point>,
      ) : Result()

      public data class Variant4(
        public val `value`: Map<String, String>,
      ) : Result()
    }

    @Serializable(with = Value.ValueSerializer::class)
    public sealed class Value {
      /**
       * Reads and writes [Value] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object ValueSerializer : KSerializer<Value> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Value")

        override fun serialize(encoder: Encoder, `value`: Value) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Value can only be written as JSON")
          val element = when (value) {
            is Point -> output.json.encodeToJsonElement(Point.serializer(), value)
            is Variant2 -> output.json.encodeToJsonElement(Variant2.serializer(), value)
            is Variant3 -> output.json.encodeToJsonElement<List<com.example.app.Point>>(value.value)
            is Variant4 -> output.json.encodeToJsonElement<Map<String, String>>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Value {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Value can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonObject && "x" in element && "y" in element) {
            try {
              return input.json.decodeFromJsonElement(Point.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject && "label" in element) {
            try {
              return input.json.decodeFromJsonElement(Variant2.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonArray) {
            try {
              return Variant3(input.json.decodeFromJsonElement<List<com.example.app.Point>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject) {
            try {
              return Variant4(input.json.decodeFromJsonElement<Map<String, String>>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Value matches this JSON value; expected an object with \"x\", \"y\"; an object with \"label\"; an array; or an object", failure)
        }
      }

      @Serializable
      public data class Point(
        public val x: Double,
        public val y: Double,
      ) : Value()

      @Serializable
      public data class Variant2(
        public val label: String,
        public val tags: List<String>? = null,
      ) : Value()

      public data class Variant3(
        public val `value`: List<com.example.app.Point>,
      ) : Value()

      public data class Variant4(
        public val `value`: Map<String, String>,
      ) : Value()
    }
  }

  public object EchoLiteral {
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
            is Variant1 -> JsonPrimitive("auto")
            is Variant2 -> JsonPrimitive(5L)
            is Variant3 -> JsonPrimitive(true)
            is Variant4 -> output.json.encodeToJsonElement<String>(value.value)
            is Variant5 -> output.json.encodeToJsonElement(Variant5.serializer(), value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element == JsonPrimitive("auto")) return Variant1
          if (element == JsonPrimitive(5L)) return Variant2
          if (element == JsonPrimitive(true)) return Variant3
          if (element in setOf(JsonPrimitive("small"), JsonPrimitive("large"))) {
            try {
              return Variant4(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject && "size" in element) {
            try {
              return input.json.decodeFromJsonElement(Variant5.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected \"auto\"; 5; true; \"small\" or \"large\"; or an object with \"size\"", failure)
        }
      }

      /**
       * The literal `"auto"`.
       */
      public data object Variant1 : Result()

      /**
       * The literal `5`.
       */
      public data object Variant2 : Result()

      /**
       * The literal `true`.
       */
      public data object Variant3 : Result()

      public data class Variant4(
        public val `value`: String,
      ) : Result()

      @Serializable
      public data class Variant5(
        public val size: Double,
      ) : Result()
    }

    @Serializable(with = Value.ValueSerializer::class)
    public sealed class Value {
      /**
       * Reads and writes [Value] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object ValueSerializer : KSerializer<Value> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Value")

        override fun serialize(encoder: Encoder, `value`: Value) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Value can only be written as JSON")
          val element = when (value) {
            is Variant1 -> JsonPrimitive("auto")
            is Variant2 -> JsonPrimitive(5L)
            is Variant3 -> JsonPrimitive(true)
            is Variant4 -> output.json.encodeToJsonElement<String>(value.value)
            is Variant5 -> output.json.encodeToJsonElement(Variant5.serializer(), value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Value {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Value can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element == JsonPrimitive("auto")) return Variant1
          if (element == JsonPrimitive(5L)) return Variant2
          if (element == JsonPrimitive(true)) return Variant3
          if (element in setOf(JsonPrimitive("small"), JsonPrimitive("large"))) {
            try {
              return Variant4(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject && "size" in element) {
            try {
              return input.json.decodeFromJsonElement(Variant5.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Value matches this JSON value; expected \"auto\"; 5; true; \"small\" or \"large\"; or an object with \"size\"", failure)
        }
      }

      /**
       * The literal `"auto"`.
       */
      public data object Variant1 : Value()

      /**
       * The literal `5`.
       */
      public data object Variant2 : Value()

      /**
       * The literal `true`.
       */
      public data object Variant3 : Value()

      public data class Variant4(
        public val `value`: String,
      ) : Value()

      @Serializable
      public data class Variant5(
        public val size: Double,
      ) : Value()
    }
  }

  public object EchoTagged {
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
            is Variant1 -> output.json.encodeToJsonElement<String>(value.value)
            is Circle -> buildJsonObject {
              put("kind", JsonPrimitive("circle"))
              output.json.encodeToJsonElement(Circle.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is Square -> buildJsonObject {
              put("kind", JsonPrimitive("square"))
              output.json.encodeToJsonElement(Square.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject) {
            val fields = JsonObject(element - "kind")
            when (element["kind"]) {
              JsonPrimitive("circle") -> return input.json.decodeFromJsonElement(Circle.serializer(), fields)
              JsonPrimitive("square") -> return input.json.decodeFromJsonElement(Square.serializer(), fields)
              else -> {}
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected a string; an object with \"kind\": \"circle\"; or an object with \"kind\": \"square\"", failure)
        }
      }

      public data class Variant1(
        public val `value`: String,
      ) : Result()

      @Serializable
      @SerialName("circle")
      public data class Circle(
        public val radius: Double,
      ) : Result()

      @Serializable
      @SerialName("square")
      public data class Square(
        public val side: Double,
      ) : Result()
    }

    @Serializable(with = Value.ValueSerializer::class)
    public sealed class Value {
      /**
       * Reads and writes [Value] with its discriminator `kind` as the JSON value
       * the spec gives it.
       */
      public object ValueSerializer : KSerializer<Value> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Value")

        override fun serialize(encoder: Encoder, `value`: Value) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Value can only be written as JSON")
          val element = when (value) {
            is Variant1 -> output.json.encodeToJsonElement<String>(value.value)
            is Circle -> buildJsonObject {
              put("kind", JsonPrimitive("circle"))
              output.json.encodeToJsonElement(Circle.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
            is Square -> buildJsonObject {
              put("kind", JsonPrimitive("square"))
              output.json.encodeToJsonElement(Square.serializer(), value).jsonObject.forEach { (key, field) -> put(key, field) }
            }
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Value {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Value can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<String>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject) {
            val fields = JsonObject(element - "kind")
            when (element["kind"]) {
              JsonPrimitive("circle") -> return input.json.decodeFromJsonElement(Circle.serializer(), fields)
              JsonPrimitive("square") -> return input.json.decodeFromJsonElement(Square.serializer(), fields)
              else -> {}
            }
          }
          throw SerializationException("No variant of Value matches this JSON value; expected a string; an object with \"kind\": \"circle\"; or an object with \"kind\": \"square\"", failure)
        }
      }

      public data class Variant1(
        public val `value`: String,
      ) : Value()

      @Serializable
      @SerialName("circle")
      public data class Circle(
        public val radius: Double,
      ) : Value()

      @Serializable
      @SerialName("square")
      public data class Square(
        public val side: Double,
      ) : Value()
    }
  }

  public object EchoMoment {
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
            is Variant1 -> output.json.encodeToJsonElement<Instant>(value.value)
            is Variant2 -> output.json.encodeToJsonElement<Int>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<Instant>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.intOrNull != null) {
            try {
              return Variant2(input.json.decodeFromJsonElement<Int>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected a date-time string; or an integer", failure)
        }
      }

      public data class Variant1(
        public val `value`: Instant,
      ) : Result()

      public data class Variant2(
        public val `value`: Int,
      ) : Result()
    }

    @Serializable(with = Value.ValueSerializer::class)
    public sealed class Value {
      /**
       * Reads and writes [Value] as the bare JSON value of its variant. It has no discriminator, so a
       * value decodes to the first variant, in spec order, whose JSON shape it has.
       */
      public object ValueSerializer : KSerializer<Value> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Value")

        override fun serialize(encoder: Encoder, `value`: Value) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Value can only be written as JSON")
          val element = when (value) {
            is Variant1 -> output.json.encodeToJsonElement<Instant>(value.value)
            is Variant2 -> output.json.encodeToJsonElement<Int>(value.value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Value {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Value can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonPrimitive && element.isString) {
            try {
              return Variant1(input.json.decodeFromJsonElement<Instant>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonPrimitive && !element.isString && element.intOrNull != null) {
            try {
              return Variant2(input.json.decodeFromJsonElement<Int>(element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Value matches this JSON value; expected a date-time string; or an integer", failure)
        }
      }

      public data class Variant1(
        public val `value`: Instant,
      ) : Value()

      public data class Variant2(
        public val `value`: Int,
      ) : Value()
    }
  }

  public object GetFile {
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
            is Variant1 -> output.json.encodeToJsonElement(FileDownloadHandleSerializer, value.value)
            is Variant2 -> output.json.encodeToJsonElement(Variant2.serializer(), value)
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement()
          var failure: Throwable? = null
          if (element is JsonObject && element["__blocks"] == JsonPrimitive("file-bucket/download")) {
            try {
              return Variant1(input.json.decodeFromJsonElement(FileDownloadHandleSerializer, element))
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          if (element is JsonObject && "reason" in element) {
            try {
              return input.json.decodeFromJsonElement(Variant2.serializer(), element)
            } catch (e: IllegalArgumentException) {
              failure = e
            }
          }
          throw SerializationException("No variant of Result matches this JSON value; expected a file-bucket/download transferable; or an object with \"reason\"", failure)
        }
      }

      public data class Variant1(
        public val `value`: FileDownloadHandle,
      ) : Result()

      @Serializable
      public data class Variant2(
        public val reason: String,
      ) : Result()
    }
  }
}
