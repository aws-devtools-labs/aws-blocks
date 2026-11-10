package com.aws.blocks.kotlin

object NamingUtils {
    private val HARD_KEYWORDS = setOf(
        "as", "break", "class", "continue", "do", "else", "false", "for",
        "fun", "if", "in", "interface", "is", "null", "object", "package",
        "return", "super", "this", "throw", "true", "try", "typealias",
        "typeof", "val", "var", "when", "while",
    )

    fun isKotlinKeyword(name: String): Boolean = name in HARD_KEYWORDS

    /**
     * The identifier generated code uses for a name the spec supplies: every character outside
     * `[A-Za-z0-9_]` becomes `_`, and a name that opens with a digit gains a leading `_`. A name
     * left empty, or holding only underscores (which Kotlin reserves), gains a `_unnamed` suffix.
     *
     * A keyword passes through unchanged: KotlinPoet backticks it wherever it is emitted, and a
     * field so named keeps its key through `@SerialName`. Every name the spec supplies reaches
     * generated code through this function, so the identifier can only ever hold the characters
     * above, whatever the spec holds; the spec's own text reaches generated code only as an escaped
     * string literal.
     */
    fun safeIdentifier(name: String): String {
        val mapped = buildString(name.length + 1) {
            for (c in name) append(if (c in 'a'..'z' || c in 'A'..'Z' || c in '0'..'9' || c == '_') c else '_')
        }
        return when {
            mapped.all { it == '_' } -> mapped + "_unnamed"
            mapped.first().isDigit() -> "_$mapped"
            else -> mapped
        }
    }

    /**
     * The type a binding's `export` resolves to. Only each segment's first character is
     * raised, so an acronym the declaring package exports as `URL` is imported as `URL`;
     * [toPascalCase] would lower its tail and name a type the package does not export.
     *
     * The empty-segment arm is defensive: the parser's `EXPORT` regex admits no dangling or
     * doubled separator, so no value reaching here splits into one.
     */
    fun exportTypeName(export: String): String =
        export.split('-', '_', '.')
            .joinToString("") { if (it.isEmpty()) "" else it[0].uppercaseChar() + it.substring(1) }

    fun toPascalCase(name: String): String {
        if (name.isEmpty()) return name
        return name
            .split(Regex("[_\\-]"))
            .joinToString("") { segment ->
                if (segment.isEmpty()) ""
                else if (segment.all { it.isUpperCase() || it.isDigit() }) {
                    segment[0].uppercaseChar() + segment.substring(1).lowercase()
                } else {
                    segment[0].uppercaseChar() + segment.substring(1)
                }
            }
            .let { result ->
                if (result.isEmpty()) result
                else result[0].uppercaseChar() + result.substring(1)
            }
    }

    fun toCamelCase(name: String): String {
        val pascal = toPascalCase(name)
        return if (pascal.isEmpty()) pascal else pascal[0].lowercaseChar() + pascal.substring(1)
    }
}
