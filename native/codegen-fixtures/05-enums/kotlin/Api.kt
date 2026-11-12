package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksRequest
import com.aws.blocks.kotlin.json.BlocksJson
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
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
      /**
       * A string enum that keeps a value this client was generated without as [Unknown].
       */
      @Serializable(with = Status.Serializer::class)
      public sealed class Status {
        /**
         * The value as it is sent on the wire.
         */
        public abstract val `value`: String

        public data object Active : Status() {
          override val `value`: String = "active"
        }

        public data object Inactive : Status() {
          override val `value`: String = "inactive"
        }

        public data object Pending : Status() {
          override val `value`: String = "pending"
        }

        /**
         * A value this client was generated without, as the server sent it.
         */
        public data class Unknown(
          override val `value`: String,
        ) : Status()

        public companion object {
          /**
           * The known values, in the spec's order.
           */
          public val entries: List<Status> by lazy { listOf(Active, Inactive, Pending) }

          /**
           * The case for [value]: a known one, else [Unknown].
           */
          public fun fromValue(`value`: String): Status = entries.firstOrNull { it.value == value } ?: Unknown(value)
        }

        public object Serializer : KSerializer<Status> {
          override val descriptor: SerialDescriptor =
              PrimitiveSerialDescriptor("com.example.app.Status", PrimitiveKind.STRING)

          override fun serialize(encoder: Encoder, `value`: Status) {
            encoder.encodeString(value.value)
          }

          override fun deserialize(decoder: Decoder): Status = fromValue(decoder.decodeString())
        }
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
  get() = Api(client())
