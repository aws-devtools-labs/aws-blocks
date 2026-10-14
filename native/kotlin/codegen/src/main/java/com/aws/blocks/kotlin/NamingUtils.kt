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
     * The type a binding's `export` resolves to. Only each segment's first character is
     * raised, so an acronym the declaring package exports as `URL` is imported as `URL`;
     * [toPascalCase] would lower its tail and name a type the package does not export.
     */
    fun exportTypeName(export: String): String =
        export.split('_', '-')
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
