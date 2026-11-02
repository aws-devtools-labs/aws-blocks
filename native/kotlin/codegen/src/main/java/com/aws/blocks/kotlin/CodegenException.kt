package com.aws.blocks.kotlin

/**
 * Base exception for every spec a code generation run refuses to generate from.
 *
 * Catch this to treat any rejected spec alike. The parser raises
 * [com.aws.blocks.kotlin.parser.OpenRpcParseException] for a malformed document; the
 * generator raises this type directly for a spec that only its own resolution can
 * reject, such as a binding whose `genericArity` disagrees with an operation's result.
 */
open class CodegenException(message: String) : RuntimeException(message)

/** Keep a diagnostic on one log line even if a spec-supplied value carries a newline. */
internal fun String.forDiagnostic(): String = replace("\n", "\\n").replace("\r", "\\r")
