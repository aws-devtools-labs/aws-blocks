package com.example.blocks.iot

import kotlinx.serialization.json.JsonObject

/**
 * Compile-only stub of codegen fixture 27's declared `example-iot-native` package: binding
 * `example-iot/device-handle`, generic arity 0, with the `blocks-transferable-v1` factory.
 */
class DeviceHandle private constructor(val descriptor: JsonObject) {
    companion object {
        fun fromBlocksDescriptor(descriptor: JsonObject): DeviceHandle = DeviceHandle(descriptor)
    }
}
