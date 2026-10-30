package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.Double
import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement

public class Api(
  private val client: BlocksClient,
) {
  public suspend fun getCoords(): GetCoords.Result {
    val request = BlocksRequest(method = "api.getCoords", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getPair(): GetPair.Result {
    val request = BlocksRequest(method = "api.getPair", params = emptyList(), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun queryRange(range: QueryRange.Range, cursor: QueryRange.Cursor? = null): QueryRange.Result {
    val args: List<JsonElement> = if (cursor != null) listOf(BlocksJson.encodeToJsonElement(range), BlocksJson.encodeToJsonElement(cursor)) else listOf(BlocksJson.encodeToJsonElement(range))
    val request = BlocksRequest(method = "api.queryRange", params = args, id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public suspend fun getShortTuples(one: GetShortTuples.One): GetShortTuples.Result {
    val request = BlocksRequest(method = "api.getShortTuples", params = listOf(BlocksJson.encodeToJsonElement(one)), id = BlocksRequest.nextId())
    val result = client.execute(request)
    return BlocksJson.decodeFromJsonElement(result)
  }

  public object GetCoords {
    @Serializable(with = Result.TupleSerializer::class)
    public data class Result(
      public val item0: Double,
      public val item1: Double,
      public val item2: String,
    ) {
      /**
       * Reads and writes [Result] as a JSON array of its elements, in order.
       */
      public object TupleSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = buildJsonArray {
            add(output.json.encodeToJsonElement<Double>(value.item0))
            add(output.json.encodeToJsonElement<Double>(value.item1))
            add(output.json.encodeToJsonElement<String>(value.item2))
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Result is a JSON array of 3 elements")
          return Result(
            input.json.decodeFromJsonElement<Double>(element.getOrElse(0) { JsonNull }),
            input.json.decodeFromJsonElement<Double>(element.getOrElse(1) { JsonNull }),
            input.json.decodeFromJsonElement<String>(element.getOrElse(2) { JsonNull }),
          )
        }
      }
    }
  }

  public object GetPair {
    @Serializable(with = Result.TupleSerializer::class)
    public data class Result(
      public val item0: String,
      public val item1: Int,
    ) {
      /**
       * Reads and writes [Result] as a JSON array of its elements, in order.
       */
      public object TupleSerializer : KSerializer<Result> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Result")

        override fun serialize(encoder: Encoder, `value`: Result) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Result can only be written as JSON")
          val element = buildJsonArray {
            add(output.json.encodeToJsonElement<String>(value.item0))
            add(output.json.encodeToJsonElement<Int>(value.item1))
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Result {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Result can only be read from JSON")
          val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Result is a JSON array of 2 elements")
          return Result(
            input.json.decodeFromJsonElement<String>(element.getOrElse(0) { JsonNull }),
            input.json.decodeFromJsonElement<Int>(element.getOrElse(1) { JsonNull }),
          )
        }
      }
    }
  }

  public object QueryRange {
    @Serializable
    public data class Result(
      public val `where`: Result.Where,
      public val pairs: List<Result.Pairs>,
    ) {
      @Serializable
      public data class Where(
        public val between: Where.Between,
      ) {
        @Serializable(with = Between.TupleSerializer::class)
        public data class Between(
          public val item0: String,
          public val item1: String,
        ) {
          /**
           * Reads and writes [Between] as a JSON array of its elements, in order.
           */
          public object TupleSerializer : KSerializer<Between> {
            override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Between")

            override fun serialize(encoder: Encoder, `value`: Between) {
              val output = encoder as? JsonEncoder ?: throw SerializationException("Between can only be written as JSON")
              val element = buildJsonArray {
                add(output.json.encodeToJsonElement<String>(value.item0))
                add(output.json.encodeToJsonElement<String>(value.item1))
              }
              output.encodeJsonElement(element)
            }

            override fun deserialize(decoder: Decoder): Between {
              val input = decoder as? JsonDecoder ?: throw SerializationException("Between can only be read from JSON")
              val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Between is a JSON array of 2 elements")
              return Between(
                input.json.decodeFromJsonElement<String>(element.getOrElse(0) { JsonNull }),
                input.json.decodeFromJsonElement<String>(element.getOrElse(1) { JsonNull }),
              )
            }
          }
        }
      }

      @Serializable(with = Pairs.TupleSerializer::class)
      public data class Pairs(
        public val item0: String,
        public val item1: Int,
      ) {
        /**
         * Reads and writes [Pairs] as a JSON array of its elements, in order.
         */
        public object TupleSerializer : KSerializer<Pairs> {
          override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Pairs")

          override fun serialize(encoder: Encoder, `value`: Pairs) {
            val output = encoder as? JsonEncoder ?: throw SerializationException("Pairs can only be written as JSON")
            val element = buildJsonArray {
              add(output.json.encodeToJsonElement<String>(value.item0))
              add(output.json.encodeToJsonElement<Int>(value.item1))
            }
            output.encodeJsonElement(element)
          }

          override fun deserialize(decoder: Decoder): Pairs {
            val input = decoder as? JsonDecoder ?: throw SerializationException("Pairs can only be read from JSON")
            val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Pairs is a JSON array of 2 elements")
            return Pairs(
              input.json.decodeFromJsonElement<String>(element.getOrElse(0) { JsonNull }),
              input.json.decodeFromJsonElement<Int>(element.getOrElse(1) { JsonNull }),
            )
          }
        }
      }
    }

    @Serializable(with = Range.TupleSerializer::class)
    public data class Range(
      public val item0: Double,
      public val item1: Double,
    ) {
      /**
       * Reads and writes [Range] as a JSON array of its elements, in order.
       */
      public object TupleSerializer : KSerializer<Range> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Range")

        override fun serialize(encoder: Encoder, `value`: Range) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Range can only be written as JSON")
          val element = buildJsonArray {
            add(output.json.encodeToJsonElement<Double>(value.item0))
            add(output.json.encodeToJsonElement<Double>(value.item1))
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Range {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Range can only be read from JSON")
          val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Range is a JSON array of 2 elements")
          return Range(
            input.json.decodeFromJsonElement<Double>(element.getOrElse(0) { JsonNull }),
            input.json.decodeFromJsonElement<Double>(element.getOrElse(1) { JsonNull }),
          )
        }
      }
    }

    @Serializable(with = Cursor.TupleSerializer::class)
    public data class Cursor(
      public val item0: String,
      public val item1: Int?,
    ) {
      /**
       * Reads and writes [Cursor] as a JSON array of its elements, in order.
       */
      public object TupleSerializer : KSerializer<Cursor> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Cursor")

        override fun serialize(encoder: Encoder, `value`: Cursor) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("Cursor can only be written as JSON")
          val element = buildJsonArray {
            add(output.json.encodeToJsonElement<String>(value.item0))
            add(output.json.encodeToJsonElement<Int?>(value.item1))
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): Cursor {
          val input = decoder as? JsonDecoder ?: throw SerializationException("Cursor can only be read from JSON")
          val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Cursor is a JSON array of 2 elements")
          return Cursor(
            input.json.decodeFromJsonElement<String>(element.getOrElse(0) { JsonNull }),
            input.json.decodeFromJsonElement<Int?>(element.getOrElse(1) { JsonNull }),
          )
        }
      }
    }
  }

  public object GetShortTuples {
    @Serializable
    public data class Result(
      public val one: Result.One,
      public val short: Result.Short,
    ) {
      @Serializable(with = One.TupleSerializer::class)
      public data class One(
        public val item0: Double,
      ) {
        /**
         * Reads and writes [One] as a JSON array of its elements, in order.
         */
        public object TupleSerializer : KSerializer<One> {
          override val descriptor: SerialDescriptor = buildClassSerialDescriptor("One")

          override fun serialize(encoder: Encoder, `value`: One) {
            val output = encoder as? JsonEncoder ?: throw SerializationException("One can only be written as JSON")
            val element = buildJsonArray {
              add(output.json.encodeToJsonElement<Double>(value.item0))
            }
            output.encodeJsonElement(element)
          }

          override fun deserialize(decoder: Decoder): One {
            val input = decoder as? JsonDecoder ?: throw SerializationException("One can only be read from JSON")
            val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("One is a JSON array of 1 element")
            return One(
              input.json.decodeFromJsonElement<Double>(element.getOrElse(0) { JsonNull }),
            )
          }
        }
      }

      @Serializable(with = Short.TupleSerializer::class)
      public data class Short(
        public val item0: String,
        public val item1: Int?,
      ) {
        /**
         * Reads and writes [Short] as a JSON array of its elements, in order.
         */
        public object TupleSerializer : KSerializer<Short> {
          override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Short")

          override fun serialize(encoder: Encoder, `value`: Short) {
            val output = encoder as? JsonEncoder ?: throw SerializationException("Short can only be written as JSON")
            val element = buildJsonArray {
              add(output.json.encodeToJsonElement<String>(value.item0))
              add(output.json.encodeToJsonElement<Int?>(value.item1))
            }
            output.encodeJsonElement(element)
          }

          override fun deserialize(decoder: Decoder): Short {
            val input = decoder as? JsonDecoder ?: throw SerializationException("Short can only be read from JSON")
            val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("Short is a JSON array of 2 elements")
            return Short(
              input.json.decodeFromJsonElement<String>(element.getOrElse(0) { JsonNull }),
              input.json.decodeFromJsonElement<Int?>(element.getOrElse(1) { JsonNull }),
            )
          }
        }
      }
    }

    @Serializable(with = One.TupleSerializer::class)
    public data class One(
      public val item0: String,
    ) {
      /**
       * Reads and writes [One] as a JSON array of its elements, in order.
       */
      public object TupleSerializer : KSerializer<One> {
        override val descriptor: SerialDescriptor = buildClassSerialDescriptor("One")

        override fun serialize(encoder: Encoder, `value`: One) {
          val output = encoder as? JsonEncoder ?: throw SerializationException("One can only be written as JSON")
          val element = buildJsonArray {
            add(output.json.encodeToJsonElement<String>(value.item0))
          }
          output.encodeJsonElement(element)
        }

        override fun deserialize(decoder: Decoder): One {
          val input = decoder as? JsonDecoder ?: throw SerializationException("One can only be read from JSON")
          val element = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("One is a JSON array of 1 element")
          return One(
            input.json.decodeFromJsonElement<String>(element.getOrElse(0) { JsonNull }),
          )
        }
      }
    }
  }
}

public val Blocks.api: Api
  get() = Api(client())
