package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.filebucket.FileUploadHandle
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.String
import kotlin.collections.List
import kotlin.collections.Map
import kotlin.collections.Set
import kotlinx.serialization.Contextual
import kotlinx.serialization.KSerializer
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
public data class Attachment(
  public val name: String,
  @Serializable(with = FileDownloadHandleSerializer::class)
  public val `file`: FileDownloadHandle,
  public val previews:
      List<@Serializable(with = FileDownloadHandleSerializer::class) FileDownloadHandle>,
)

@Serializable
public data class Lobby(
  @Serializable(with = RealtimeChannelListRealtimeChannelNoteSerializer::class)
  public val rooms: RealtimeChannel<List<RealtimeChannel<Note>>>,
  public val roomGroups:
      List<@Serializable(with = RealtimeChannelListRealtimeChannelNoteSerializer::class) RealtimeChannel<List<@Serializable(with = RealtimeChannelNoteSerializer::class) RealtimeChannel<Note>>>>,
  public val uploadsByRoom:
      Map<String, @Serializable(with = RealtimeChannelFileUploadHandleSerializer::class) RealtimeChannel<@Serializable(with = FileUploadHandleSerializer::class) FileUploadHandle>>,
)

@Serializable
public data class Note(
  public val id: String,
  public val text: String,
)

@Serializable(with = ProviderDirectory.OpenRecordSerializer::class)
public data class ProviderDirectory(
  public val title: String,
  public val attributes: Map<String, @Contextual OidcClient> = emptyMap(),
) {
  @Serializable
  private data class OpenRecordFields(
    public val title: String,
    public val attributes: Map<String, @Contextual OidcClient> = emptyMap(),
  )

  /**
   * Writes [attributes] flat into the JSON object, beside the properties (the wire shape of
   * `additionalProperties`), and reads every key that isn't a property back into it.
   */
  internal object OpenRecordSerializer : KSerializer<ProviderDirectory> {
    private val fieldKeys: Set<String> = setOf("title")

    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("ProviderDirectory")

    override fun serialize(encoder: Encoder, `value`: ProviderDirectory) {
      val output = encoder as JsonEncoder
      val fields = output.json.encodeToJsonElement(ProviderDirectory.OpenRecordFields.serializer(), ProviderDirectory.OpenRecordFields(value.title, value.attributes)).jsonObject
      val flat = buildJsonObject {
        for ((key, element) in fields) if (key != "attributes") put(key, element)
        fields["attributes"]?.jsonObject?.forEach { (key, element) -> if (key !in fieldKeys) put(key, element) }
      }
      output.encodeJsonElement(flat)
    }

    override fun deserialize(decoder: Decoder): ProviderDirectory {
      val input = decoder as JsonDecoder
      val flat = input.decodeJsonElement().jsonObject
      val nested = buildJsonObject {
        for ((key, element) in flat) if (key in fieldKeys) put(key, element)
        put("attributes", buildJsonObject { for ((key, element) in flat) if (key !in fieldKeys) put(key, element) })
      }
      val fields = input.json.decodeFromJsonElement(ProviderDirectory.OpenRecordFields.serializer(), nested)
      return ProviderDirectory(fields.title, fields.attributes)
    }
  }
}

@Serializable
public data class SignInBoard(
  public val feeds:
      List<@Serializable(with = RealtimeChannelSignInOptionSerializer::class) RealtimeChannel<SignInOption>>,
  public val clientsByTenant:
      Map<String, @Serializable(with = RealtimeChannelListOidcClientSerializer::class) RealtimeChannel<List<@Contextual OidcClient>>>,
)

@Serializable
public data class SignInOption(
  public val label: String,
  @Contextual
  public val client: OidcClient,
)
