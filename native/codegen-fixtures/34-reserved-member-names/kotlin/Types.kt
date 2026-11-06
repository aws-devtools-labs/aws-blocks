package com.example.app

import kotlin.Int
import kotlin.String
import kotlin.collections.Map
import kotlin.collections.Set
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
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

@Serializable
public enum class Level {
  @SerialName("values")
  Values,
  @SerialName("index")
  Index,
  @SerialName("name")
  Name,
  @SerialName("_hidden")
  Hidden,
  @SerialName("ok")
  Ok,
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
