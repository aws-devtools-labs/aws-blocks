package com.example.app

import kotlin.Int
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlin.collections.Set
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject

/**
 * A string enum that keeps a value this client was generated without as [Unknown].
 */
@Serializable(with = Level.Serializer::class)
public sealed class Level {
  /**
   * The value as it is sent on the wire.
   */
  public abstract val `value`: String

  public data object Values : Level() {
    override val `value`: String = "values"
  }

  public data object Index : Level() {
    override val `value`: String = "index"
  }

  public data object Name : Level() {
    override val `value`: String = "name"
  }

  public data object Hidden : Level() {
    override val `value`: String = "_hidden"
  }

  public data object Ok : Level() {
    override val `value`: String = "ok"
  }

  /**
   * A value this client was generated without, as the server sent it.
   */
  public data class Unknown(
    override val `value`: String,
  ) : Level()

  public companion object {
    /**
     * The known values, in the spec's order.
     */
    public val entries: List<Level> by lazy { listOf(Values, Index, Name, Hidden, Ok) }

    /**
     * The case for [value]: a known one, else [Unknown].
     */
    public fun fromValue(`value`: String): Level = entries.firstOrNull { it.value == value } ?: Unknown(value)
  }

  public object Serializer : KSerializer<Level> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.example.app.Level", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, `value`: Level) {
      encoder.encodeString(value.value)
    }

    override fun deserialize(decoder: Decoder): Level = fromValue(decoder.decodeString())
  }
}

@Serializable
public data class Doc(
  public val _id: String,
  public val __v: Int? = null,
  public val toJson: String,
  public val fromJson: String,
  public val hashCode: Int,
  public val toString: String,
  public val int: Int,
  public val String: String,
  public val level: Level,
)

@Serializable(with = Extras.OpenRecordSerializer::class)
public data class Extras(
  public val additionalProperties: String,
  public val id: String,
  public val attributes: Map<String, Int> = emptyMap(),
) {
  @Serializable
  private data class OpenRecordFields(
    public val additionalProperties: String,
    public val id: String,
    public val attributes: Map<String, Int> = emptyMap(),
  )

  /**
   * Writes [attributes] flat into the JSON object, beside the properties (the wire shape of
   * `additionalProperties`), and reads every key that isn't a property back into it.
   */
  internal object OpenRecordSerializer : KSerializer<Extras> {
    private val fieldKeys: Set<String> = setOf("additionalProperties", "id")

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Extras")

    override fun serialize(encoder: Encoder, `value`: Extras) {
      val output = encoder as JsonEncoder
      val fields = output.json.encodeToJsonElement(Extras.OpenRecordFields.serializer(), Extras.OpenRecordFields(value.additionalProperties, value.id, value.attributes)).jsonObject
      val flat = buildJsonObject {
        for ((key, element) in fields) if (key != "attributes") put(key, element)
        fields["attributes"]?.jsonObject?.forEach { (key, element) -> if (key !in fieldKeys) put(key, element) }
      }
      output.encodeJsonElement(flat)
    }

    override fun deserialize(decoder: Decoder): Extras {
      val input = decoder as JsonDecoder
      val flat = input.decodeJsonElement().jsonObject
      val nested = buildJsonObject {
        for ((key, element) in flat) if (key in fieldKeys) put(key, element)
        put("attributes", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys) put(key, element) })
      }
      val fields = input.json.decodeFromJsonElement(Extras.OpenRecordFields.serializer(), nested)
      return Extras(fields.additionalProperties, fields.id, fields.attributes)
    }
  }
}
