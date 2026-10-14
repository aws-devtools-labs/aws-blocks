package com.aws.blocks.kotlin

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Fallback for a direct-result transferable whose tag has no runtime binding on this
 * platform: carries the [tag] and raw [descriptor] without hydrating them.
 */
class UnknownTransferable private constructor(
    val tag: String,
    /** The raw wire descriptor (including its `__blocks` tag), held by reference, not copied. */
    val descriptor: JsonObject,
) {
    companion object {
        fun fromJson(element: JsonElement, expectedTag: String): UnknownTransferable =
            UnknownTransferable(
                expectedTag,
                validateTransferableDescriptor(element, expectedTag, subject = "UnknownTransferable"),
            )
    }
}
