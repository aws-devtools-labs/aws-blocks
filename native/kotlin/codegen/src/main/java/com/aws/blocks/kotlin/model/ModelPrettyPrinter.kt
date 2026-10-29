package com.aws.blocks.kotlin.model

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive

/**
 * Formats an [RpcModel] as indented, hierarchical plain text for debugging.
 *
 * This is a stateless utility — call [format] with any valid model to get
 * a human-readable dump suitable for stdout or log inspection.
 */
object ModelPrettyPrinter {

    private const val INDENT = "  "

    fun format(model: RpcModel): String {
        val sb = StringBuilder()
        formatInfo(sb, model.info, "")
        if (model.servers.isNotEmpty()) {
            formatServers(sb, model.servers, "")
        }
        if (model.methods.isNotEmpty()) {
            formatMethods(sb, model.methods, "")
        }
        if (model.components != null) {
            formatComponents(sb, model.components, "")
        }
        return sb.toString().trimEnd()
    }

    private fun formatInfo(sb: StringBuilder, info: Info, indent: String) {
        sb.appendLine("${indent}Info:")
        sb.appendLine("${indent}${INDENT}title: ${info.title}")
        sb.appendLine("${indent}${INDENT}version: ${info.version}")
    }

    private fun formatServers(sb: StringBuilder, servers: List<Server>, indent: String) {
        sb.appendLine("${indent}Servers:")
        for (server in servers) {
            sb.appendLine("${indent}${INDENT}- name: ${server.name}")
            sb.appendLine("${indent}${INDENT}  url: ${server.url}")
        }
    }

    private fun formatMethods(sb: StringBuilder, methods: List<Method>, indent: String) {
        sb.appendLine("${indent}Methods:")
        for (method in methods) {
            formatMethod(sb, method, "${indent}${INDENT}")
        }
    }

    private fun formatMethod(sb: StringBuilder, method: Method, indent: String) {
        sb.appendLine("${indent}- name: ${method.name}")
        if (method.params.isNotEmpty()) {
            sb.appendLine("${indent}  params:")
            for (param in method.params) {
                formatContentDescriptor(sb, param, "${indent}  ${INDENT}")
            }
        }
        if (method.result != null) {
            sb.appendLine("${indent}  result:")
            formatContentDescriptor(sb, method.result, "${indent}  ${INDENT}")
        }
    }

    private fun formatContentDescriptor(sb: StringBuilder, cd: ContentDescriptor, indent: String) {
        sb.appendLine("${indent}- name: ${cd.name}")
        sb.append("${indent}  type: ")
        formatTypeRef(sb, cd.schema, "${indent}  ")
        sb.appendLine("${indent}  required: ${cd.required}")
    }

    private fun formatTypeRef(sb: StringBuilder, typeRef: TypeRef, indent: String) {
        when (typeRef) {
            is TypeRef.Primitive -> {
                sb.append("Primitive(${typeRef.tsType})")
                if (!typeRef.constraints.isEmpty) {
                    sb.append(" ")
                    sb.append(formatConstraints(typeRef.constraints))
                }
                sb.appendLine()
            }
            is TypeRef.ArrayType -> {
                sb.append("ArrayType(")
                formatTypeRefInline(sb, typeRef.elementType)
                sb.appendLine(")")
            }
            is TypeRef.Nullable -> {
                sb.append("Nullable(")
                formatTypeRefInline(sb, typeRef.inner)
                sb.appendLine(")")
            }
            is TypeRef.SchemaRef -> sb.appendLine("SchemaRef(${typeRef.schemaName})")
            is TypeRef.RecursiveSchemaRef -> sb.appendLine("RecursiveSchemaRef(${typeRef.schemaName})")
            is TypeRef.UnionLiteral -> sb.appendLine("UnionLiteral([${typeRef.values.joinToString(", ")}])")
            is TypeRef.Union -> {
                sb.appendLine("Union")
                for (member in typeRef.members) {
                    sb.append("${indent}${INDENT}- ")
                    formatTypeRef(sb, member, "${indent}${INDENT}  ")
                }
            }
            is TypeRef.InlineObject -> {
                sb.appendLine("InlineObject")
                for (field in typeRef.fields) {
                    sb.appendLine("${indent}${INDENT}- name: ${field.name}")
                    sb.append("${indent}${INDENT}  type: ")
                    formatTypeRef(sb, field.type, "${indent}${INDENT}  ")
                    sb.appendLine("${indent}${INDENT}  required: ${field.required}")
                }
            }
            is TypeRef.Transferable -> {
                sb.append("Transferable(${typeRef.transferableName}")
                if (typeRef.typeArgs.isNotEmpty()) {
                    sb.append(", typeArgs=[")
                    typeRef.typeArgs.forEachIndexed { i, arg ->
                        if (i > 0) sb.append(", ")
                        formatTypeRefInline(sb, arg)
                    }
                    sb.append("]")
                }
                sb.appendLine(")")
            }
            is TypeRef.MapType -> {
                sb.append("MapType(")
                formatTypeRefInline(sb, typeRef.valueType)
                sb.appendLine(")")
            }
            is TypeRef.TupleType -> {
                sb.appendLine("TupleType([${typeRef.elements.size} elements])")
            }
            is TypeRef.ObjectWithOneOf -> {
                sb.appendLine("ObjectWithOneOf")
                for (field in typeRef.fields) {
                    sb.appendLine("${indent}${INDENT}- name: ${field.name}")
                    sb.append("${indent}${INDENT}  type: ")
                    formatTypeRef(sb, field.type, "${indent}${INDENT}  ")
                    sb.appendLine("${indent}${INDENT}  required: ${field.required}")
                }
                sb.appendLine("${indent}${INDENT}oneOf:")
                for (member in typeRef.oneOf) {
                    sb.append("${indent}${INDENT}  - ")
                    formatTypeRef(sb, member, "${indent}${INDENT}    ")
                }
            }
        }
    }

