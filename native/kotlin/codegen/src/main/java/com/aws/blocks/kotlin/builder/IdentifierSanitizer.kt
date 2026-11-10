package com.aws.blocks.kotlin.builder

import com.aws.blocks.kotlin.CodegenException
import com.aws.blocks.kotlin.NamingUtils
import com.aws.blocks.kotlin.forDiagnostic
import com.aws.blocks.kotlin.model.ApiNamespace
import com.aws.blocks.kotlin.model.CodegenModel
import com.aws.blocks.kotlin.model.NestedTypeNode
import com.aws.blocks.kotlin.model.Operation
import com.aws.blocks.kotlin.model.ResolvedField
import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.model.TypeDefinition
import com.aws.blocks.kotlin.model.UnionVariant

/** Raised when two names the spec supplies reduce to one identifier in the same scope. */
class IdentifierCollisionException(message: String) : CodegenException(message)

/**
 * Rewrites every name in a [CodegenModel] that the generator emits as an identifier through
 * [NamingUtils.safeIdentifier]: namespaces, operations, parameters, fields, and the names of
 * types, union variants and nested types.
 *
 * What the wire needs keeps the spec's own text: a field's key moves to
 * [ResolvedField.serialName], and a namespace or operation keeps its spelling in `wireName`, so
 * the generator can emit both as escaped string literals. Enum values, discriminator values and
 * transferable tags are values rather than names, and are left as they are.
 *
 * The rewrite is a pure function of each name, so a reference and the type it names stay
 * matched. Two different names that reduce to one identifier in the same scope would generate
 * code that doesn't compile, or one declaration in place of two, so generation fails instead.
 */
internal object IdentifierSanitizer {

    fun sanitize(model: CodegenModel): CodegenModel {
        val namespaces = model.apiNamespaces.map(::sanitizeNamespace)
        requireDistinct("namespace", "the spec", model.apiNamespaces.map { it.name })

        val typeDefinitions = model.typeDefinitions.map(::sanitizeTypeDefinition)
        model.typeDefinitions
            .groupBy { it.parentSchema }
            .forEach { (parent, defs) ->
                val scope = parent?.let { "schema '${it.forDiagnostic()}'" } ?: "the generated types"
                requireDistinct("type", scope, defs.map { it.name }.distinct())
            }

        return model.copy(apiNamespaces = namespaces, typeDefinitions = typeDefinitions)
    }

    private fun sanitizeNamespace(namespace: ApiNamespace): ApiNamespace {
        requireDistinct("operation", "namespace '${namespace.name.forDiagnostic()}'", namespace.operations.map { it.name })
        return namespace.copy(
            name = identifier(namespace.name),
            wireName = namespace.wireName,
            operations = namespace.operations.map(::sanitizeOperation),
        )
    }

    private fun sanitizeOperation(operation: Operation): Operation {
        val scope = "operation '${operation.name.forDiagnostic()}'"
        requireDistinct("parameter", scope, operation.parameters.map { it.name })
        requireDistinct("nested type", scope, operation.nestedTypes.map { it.name })
        return operation.copy(
            name = identifier(operation.name),
            wireName = operation.wireName,
            parameters = operation.parameters.map { it.copy(name = identifier(it.name), type = type(it.type)) },
            result = operation.result.copy(type = type(operation.result.type)),
            nestedTypes = operation.nestedTypes.map(::sanitizeNode),
        )
    }

    private fun sanitizeTypeDefinition(def: TypeDefinition): TypeDefinition = def.copy(
        name = typeName(def.name),
        type = type(def.type),
        shortName = typeName(def.shortName),
        parentSchema = def.parentSchema?.let(::typeName),
    )

    private fun sanitizeNode(node: NestedTypeNode): NestedTypeNode {
        requireDistinct("nested type", "type '${node.name.forDiagnostic()}'", node.children.map { it.name })
        return node.copy(
            name = typeName(node.name),
            type = type(node.type),
            children = node.children.map(::sanitizeNode),
        )
    }

    private fun fields(owner: String, fields: List<ResolvedField>): List<ResolvedField> {
        requireDistinct("field", "type '${owner.forDiagnostic()}'", fields.map { it.name })
        return fields.map { it.copy(name = identifier(it.name), type = type(it.type), serialName = it.serialName) }
    }

    private fun variant(union: String, variant: UnionVariant): UnionVariant {
        requireDistinct("nested type", "variant '${variant.name.forDiagnostic()}'", variant.nestedTypes.map { it.name })
        return variant.copy(
            name = typeName(variant.name),
            fields = fields("$union.${variant.name}", variant.fields),
            embeddedUnion = variant.embeddedUnion?.let { type(it) as ResolvedType.Union },
            payloadTypeName = variant.payloadTypeName?.let(::typeName),
            additionalPropertiesType = variant.additionalPropertiesType?.let(::type),
            nestedTypes = variant.nestedTypes.map(::sanitizeNode),
        )
    }

    private fun type(type: ResolvedType): ResolvedType = when (type) {
        is ResolvedType.Primitive, is ResolvedType.FormattedType -> type
        is ResolvedType.Record -> type.copy(
            name = typeName(type.name),
            fields = fields(type.name, type.fields),
            additionalPropertiesType = type.additionalPropertiesType?.let(::type),
        )
        is ResolvedType.Enum -> type.copy(name = typeName(type.name))
        is ResolvedType.ListType -> type.copy(elementType = type(type.elementType))
        is ResolvedType.MapType -> type.copy(valueType = type(type.valueType))
        is ResolvedType.TupleType -> type.copy(name = typeName(type.name), elements = type.elements.map(::type))
        is ResolvedType.Nullable -> type.copy(inner = type(type.inner))
        is ResolvedType.Union -> {
            requireDistinct("union variant", "type '${type.name.forDiagnostic()}'", type.variants.map { it.name })
            type.copy(
                name = typeName(type.name),
                variants = type.variants.map { variant(type.name, it) },
                discriminator = type.discriminator?.let { d ->
                    d.copy(variants = d.variants.mapValues { (_, name) -> typeName(name) })
                },
            )
        }
        is ResolvedType.TypeReference -> type.copy(name = typeName(type.name))
        is ResolvedType.Transferable -> type.copy(typeArgs = type.typeArgs.map(::type))
    }

    private fun identifier(name: String): String = NamingUtils.safeIdentifier(name)

    /** An unnamed type, such as a narrowed type argument nothing named yet, stays unnamed. */
    private fun typeName(name: String): String = if (name.isEmpty()) name else identifier(name)

    /**
     * Fails when two different [names] in [scope] reduce to one identifier through [toIdentifier],
     * [NamingUtils.safeIdentifier] unless a caller names another mapping.
     */
    fun requireDistinct(
        kind: String,
        scope: String,
        names: List<String>,
        toIdentifier: (String) -> String = ::identifier,
    ) {
        names.distinct()
            .groupBy(toIdentifier)
            .filterValues { it.size > 1 }
            .entries
            .firstOrNull()
            ?.let { (identifier, clashing) ->
                throw IdentifierCollisionException(
                    "The ${kind}s ${clashing.joinToString { "'${it.forDiagnostic()}'" }} in $scope all " +
                        "generate the identifier '$identifier'. Rename one in the spec.",
                )
            }
    }
}
