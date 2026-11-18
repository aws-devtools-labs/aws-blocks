package com.example.app

import com.aws.blocks.kotlin.filebucket.FileDownloadHandle
import java.lang.UnsupportedOperationException
import kotlin.Unit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder

public object FileDownloadHandleSerializer : KSerializer<FileDownloadHandle> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("FileDownloadHandleSerializer")

  override fun deserialize(decoder: Decoder): FileDownloadHandle {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return FileDownloadHandle.fromJson(element)
  }

  override fun serialize(encoder: Encoder, `value`: FileDownloadHandle): Unit = throw UnsupportedOperationException("Transferables are read-only")
}
