package com.aws.blocks.kotlin.generator

import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.MemberName

object ClassNames {
    // kotlinx.serialization
    val decoder = ClassName("kotlinx.serialization.encoding", "Decoder")
    val deserializationStrategy = ClassName("kotlinx.serialization", "DeserializationStrategy")
    val discriminator = ClassName("kotlinx.serialization.json", "JsonClassDiscriminator")
    val encoder = ClassName("kotlinx.serialization.encoding", "Encoder")
    val experimentalSerializationApi = ClassName("kotlinx.serialization", "ExperimentalSerializationApi")
    val jsonContentPolymorphicSerializer = ClassName("kotlinx.serialization.json", "JsonContentPolymorphicSerializer")
    val jsonDecoder = ClassName("kotlinx.serialization.json", "JsonDecoder")
    val jsonElement = ClassName("kotlinx.serialization.json", "JsonElement")
    val jsonNull = ClassName("kotlinx.serialization.json", "JsonNull")
    val jsonObject = ClassName("kotlinx.serialization.json", "jsonObject")
    val jsonPrimitive = ClassName("kotlinx.serialization.json", "JsonPrimitive")
    val kSerializer = ClassName("kotlinx.serialization", "KSerializer")
    val serialDescriptor = ClassName("kotlinx.serialization.descriptors", "SerialDescriptor")
    val serializable = ClassName("kotlinx.serialization", "Serializable")
    val serialName = ClassName("kotlinx.serialization", "SerialName")

    // kotlin
    val optIn = ClassName("kotlin", "OptIn")

    // kotlinx.datetime
    val instant = ClassName("kotlinx.datetime", "Instant")
    val localDate = ClassName("kotlinx.datetime", "LocalDate")
    val localTime = ClassName("kotlinx.datetime", "LocalTime")

    // kotlin.uuid
    val uuid = ClassName("kotlin.uuid", "Uuid")

    // Runtime classes
    val blocks = ClassName("com.aws.blocks.kotlin", "Blocks")
    val blocksCompanion = blocks.nestedClass("Companion")
    val blocksClient = ClassName("com.aws.blocks.kotlin", "BlocksClient")
    val blocksJson = ClassName("com.aws.blocks.kotlin.json", "BlocksJson")
    val blocksRequest = ClassName("com.aws.blocks.kotlin", "BlocksRequest")
    val blocksServer = ClassName("com.aws.blocks.kotlin", "BlocksServer")
    val fileDownloadHandle = ClassName("com.aws.blocks.kotlin.filebucket", "FileDownloadHandle")
    val fileUploadHandle = ClassName("com.aws.blocks.kotlin.filebucket", "FileUploadHandle")
    val oidcClient = ClassName("com.aws.blocks.kotlin.oidc", "OidcClient")
    val realtimeChannel = ClassName("com.aws.blocks.kotlin.realtime", "RealtimeChannel")
    val unknownTransferable = ClassName("com.aws.blocks.kotlin", "UnknownTransferable")
}

object MemberNames {
    // kotlinx.serialization.json
    val add = MemberName("kotlinx.serialization.json", "add")
    val addAll = MemberName("kotlinx.serialization.json", "addAll")
    val buildJsonArray = MemberName("kotlinx.serialization.json", "buildJsonArray")
    val buildJsonObject = MemberName("kotlinx.serialization.json", "buildJsonObject")
    val decode = MemberName("kotlinx.serialization.json", "decodeFromJsonElement")
    val encode = MemberName("kotlinx.serialization.json", "encodeToJsonElement")
    val put = MemberName("kotlinx.serialization.json", "put")

    // kotlinx.serialization.descriptors
    val buildClassSerialDescriptor = MemberName("kotlinx.serialization.descriptors", "buildClassSerialDescriptor")
}
