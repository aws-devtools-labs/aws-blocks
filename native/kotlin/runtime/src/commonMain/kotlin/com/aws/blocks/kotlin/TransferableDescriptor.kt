package com.aws.blocks.kotlin

import com.aws.blocks.kotlin.exceptions.TransferableException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Throws [TransferableException] unless [element] is a JSON object whose `__blocks`
 * is a non-empty string equal to [expectedTag]. Returns that same instance; copying
 * descriptor data is the factory's duty.
 *
 * [subject] opens every message. [UnknownTransferable] passes its own name so the text
 * it published before this function existed is unchanged, as Dart and Swift still emit it.
 */
fun validateTransferableDescriptor(
    element: JsonElement,
    expectedTag: String,
    subject: String = "Transferable",
): JsonObject {
    val descriptor = element as? JsonObject
        ?: throw TransferableException(
            "$subject for '$expectedTag' expected a JSON object descriptor"
        )
    val tagElement = descriptor["__blocks"] as? JsonPrimitive
    if (tagElement == null || !tagElement.isString) {
        throw TransferableException(
            "$subject for '$expectedTag' expected a string '__blocks' tag"
        )
    }
    val tag = tagElement.content
    if (tag.isEmpty()) {
        throw TransferableException(
            "$subject for '$expectedTag' expected a non-empty '__blocks' tag"
        )
    }
    if (tag != expectedTag) {
        throw TransferableException(
            "$subject expected tag '$expectedTag', got '$tag'"
        )
    }
    return descriptor
}
