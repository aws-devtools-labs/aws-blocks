package com.example.app

import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import java.lang.UnsupportedOperationException
import kotlin.Unit
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.decodeFromJsonElement

public object RealtimeChannelApiGetSessionResultChannelSerializer : KSerializer<RealtimeChannel<Api.GetSession.Result.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetSessionResultChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetSession.Result.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetSession.Result.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetSession.Result.Channel>): Unit = throw UnsupportedOperationException("Transferables are read-only")
}

public object RealtimeChannelApiGetOtherSessionResultChannelSerializer : KSerializer<RealtimeChannel<Api.GetOtherSession.Result.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetOtherSessionResultChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetOtherSession.Result.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetOtherSession.Result.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetOtherSession.Result.Channel>): Unit = throw UnsupportedOperationException("Transferables are read-only")
}
