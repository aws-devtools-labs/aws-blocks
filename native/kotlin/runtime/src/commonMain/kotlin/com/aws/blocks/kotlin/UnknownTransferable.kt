package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.TransferableException
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
        /**
         * Throws [TransferableException] unless [element] is a JSON object whose
         * `__blocks` is a non-empty string equal to [expectedTag].
         */
        fun fromJson(element: JsonElement, expectedTag: String): UnknownTransferable =
            UnknownTransferable(
                expectedTag,
                validateTransferableDescriptor(element, expectedTag, subject = "UnknownTransferable"),
            )
    }
}
