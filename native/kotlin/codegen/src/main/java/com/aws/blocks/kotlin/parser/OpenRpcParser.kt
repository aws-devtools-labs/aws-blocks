package com.aws.blocks.kotlin.parser

import com.aws.blocks.kotlin.model.Constraints
import com.aws.blocks.kotlin.model.Contact
import com.aws.blocks.kotlin.model.ContentDescriptor
import com.aws.blocks.kotlin.model.Error
import com.aws.blocks.kotlin.model.ExamplePairing
import com.aws.blocks.kotlin.model.ExternalDocumentation
import com.aws.blocks.kotlin.model.Field
import com.aws.blocks.kotlin.model.Info
import com.aws.blocks.kotlin.model.License
import com.aws.blocks.kotlin.model.Link
import com.aws.blocks.kotlin.model.Method
import com.aws.blocks.kotlin.model.RpcModel
import com.aws.blocks.kotlin.model.Server
import com.aws.blocks.kotlin.model.ServerVariable
import com.aws.blocks.kotlin.model.Tag
import com.aws.blocks.kotlin.model.TypeRef
import kotlinx.serialization.json.*

/**
 * Exception thrown when the OpenRPC parser encounters invalid or unsupported input.
 */
class OpenRpcParseException(message: String) : RuntimeException(message)

/**
 * Parses an OpenRPC JSON specification into a [com.aws.blocks.kotlin.model.RpcModel].
 *
 * Handles:
 * - Dotted method names (`"namespace.method"`) → namespace grouping
 * - JSON Schema primitives → [com.aws.blocks.kotlin.model.TypeRef.Primitive]
 * - `$ref` pointers → [com.aws.blocks.kotlin.model.TypeRef.SchemaRef] for an object schema, a
 *   named [com.aws.blocks.kotlin.model.TypeRef.UnionLiteral] for an enum, and the referenced
 *   type itself for any other schema
 * - `oneOf` with null → [com.aws.blocks.kotlin.model.TypeRef.Nullable]
 * - `type: string` + `enum` → [com.aws.blocks.kotlin.model.TypeRef.UnionLiteral]
 * - `type: array` + `items` → [com.aws.blocks.kotlin.model.TypeRef.ArrayType]
 * - `type: object` + `properties` → [com.aws.blocks.kotlin.model.TypeRef.InlineObject]
 */
object OpenRpcParser {

