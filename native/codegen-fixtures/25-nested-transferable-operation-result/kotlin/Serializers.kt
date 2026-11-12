package com.example.app

import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlin.Int
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

public object RealtimeChannelApiGetSessionResultChannelSerializer : KSerializer<RealtimeChannel<Api.GetSession.Result.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetSessionResultChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetSession.Result.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetSession.Result.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetSession.Result.Channel>) {
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

public object RealtimeChannelListIntSerializer : KSerializer<RealtimeChannel<List<Int>>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelListIntSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<List<Int>> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<List<Int>>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<List<Int>>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetSessionResultInnerChannelSerializer : KSerializer<RealtimeChannel<Api.GetSession.Result.Inner.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetSessionResultInnerChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetSession.Result.Inner.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetSession.Result.Inner.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetSession.Result.Inner.Channel>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetSessionResultEventMessageChannelSerializer : KSerializer<RealtimeChannel<Api.GetSession.Result.Event.Message.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetSessionResultEventMessageChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetSession.Result.Event.Message.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetSession.Result.Event.Message.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetSession.Result.Event.Message.Channel>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetSessionResultEventPresenceChannelSerializer : KSerializer<RealtimeChannel<Api.GetSession.Result.Event.Presence.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetSessionResultEventPresenceChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetSession.Result.Event.Presence.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetSession.Result.Event.Presence.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetSession.Result.Event.Presence.Channel>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetOtherSessionResultChannelSerializer : KSerializer<RealtimeChannel<Api.GetOtherSession.Result.Channel>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetOtherSessionResultChannelSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetOtherSession.Result.Channel> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetOtherSession.Result.Channel>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetOtherSession.Result.Channel>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}
