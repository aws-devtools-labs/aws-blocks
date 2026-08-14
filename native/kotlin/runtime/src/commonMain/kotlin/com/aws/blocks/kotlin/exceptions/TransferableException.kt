package com.aws.blocks.kotlin.exceptions

/**
 * Base exception for errors that occur when hydrating a transferable descriptor
 * (e.g. RealtimeChannel, FileDownloadHandle) from its JSON wire representation.
 */
open class TransferableException(message: String, cause: Throwable? = null) :
    BlocksException(message, cause)

/**
 * Thrown when the server returns a transferable descriptor with a `__blocks` type
 * that the SDK does not recognize (no hydrator registered).
 */
class UnknownTransferableTypeException(val blocksType: String) :
    TransferableException("No hydrator registered for transferable type: $blocksType")

/**
 * Thrown when a transferable descriptor is missing a required field needed
 * to construct the client-side handle (e.g. a channel descriptor without a `wsUrl`).
 */
class InvalidDescriptorException(val blocksType: String, val missingField: String) :
    TransferableException("Descriptor '$blocksType' is missing required field: $missingField")

/**
 * Thrown when an I/O operation on a transferable handle fails (e.g. a file upload
 * or download encounters a network error after the handle was successfully created).
 */
class TransferableIOException(message: String, cause: Throwable? = null) :
    TransferableException(message, cause)
