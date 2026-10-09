package com.aws.blocks.kotlin

object NamingUtils {
    /**
     * Characters Kotlin rejects in a name even inside backticks (the JVM's `.;[]/<>:\`), and the
     * backtick, which ends a backticked name.
     */
    private val UNESCAPABLE_CHARACTERS = setOf('.', ';', '[', ']', '/', '<', '>', ':', '\\', '`')

    /**
     * Whether Kotlin can declare the spec name [name] as written, with backticks where it needs
     * them (`class`, `content-type`, `1st`, `it's`, `a b`), which KotlinPoet adds. It can't declare
     * an empty name, or one holding a character from [UNESCAPABLE_CHARACTERS] (KotlinPoet throws
     * "Can't escape identifier") or a control character (a line break ends a backticked name).
     */
    fun isDeclarable(name: String): Boolean =
        name.isNotEmpty() && name.none { it in UNESCAPABLE_CHARACTERS || it.isISOControl() }

    /** The runs of letters and digits in [name] (`back\slash` -> `back`, `slash`). */
    private fun words(name: String): List<String> = name.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

    /**
     * The Kotlin name of a property, parameter or function the spec names [name]: [name] itself
     * when Kotlin can declare it ([isDeclarable]), else its words, each after the first
     * capitalized (`back\slash` -> `backSlash`, `b.ping` -> `bPing`, `new\nline` -> `newLine`), or `unnamed`
     * when it has none. The caller keeps [name] on the wire (`@SerialName`, the JSON-RPC method).
     */
    fun memberName(name: String): String {
        if (isDeclarable(name)) return name
        val words = words(name)
        if (words.isEmpty()) return "unnamed"
        return words.first() + words.drop(1).joinToString("") { it.replaceFirstChar(Char::uppercaseChar) }
    }

    /**
     * [name] in PascalCase, split at `_` and `-`. A result Kotlin can't declare ([isDeclarable]:
     * `Back\slash`, `A.b`, an empty name) is built from [name]'s words instead (`BackSlash`, `AB`),
     * or is `Unnamed` when [name] has none.
     */
    fun toPascalCase(name: String): String {
        val pascal = pascalCase(name.split(Regex("[_\\-]")))
        if (isDeclarable(pascal)) return pascal
        return pascalCase(words(name)).ifEmpty { "Unnamed" }
    }

    private fun pascalCase(segments: List<String>): String =
        segments
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

    fun toCamelCase(name: String): String {
        val pascal = toPascalCase(name)
        return if (pascal.isEmpty()) pascal else pascal[0].lowercaseChar() + pascal.substring(1)
    }

    /**
     * Distinct Kotlin names for [names], the spec names declared in one Kotlin scope, in order.
     * [candidate] gives the Kotlin name each would like. A name whose candidate is the name itself
     * claims it first; every other one (a name that had to change, or a later duplicate) then gets
     * its candidate, or `_2`, `_3`, … when that is taken or [reserved]. A name that collides with
     * nothing keeps its candidate.
     */
    fun allocate(names: List<String>, reserved: Set<String> = emptySet(), candidate: (String) -> String): List<String> {
        val taken = reserved.toMutableSet()
        val wanted = names.map(candidate)
        val result = arrayOfNulls<String>(names.size)
        names.forEachIndexed { i, name ->
            if (wanted[i] == name && taken.add(name)) result[i] = name
        }
        names.indices.forEach { i -> if (result[i] == null) result[i] = claim(wanted[i], taken) }
        return result.map { it!! }
    }

    /**
     * The names of the types the generator nests in a class whose properties are [propertyNames]
     * (an open record's serializer and fields class, `[OpenRecordSerializer, OpenRecordFields]`),
     * given as [generated]: each keeps its name unless a property has it, since Kotlin rejects a
     * property and a nested class of one name; then it gets `_2`, ….
     */
    fun nestedTypeNamesBeside(propertyNames: Collection<String>, generated: List<String>): List<String> {
        val taken = propertyNames.toMutableSet()
        return generated.map { claim(it, taken) }
    }

    /** [candidate], or else `<candidate>_2`, `_3`, …: the first that isn't in [taken], which it is added to. */
    fun claim(candidate: String, taken: MutableSet<String>): String {
        if (taken.add(candidate)) return candidate
        var duplicate = 2
        while (!taken.add("${candidate}_$duplicate")) duplicate++
        return "${candidate}_$duplicate"
    }
}