    fun parse(jsonContent: String): RpcModel {
        val root = try {
            Json.parseToJsonElement(jsonContent).jsonObject
        } catch (e: Exception) {
            throw OpenRpcParseException("Invalid JSON: ${e.message}")
        }

        val componentsObj = root["components"]?.jsonObject
        val schemas = componentsObj
            ?.get("schemas")
            ?.jsonObject
            ?: JsonObject(emptyMap())

        val info = parseInfo(root)
        val servers = parseServers(root)
        val endpoint = root["x-blocks-endpoint"]?.jsonPrimitive?.contentOrNull

        val methodsArray = root["methods"]?.jsonArray
            ?: return RpcModel(info = info, methods = emptyList(), servers = servers, components = componentsObj, endpoint = endpoint)

        val methods = mutableListOf<Method>()

        for (method in methodsArray) {
            val obj = method.jsonObject
            val fullName = obj["name"]?.jsonPrimitive?.content
                ?: throw OpenRpcParseException("Method missing 'name' field")

            val description = obj["description"]?.jsonPrimitive?.contentOrNull

            val params = obj["params"]?.jsonArray?.map { paramEl ->
                val paramObj = paramEl.jsonObject
                val paramName = paramObj["name"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("Parameter missing 'name' in method '$fullName'")
                val required = paramObj["required"]?.jsonPrimitive?.booleanOrNull ?: true
                val schema = paramObj["schema"]?.jsonObject
                    ?: throw OpenRpcParseException("Parameter '$paramName' missing 'schema' in method '$fullName'")
                ContentDescriptor(
                    name = paramName,
                    schema = resolveSchema(schema, schemas),
                    description = paramObj["description"]?.jsonPrimitive?.contentOrNull,
                    summary = paramObj["summary"]?.jsonPrimitive?.contentOrNull,
                    required = required,
                    deprecated = paramObj["deprecated"]?.jsonPrimitive?.booleanOrNull ?: false,
                )
            } ?: emptyList()

            val resultObj = obj["result"]?.jsonObject
            val result = if (resultObj != null) {
                val resultSchema = resultObj["schema"]?.jsonObject
                if (resultSchema != null) {
                    ContentDescriptor(
                        name = resultObj["name"]?.jsonPrimitive?.content ?: "result",
                        schema = resolveSchema(resultSchema, schemas),
                        description = resultObj["description"]?.jsonPrimitive?.contentOrNull,
                        summary = resultObj["summary"]?.jsonPrimitive?.contentOrNull,
                        required = resultObj["required"]?.jsonPrimitive?.booleanOrNull ?: false,
                        deprecated = resultObj["deprecated"]?.jsonPrimitive?.booleanOrNull ?: false,
                    )
                } else {
                    null
                }
            } else {
                null
            }

            methods.add(
                Method(
                    name = fullName,
                    params = params,
                    result = result,
                    description = description,
                    summary = obj["summary"]?.jsonPrimitive?.contentOrNull,
                    tags = parseTags(obj),
                    errors = parseErrors(obj, schemas),
                    links = parseLinks(obj),
                    examples = parseExamples(obj),
                    externalDocs = parseExternalDocs(obj),
                    deprecated = obj["deprecated"]?.jsonPrimitive?.booleanOrNull ?: false,
                    paramStructure = obj["paramStructure"]?.jsonPrimitive?.contentOrNull,
                )
            )
        }

        return RpcModel(info = info, methods = methods, servers = servers, components = componentsObj, endpoint = endpoint)
    }

    private fun parseInfo(root: JsonObject): Info {
        val infoObj = root["info"]?.jsonObject
            ?: throw OpenRpcParseException("Missing required 'info' object")
        val title = infoObj["title"]?.jsonPrimitive?.content
            ?: throw OpenRpcParseException("Missing required 'info.title' field")
        val version = infoObj["version"]?.jsonPrimitive?.content
            ?: throw OpenRpcParseException("Missing required 'info.version' field")

        val contact = infoObj["contact"]?.jsonObject?.let { c ->
            Contact(
                name = c["name"]?.jsonPrimitive?.contentOrNull,
                url = c["url"]?.jsonPrimitive?.contentOrNull,
                email = c["email"]?.jsonPrimitive?.contentOrNull,
            )
        }

        val license = infoObj["license"]?.jsonObject?.let { l ->
            License(
                name = l["name"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("License missing required 'name' field"),
                url = l["url"]?.jsonPrimitive?.contentOrNull,
            )
        }

        return Info(
            title = title,
            version = version,
            description = infoObj["description"]?.jsonPrimitive?.contentOrNull,
            termsOfService = infoObj["termsOfService"]?.jsonPrimitive?.contentOrNull,
            contact = contact,
            license = license,
        )
    }

    private fun parseServers(root: JsonObject): List<Server> {
        val serversArray = root["servers"]?.jsonArray ?: return emptyList()
        return serversArray.map { element ->
            val obj = element.jsonObject
            val name = obj["name"]?.jsonPrimitive?.content
                ?: throw OpenRpcParseException("Server entry missing 'name' field")
            val url = obj["url"]?.jsonPrimitive?.content
                ?: throw OpenRpcParseException("Server entry missing 'url' field")
            Server(
                name = name,
                url = url,
                description = obj["description"]?.jsonPrimitive?.contentOrNull,
                summary = obj["summary"]?.jsonPrimitive?.contentOrNull,
                variables = parseServerVariables(obj),
            )
        }
    }

    private fun parseServerVariables(serverObj: JsonObject): Map<String, ServerVariable> {
        val varsObj = serverObj["variables"]?.jsonObject ?: return emptyMap()
        return varsObj.mapValues { (_, value) ->
            val varObj = value.jsonObject
            ServerVariable(
                default = varObj["default"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("Server variable missing required 'default' field"),
                description = varObj["description"]?.jsonPrimitive?.contentOrNull,
                enum = varObj["enum"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            )
        }
    }

    private fun parseTags(methodObj: JsonObject): List<Tag> {
        val tagsArray = methodObj["tags"]?.jsonArray ?: return emptyList()
        return tagsArray.map { tagEl ->
            val tagObj = tagEl.jsonObject
            Tag(
                name = tagObj["name"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("Tag missing required 'name' field"),
                summary = tagObj["summary"]?.jsonPrimitive?.contentOrNull,
                description = tagObj["description"]?.jsonPrimitive?.contentOrNull,
                externalDocs = parseExternalDocs(tagObj),
            )
        }
    }

    private fun parseErrors(methodObj: JsonObject, schemas: JsonObject): List<Error> {
        val errorsArray = methodObj["errors"]?.jsonArray ?: return emptyList()
        return errorsArray.map { errEl ->
            val errObj = errEl.jsonObject
            val dataSchema = errObj["data"]?.jsonObject?.let { resolveSchema(it, schemas) }
            Error(
                code = errObj["code"]?.jsonPrimitive?.int
                    ?: throw OpenRpcParseException("Error missing required 'code' field"),
                message = errObj["message"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("Error missing required 'message' field"),
                data = dataSchema,
            )
        }
    }

    private fun parseLinks(methodObj: JsonObject): List<Link> {
        val linksArray = methodObj["links"]?.jsonArray ?: return emptyList()
        return linksArray.map { linkEl ->
            val linkObj = linkEl.jsonObject
            val serverObj = linkObj["server"]?.jsonObject
            val server = if (serverObj != null) {
                Server(
                    name = serverObj["name"]?.jsonPrimitive?.content
                        ?: throw OpenRpcParseException("Link server missing 'name' field"),
                    url = serverObj["url"]?.jsonPrimitive?.content
                        ?: throw OpenRpcParseException("Link server missing 'url' field"),
                    description = serverObj["description"]?.jsonPrimitive?.contentOrNull,
                    summary = serverObj["summary"]?.jsonPrimitive?.contentOrNull,
                    variables = parseServerVariables(serverObj),
                )
            } else null
            Link(
                name = linkObj["name"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("Link missing required 'name' field"),
                summary = linkObj["summary"]?.jsonPrimitive?.contentOrNull,
                description = linkObj["description"]?.jsonPrimitive?.contentOrNull,
                method = linkObj["method"]?.jsonPrimitive?.contentOrNull,
                params = linkObj["params"]?.jsonObject?.mapValues { (_, v) -> v as Any },
                server = server,
            )
        }
    }

    private fun parseExamples(methodObj: JsonObject): List<ExamplePairing> {
        val examplesArray = methodObj["examples"]?.jsonArray ?: return emptyList()
        return examplesArray.map { exEl ->
            val exObj = exEl.jsonObject
            ExamplePairing(
                name = exObj["name"]?.jsonPrimitive?.content
                    ?: throw OpenRpcParseException("ExamplePairing missing required 'name' field"),
                summary = exObj["summary"]?.jsonPrimitive?.contentOrNull,
                description = exObj["description"]?.jsonPrimitive?.contentOrNull,
                params = exObj["params"]?.jsonArray?.toList() ?: emptyList(),
                result = exObj["result"],
            )
        }
    }

    private fun parseExternalDocs(obj: JsonObject): ExternalDocumentation? {
        val docsObj = obj["externalDocs"]?.jsonObject ?: return null
        return ExternalDocumentation(
            url = docsObj["url"]?.jsonPrimitive?.content
                ?: throw OpenRpcParseException("ExternalDocumentation missing required 'url' field"),
            description = docsObj["description"]?.jsonPrimitive?.contentOrNull,
        )
    }

    private fun extractConstraints(schema: JsonObject): Constraints {
        return Constraints(
            format = schema["format"]?.jsonPrimitive?.contentOrNull,
            minLength = schema["minLength"]?.jsonPrimitive?.intOrNull,
            maxLength = schema["maxLength"]?.jsonPrimitive?.intOrNull,
            pattern = schema["pattern"]?.jsonPrimitive?.contentOrNull,
            minimum = schema["minimum"]?.jsonPrimitive?.doubleOrNull,
            maximum = schema["maximum"]?.jsonPrimitive?.doubleOrNull,
            exclusiveMinimum = schema["exclusiveMinimum"]?.jsonPrimitive?.doubleOrNull,
            exclusiveMaximum = schema["exclusiveMaximum"]?.jsonPrimitive?.doubleOrNull,
            multipleOf = schema["multipleOf"]?.jsonPrimitive?.doubleOrNull,
            minItems = schema["minItems"]?.jsonPrimitive?.intOrNull,
            maxItems = schema["maxItems"]?.jsonPrimitive?.intOrNull,
        )
    }

    internal fun resolveSchema(
        schema: JsonObject,
        components: JsonObject
    ): TypeRef {
        // Handle x-blocks-transferable
        schema["x-blocks-transferable"]?.let { transferableEl ->
            val transferableName = transferableEl.jsonPrimitive.content
            val typeArgs = schema["x-blocks-type-args"]?.jsonArray?.map { argEl ->
                val argObj = argEl.jsonObject
                resolveSchema(argObj, components)
            } ?: emptyList()
            return TypeRef.Transferable(transferableName, typeArgs)
        }

        // Handle const (z.literal) — treat as a single-value enum for discriminator detection
        schema["const"]?.let { constEl ->
            val constValue = when (constEl) {
                is JsonPrimitive -> constEl.content
                else -> constEl.toString()
            }
            return TypeRef.UnionLiteral(listOf(constValue), literals = listOf(constEl as? JsonPrimitive ?: JsonPrimitive(constValue)))
        }

        // Handle $ref
        schema["\$ref"]?.let { refEl ->
            val ref = refEl.jsonPrimitive.content
            return resolveRef(ref, components)
        }

        // Handle hybrid: oneOf + type: "object" with properties (regrouped arm)
        val oneOfEl = schema["oneOf"]
        val schemaType = schema["type"]?.jsonPrimitive?.contentOrNull
        if (oneOfEl != null && schemaType == "object" && schema.containsKey("properties")) {
            val properties = schema["properties"]!!.jsonObject
            val required = schema["required"]?.jsonArray
                ?.map { it.jsonPrimitive.content }
                ?.toSet()
                ?: emptySet()
            val fields = properties.map { (name, propSchema) ->
                Field(
                    name = name,
                    type = resolveSchema(propSchema.jsonObject, components),
                    required = name in required,
                    description = propSchema.jsonObject["description"]?.jsonPrimitive?.contentOrNull,
                    defaultValue = propSchema.jsonObject["default"],
                )
            }
            val members = oneOfEl.jsonArray.map { resolveSchema(it.jsonObject, components) }
            return TypeRef.ObjectWithOneOf(fields = fields, oneOf = members)
        }

        // Handle oneOf
        if (oneOfEl != null) {
            val members = oneOfEl.jsonArray
            val nullCount = members.count {
                it.jsonObject["type"]?.jsonPrimitive?.contentOrNull == "null"
            }
            val nonNull = members.filter {
                it.jsonObject["type"]?.jsonPrimitive?.contentOrNull != "null"
            }
            if (nullCount == 1 && nonNull.size == 1) {
                val inner = resolveSchema(nonNull[0].jsonObject, components)
                return TypeRef.Nullable(inner)
            }
            // General union
            return TypeRef.Union(members.map { resolveSchema(it.jsonObject, components) })
        }

        // Handle anyOf (treat same as oneOf — inclusive vs exclusive doesn't matter for codegen)
        schema["anyOf"]?.let { anyOfEl ->
            val members = anyOfEl.jsonArray
            val nullCount = members.count {
                it.jsonObject["type"]?.jsonPrimitive?.contentOrNull == "null"
            }
            val nonNull = members.filter {
                it.jsonObject["type"]?.jsonPrimitive?.contentOrNull != "null"
            }
            if (nullCount == 1 && nonNull.size == 1) {
                val inner = resolveSchema(nonNull[0].jsonObject, components)
                return TypeRef.Nullable(inner)
            }
            return TypeRef.Union(members.map { resolveSchema(it.jsonObject, components) })
        }

        val type = schema["type"]?.jsonPrimitive?.contentOrNull

        // Handle string enum
        if (type == "string" && schema.containsKey("enum")) {
            val literals = schema["enum"]!!.jsonArray.map { it.jsonPrimitive }
            return TypeRef.UnionLiteral(literals.map { it.content }, literals = literals)
        }

        // Handle boolean enum (e.g. "type": "boolean", "enum": [true]) — used as discriminator
        if (type == "boolean" && schema.containsKey("enum")) {
            val literals = schema["enum"]!!.jsonArray.map { it.jsonPrimitive }
            return TypeRef.UnionLiteral(literals.map { it.content }, literals = literals)
        }

        return when (type) {
            "string" -> TypeRef.Primitive("string", extractConstraints(schema))
            "integer" -> TypeRef.Primitive("integer", extractConstraints(schema))
            "number" -> TypeRef.Primitive("number", extractConstraints(schema))
            "boolean" -> TypeRef.Primitive("boolean")
            "null" -> TypeRef.Primitive("void")
            "unknown" -> TypeRef.Primitive("unknown")
            "array" -> {
                // Check for tuple: prefixItems (JSON Schema 2020-12)
                schema["prefixItems"]?.let { prefixItemsEl ->
                    val fields = prefixItemsEl.jsonArray.mapIndexed { i, itemSchema ->
                        Field(name = "item$i", type = resolveSchema(itemSchema.jsonObject, components), required = true)
                    }
                    return TypeRef.InlineObject(fields)
                }

                // Check for tuple: array-form items (older JSON Schema drafts)
                val itemsElement = schema["items"]
                if (itemsElement != null && itemsElement is kotlinx.serialization.json.JsonArray) {
                    val fields = itemsElement.mapIndexed { i, itemSchema ->
                        Field(name = "item$i", type = resolveSchema(itemSchema.jsonObject, components), required = true)
                    }
                    return TypeRef.InlineObject(fields)
                }

                // Normal array
                val items = schema["items"]?.jsonObject
                    ?: throw OpenRpcParseException("Array schema missing 'items'")
                TypeRef.ArrayType(resolveSchema(items, components), extractConstraints(schema))
            }
            "object" -> {
                val properties = schema["properties"]?.jsonObject ?: JsonObject(emptyMap())
                val additionalProperties = schema["additionalProperties"]?.jsonObject

                // Record pattern: additionalProperties present but no meaningful properties
                if (properties.isEmpty() && additionalProperties != null) {
                    return TypeRef.MapType(resolveSchema(additionalProperties, components))
                }

                val required = schema["required"]?.jsonArray
                    ?.map { it.jsonPrimitive.content }
                    ?.toSet()
                    ?: emptySet()
                val fields = properties.map { (name, propSchema) ->
                    Field(
                        name = name,
                        type = resolveSchema(propSchema.jsonObject, components),
                        required = name in required,
                        description = propSchema.jsonObject["description"]?.jsonPrimitive?.contentOrNull,
                        defaultValue = propSchema.jsonObject["default"],
                    )
                }
                val addProps = if (additionalProperties != null) resolveSchema(additionalProperties, components) else null
                TypeRef.InlineObject(fields, additionalProperties = addProps)
            }
            else -> throw OpenRpcParseException("Unsupported schema type [$type] in schema [$schema]")
        }
    }

    internal fun resolveRef(
        ref: String,
        components: JsonObject
    ): TypeRef {
        val prefix = "#/components/schemas/"
        if (!ref.startsWith(prefix)) {
            throw OpenRpcParseException("Unsupported \$ref format: $ref")
        }
        val schemaName = ref.removePrefix(prefix)
        val schemaObj = components[schemaName]?.jsonObject
            ?: throw OpenRpcParseException("Unresolved \$ref: $ref")

        // An object schema becomes a named type and an enum a named enum. Any other schema (a
        // primitive, array, map, nullable, union or transferable) is used as the type it declares.
        return when (val resolved = resolveSchema(schemaObj, components)) {
            is TypeRef.InlineObject -> {
                val schemaDescription = schemaObj["description"]?.jsonPrimitive?.contentOrNull
                TypeRef.SchemaRef(schemaName = schemaName, resolved = resolved, description = schemaDescription)
            }
            is TypeRef.UnionLiteral -> resolved.copy(schemaName = schemaName)
            else -> resolved
        }
    }
}
