package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.filebucket.FileUploadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.oidc.AnyProvider
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.decodeFromJsonElement

public object FileDownloadHandleSerializer : KSerializer<FileDownloadHandle> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("FileDownloadHandleSerializer")

  override fun deserialize(decoder: Decoder): FileDownloadHandle {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return FileDownloadHandle.fromJson(element)
  }

  override fun serialize(encoder: Encoder, `value`: FileDownloadHandle) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelNoteSerializer : KSerializer<RealtimeChannel<Note>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelNoteSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Note> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Note>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Note>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelListRealtimeChannelNoteSerializer : KSerializer<RealtimeChannel<List<RealtimeChannel<Note>>>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelListRealtimeChannelNoteSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<List<RealtimeChannel<Note>>> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement(ListSerializer(RealtimeChannelNoteSerializer), it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<List<RealtimeChannel<Note>>>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object FileUploadHandleSerializer : KSerializer<FileUploadHandle> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("FileUploadHandleSerializer")

  override fun deserialize(decoder: Decoder): FileUploadHandle {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return FileUploadHandle.fromJson(element)
  }

  override fun serialize(encoder: Encoder, `value`: FileUploadHandle) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelFileUploadHandleSerializer : KSerializer<RealtimeChannel<FileUploadHandle>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelFileUploadHandleSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<FileUploadHandle> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement(FileUploadHandleSerializer, it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<FileUploadHandle>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelSignInOptionSerializer : KSerializer<RealtimeChannel<SignInOption>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelSignInOptionSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<SignInOption> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    // Messages decode with the Json decoding this channel, which binds their OIDC clients.
    val json = decoder.json
    return RealtimeChannel.fromJson(element) { json.decodeFromJsonElement<SignInOption>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<SignInOption>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelListOidcClientAnyProviderSerializer : KSerializer<RealtimeChannel<List<OidcClient<AnyProvider>>>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelListOidcClientAnyProviderSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<List<OidcClient<AnyProvider>>> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    // Messages decode with the Json decoding this channel, which binds their OIDC clients.
    val json = decoder.json
    return RealtimeChannel.fromJson(element) { json.decodeFromJsonElement<List<OidcClient<AnyProvider>>>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<List<OidcClient<AnyProvider>>>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetChatFeedResultChannelSerializer : KSerializer<RealtimeChannel<Api.GetChatFeed.Result.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetChatFeedResultChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetChatFeed.Result.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetChatFeed.Result.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetChatFeed.Result.Channel>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetCounterFeedResultChannelSerializer : KSerializer<RealtimeChannel<Api.GetCounterFeed.Result.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetCounterFeedResultChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetCounterFeed.Result.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetCounterFeed.Result.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetCounterFeed.Result.Channel>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}
