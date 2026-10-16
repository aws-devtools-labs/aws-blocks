package com.example.app

import com.aws.blocks.kotlin.json.BlocksJson
import com.aws.blocks.kotlin.realtime.RealtimeChannel
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.decodeFromJsonElement

public object RealtimeChannelApiGetFeedsResultFeedSerializer : KSerializer<RealtimeChannel<Api.GetFeeds.Result.Feed>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetFeedsResultFeedSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetFeeds.Result.Feed> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetFeeds.Result.Feed>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetFeeds.Result.Feed>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}

public object RealtimeChannelApiGetFeedsResultFeedsSerializer : KSerializer<RealtimeChannel<Api.GetFeeds.Result.Feeds>> {
  override val descriptor: SerialDescriptor =
      buildClassSerialDescriptor("RealtimeChannelApiGetFeedsResultFeedsSerializer")

  override fun deserialize(decoder: Decoder): RealtimeChannel<Api.GetFeeds.Result.Feeds> {
    val element = (decoder as JsonDecoder).decodeJsonElement()
    return RealtimeChannel.fromJson(element) { BlocksJson.decodeFromJsonElement<Api.GetFeeds.Result.Feeds>(it) }
  }

  override fun serialize(encoder: Encoder, `value`: RealtimeChannel<Api.GetFeeds.Result.Feeds>) {
    (encoder as JsonEncoder).encodeJsonElement(value.toJson())
  }
}
