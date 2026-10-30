package com.example.blocks.iot

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Compile-only stub of codegen fixture 27's declared `example-iot-native` package: binding
 * `example-iot/device-link`, generic arity 1, with the `blocks-transferable-v1` factory.
 */
class DeviceLink<T> private constructor(val descriptor: JsonObject, val decode: (JsonElement) -> T) {
    companion object {
        fun <T> fromBlocksDescriptor(descriptor: JsonObject, decode: (JsonElement) -> T): DeviceLink<T> =
            DeviceLink(descriptor, decode)
    }
}
