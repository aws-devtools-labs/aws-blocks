package com.example.app

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

@Serializable(with = Bag.OpenRecordSerializer::class)
public data class Bag(
  public val attributes: String,
  public val attributes_2: Map<String, String> = emptyMap(),
) {
  @Serializable
  private data class OpenRecordFields(
    public val attributes: String,
    public val attributes_2: Map<String, String> = emptyMap(),
  )

  /**
   * Writes [attributes_2] flat into the JSON object, beside the properties (the wire shape of
   * `additionalProperties`), and reads every key that isn't a property back into it.
   */
  internal object OpenRecordSerializer : KSerializer<Bag> {
    private val fieldKeys: Set<String> = setOf("attributes")

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("Bag")

    override fun serialize(encoder: Encoder, `value`: Bag) {
      val output = encoder as JsonEncoder
      val fields = output.json.encodeToJsonElement(Bag.OpenRecordFields.serializer(), Bag.OpenRecordFields(value.attributes, value.attributes_2)).jsonObject
      val flat = buildJsonObject {
        for ((key, element) in fields) if (key != "attributes_2") put(key, element)
        fields["attributes_2"]?.jsonObject?.forEach { (key, element) -> if (key !in fieldKeys) put(key, element) }
      }
      output.encodeJsonElement(flat)
    }

    override fun deserialize(decoder: Decoder): Bag {
      val input = decoder as JsonDecoder
      val flat = input.decodeJsonElement().jsonObject
      val nested = buildJsonObject {
        for ((key, element) in flat) if (key in fieldKeys) put(key, element)
        put("attributes_2", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys) put(key, element) })
      }
      val fields = input.json.decodeFromJsonElement(Bag.OpenRecordFields.serializer(), nested)
      return Bag(fields.attributes, fields.attributes_2)
    }
  }
}

@Serializable
public data class Profile(
  public val user_name: UserName,
  public val userName: UserName_2,
  public val Meta: Meta_2,
  public val state: State,
) {
  @Serializable
  public enum class State {
    @SerialName("in-progress")
    InProgress,
    @SerialName("in_progress")
    InProgress_2,
  }

  @Serializable
  public data class Meta_2(
    public val x: String,
  )

  @Serializable
  public data class UserName(
    public val first: String,
  )

  @Serializable
  public data class UserName_2(
    public val last: String,
  )
}

@Serializable
public data class Weird(
  @SerialName("back\\slash")
  public val backSlash: String,
)
