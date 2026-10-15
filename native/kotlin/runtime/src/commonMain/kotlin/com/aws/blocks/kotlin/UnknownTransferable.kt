package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.TransferableException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Fallback for a direct-result transferable whose tag has no runtime binding:
 * carries the [tag] and raw [descriptor] without hydrating them.
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
        fun fromJson(element: JsonElement, expectedTag: String): UnknownTransferable {
            val descriptor = element as? JsonObject
                ?: throw TransferableException(
                    "UnknownTransferable for '$expectedTag' expected a JSON object descriptor"
                )
            val tagElement = descriptor["__blocks"] as? JsonPrimitive
            if (tagElement == null || !tagElement.isString) {
                throw TransferableException(
                    "UnknownTransferable for '$expectedTag' expected a string '__blocks' tag"
                )
            }
            val tag = tagElement.content
            if (tag.isEmpty()) {
                throw TransferableException(
                    "UnknownTransferable for '$expectedTag' expected a non-empty '__blocks' tag"
                )
            }
            if (tag != expectedTag) {
                throw TransferableException(
                    "UnknownTransferable expected tag '$expectedTag', got '$tag'"
                )
            }
            return UnknownTransferable(tag, descriptor)
        }
    }
}
