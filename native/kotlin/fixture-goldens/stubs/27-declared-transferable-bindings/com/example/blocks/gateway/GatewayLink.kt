package com.example.blocks.gateway

import kotlinx.serialization.json.JsonObject

/**
 * Compile-only stub of codegen fixture 27's declared `example-gateway-native` package: binding
 * `example-gateway/link`, generic arity 0, with the `blocks-transferable-v1` factory.
 */
class GatewayLink private constructor(val descriptor: JsonObject) {
    companion object {
        fun fromBlocksDescriptor(descriptor: JsonObject): GatewayLink = GatewayLink(descriptor)
    }
}
