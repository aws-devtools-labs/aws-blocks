package com.aws.blocks.kotlin.parser

import com.aws.blocks.kotlin.NamingUtils
import com.aws.blocks.kotlin.forDiagnostic
import com.aws.blocks.kotlin.model.DeclaredBinding
import com.aws.blocks.kotlin.model.NativeCatalogs
import com.aws.blocks.kotlin.model.NativeTransferableBinding
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

private const val PACKAGES = "x-blocks-native-packages"
private const val BINDINGS = "x-blocks-native-bindings"
private const val SCHEMA_VERSION = 1
private const val TRANSFERABLE_KIND = "transferable"
private const val TRANSFERABLE_ABI = "blocks-transferable-v1"
private const val MAX_GENERIC_ARITY = 1

/** The only shape `import <kotlinPackage>.<Type>` accepts: dot-separated segments. */
private val KOTLIN_PACKAGE = Regex("""[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*""")

/** One identifier; a separator always joins two segments, never dangles. */
private val EXPORT = Regex("""[A-Za-z][A-Za-z0-9]*([_-][A-Za-z0-9]+)*""")

/** Absence is intentional and yields [NativeCatalogs.EMPTY]; malformed presence throws. */
internal object NativeCatalogParser {

    fun parse(root: JsonObject): NativeCatalogs {
        val packagesCatalog = root[PACKAGES]?.asObject(PACKAGES)
        val bindingsCatalog = root[BINDINGS]?.asObject(BINDINGS)
        if (packagesCatalog == null && bindingsCatalog == null) return NativeCatalogs.EMPTY

        val kotlinPackages = packagesCatalog?.let { parsePackages(it) } ?: emptyMap()
        val referenced = mutableSetOf<String>()
        val declared = mutableListOf<DeclaredBinding>()
        val bindings = bindingsCatalog?.let { parseBindings(it, kotlinPackages, referenced, declared) }
            ?: emptyList()
        return NativeCatalogs(
            bindings = bindings,
            unreferencedPackages = kotlinPackages.keys - referenced,
            declaredPackages = kotlinPackages.keys,
            declaredBindings = declared,
        )
    }

    /** Identity to its `android.package.kotlinPackage`, or null where none is declared. */
    private fun parsePackages(catalog: JsonObject): Map<String, String?> {
        catalog.requireSchemaVersion(PACKAGES)
        val packages = catalog["packages"]?.asObject("$PACKAGES.packages")
            ?: throw OpenRpcParseException("$PACKAGES requires a \"packages\" object")

        return packages.entries.associate { (identity, entry) ->
            val path = "$PACKAGES.packages.${identity.forDiagnostic()}"
            val platforms = entry.asObject(path)["platforms"]?.asObject("$path.platforms")
                ?: throw OpenRpcParseException("$path requires a \"platforms\" object")
            val android = platforms["android"]?.asObject("$path.platforms.android")
            identity to android?.androidKotlinPackage("$path.platforms.android")
        }
    }

    private fun JsonObject.androidKotlinPackage(path: String): String {
        val declared = this["package"]?.asObject("$path.package")
            ?: throw OpenRpcParseException("$path requires a \"package\" object")
        val kotlinPackage = declared.requireString("kotlinPackage", "$path.package")
        if (!KOTLIN_PACKAGE.matches(kotlinPackage) || kotlinPackage.split('.').any(NamingUtils::isKotlinKeyword)) {
            throw OpenRpcParseException(
                "$path.package \"kotlinPackage\" is not a Kotlin package name: \"${kotlinPackage.forDiagnostic()}\"",
            )
        }
        return kotlinPackage
    }

    private fun parseBindings(
        catalog: JsonObject,
        kotlinPackages: Map<String, String?>,
        referenced: MutableSet<String>,
        declaredBindings: MutableList<DeclaredBinding>,
    ): List<NativeTransferableBinding> {
        catalog.requireSchemaVersion(BINDINGS)
        val declared = catalog["bindings"] as? JsonArray
            ?: throw OpenRpcParseException("$BINDINGS requires a \"bindings\" array")

        val seenTags = mutableSetOf<String>()
        val transferables = mutableListOf<NativeTransferableBinding>()
        for ((position, element) in declared.withIndex()) {
            val path = "$BINDINGS.bindings[$position]"
            val binding = element.asObject(path)
            val id = binding.requireString("id", path)
            val kind = binding.requireString("kind", path)
            val identity = binding.requireString("package", path)
            referenced.add(identity)
            if (identity !in kotlinPackages) {
                throw OpenRpcParseException(
                    "$path (\"${id.forDiagnostic()}\") names package \"${identity.forDiagnostic()}\", " +
                        "which $PACKAGES does not declare",
                )
            }
            // `kind` is an open enumeration, so every check but the ABI allowlist spans it,
            // matching the single enforcement point in validate-native-catalogs.ts.
            val tag = binding.requireString("tag", path)
            if (!seenTags.add(tag)) {
                throw OpenRpcParseException("$BINDINGS binds tag \"${tag.forDiagnostic()}\" more than once")
            }
            val abi = binding.requireString("abi", path)
            val arity = (binding["genericArity"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
            if (arity == null || arity < 0 || arity > MAX_GENERIC_ARITY) {
                throw OpenRpcParseException(
                    "$path (\"${id.forDiagnostic()}\") requires an integer \"genericArity\" " +
                        "between 0 and $MAX_GENERIC_ARITY, got ${binding["genericArity"]}",
                )
            }
            val export = binding.requireExport(path, id)
            declaredBindings.add(DeclaredBinding(id, kind))
            if (kind != TRANSFERABLE_KIND) continue

            if (abi != TRANSFERABLE_ABI) {
                throw OpenRpcParseException(
                    "$path (\"${id.forDiagnostic()}\") declares unsupported abi \"${abi.forDiagnostic()}\"",
                )
            }
            transferables.add(
                NativeTransferableBinding(
                    id = id,
                    tag = tag,
                    packageIdentity = identity,
                    export = export,
                    genericArity = arity,
                    kotlinPackage = kotlinPackages.getValue(identity),
                ),
            )
        }
        return transferables
    }

    private fun JsonObject.requireSchemaVersion(path: String) {
        val version = (this["schemaVersion"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        if (version != SCHEMA_VERSION) {
            throw OpenRpcParseException(
                "$path requires \"schemaVersion\": $SCHEMA_VERSION, got ${this["schemaVersion"]}",
            )
        }
    }

    private fun JsonObject.requireString(field: String, path: String): String {
        val value = this[field] as? JsonPrimitive
        if (value == null || !value.isString || value.content.isBlank()) {
            throw OpenRpcParseException("$path requires a non-blank string \"$field\"")
        }
        return value.content
    }

    private fun JsonObject.requireExport(path: String, id: String): String {
        val export = requireString("export", path)
        if (!EXPORT.matches(export)) {
            throw OpenRpcParseException(
                "$path (\"${id.forDiagnostic()}\") \"export\" is not an identifier: " +
                    "\"${export.forDiagnostic()}\"",
            )
        }
        return export
    }

    private fun JsonElement.asObject(path: String): JsonObject =
        this as? JsonObject ?: throw OpenRpcParseException("$path must be an object")
}
