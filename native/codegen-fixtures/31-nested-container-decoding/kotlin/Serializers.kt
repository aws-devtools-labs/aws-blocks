package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.String
import kotlin.collections.List
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.decodeFromJsonElement

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

public object RealtimeChannelListStringSerializer : KSerializer<RealtimeChannel<List<String>>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelListStringSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<List<String>> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<List<String>>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<List<String>>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

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
