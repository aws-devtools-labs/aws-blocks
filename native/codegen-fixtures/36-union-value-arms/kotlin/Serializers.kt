package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder

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