    /**
     * Renders a TypeRef inline (no trailing newline) for use inside
     * wrapper types like ArrayType(...) and Nullable(...).
     */
    private fun formatTypeRefInline(sb: StringBuilder, typeRef: TypeRef) {
        when (typeRef) {
            is TypeRef.Primitive -> {
                sb.append("Primitive(${typeRef.tsType})")
                if (!typeRef.constraints.isEmpty) {
                    sb.append(" ")
                    sb.append(formatConstraints(typeRef.constraints))
                }
            }
            is TypeRef.SchemaRef -> sb.append("SchemaRef(${typeRef.schemaName})")
            is TypeRef.RecursiveSchemaRef -> sb.append("RecursiveSchemaRef(${typeRef.schemaName})")
            is TypeRef.UnionLiteral -> sb.append("UnionLiteral([${typeRef.values.joinToString(", ")}])")
            is TypeRef.ArrayType -> {
                sb.append("ArrayType(")
                formatTypeRefInline(sb, typeRef.elementType)
                sb.append(")")
            }
            is TypeRef.Nullable -> {
                sb.append("Nullable(")
                formatTypeRefInline(sb, typeRef.inner)
                sb.append(")")
            }
            is TypeRef.Union -> sb.append("Union(...)")
            is TypeRef.InlineObject -> sb.append("InlineObject(...)")
            is TypeRef.Transferable -> sb.append("Transferable(${typeRef.transferableName})")
            is TypeRef.MapType -> {
                sb.append("MapType(")
                formatTypeRefInline(sb, typeRef.valueType)
                sb.append(")")
            }
            is TypeRef.TupleType -> sb.append("TupleType([${typeRef.elements.size} elements])")
            is TypeRef.ObjectWithOneOf -> sb.append("ObjectWithOneOf(...)")
        }
    }

    private fun formatConstraints(c: Constraints): String {
        val parts = mutableListOf<String>()
        c.format?.let { parts.add("format=$it") }
        c.minLength?.let { parts.add("minLength=$it") }
        c.maxLength?.let { parts.add("maxLength=$it") }
        c.pattern?.let { parts.add("pattern=$it") }
        c.minimum?.let { parts.add("minimum=$it") }
        c.maximum?.let { parts.add("maximum=$it") }
        c.exclusiveMinimum?.let { parts.add("exclusiveMinimum=$it") }
        c.exclusiveMaximum?.let { parts.add("exclusiveMaximum=$it") }
        c.multipleOf?.let { parts.add("multipleOf=$it") }
        c.minItems?.let { parts.add("minItems=$it") }
        c.maxItems?.let { parts.add("maxItems=$it") }
        return "[${parts.joinToString(", ")}]"
    }

    private fun formatComponents(sb: StringBuilder, components: JsonObject, indent: String) {
        sb.appendLine("${indent}Components:")
        val schemas = components["schemas"]
        if (schemas is JsonObject) {
            for ((name, value) in schemas) {
                sb.appendLine("${indent}${INDENT}- schema: $name")
                if (value is JsonObject) {
                    formatJsonSchema(sb, value, "${indent}${INDENT}  ")
                }
            }
        }
    }

    private fun formatJsonSchema(sb: StringBuilder, schema: JsonObject, indent: String) {
        val type = schema["type"]?.jsonPrimitive?.content
        if (type == "object") {
            val properties = schema["properties"]
            val required = (schema["required"] as? JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.content }
                ?.toSet()
                ?: emptySet()
            if (properties is JsonObject) {
                sb.appendLine("${indent}fields:")
                for ((fieldName, fieldSchema) in properties) {
                    sb.appendLine("${indent}${INDENT}- name: $fieldName")
                    val fieldType = (fieldSchema as? JsonObject)?.get("type")?.jsonPrimitive?.content ?: "unknown"
                    sb.appendLine("${indent}${INDENT}  type: $fieldType")
                    sb.appendLine("${indent}${INDENT}  required: ${fieldName in required}")
                }
            }
        } else if (type != null) {
            sb.appendLine("${indent}type: $type")
        }
    }
}
