//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Transferable type names

extension SwiftCodeGenerator {
    /// The Swift type of a transferable: `RealtimeChannel<Message>`, `FileDownloadHandle`, `FileUploadHandle` or
    /// `OIDCClient<Provider>`. `argName` names a channel's message type, so the caller decides how it's spelled: bare inside
    /// the type that declares it, qualified (`GetChannel.ResultMessage`) in an operation's signature, which sits
    /// outside the operation's nested types.
    func transferableSwiftTypeName(
        _ blocksType: String, typeArgs: [ResolvedType], argName: (ResolvedType) -> String
    ) -> String {
        // `knownTransferableBindings` is the one list of tags with a runtime type; an unbound tag is `JSONValue`
        // where it's nested (an operation's direct result is `UnknownTransferable`, see `emitOperation`).
        guard let binding = knownTransferableBindings[blocksType] else { return "\(runtimePrefix)JSONValue" }
        // An OIDC client is typed by its provider enum (an operation's direct result), or `String` where the spec
        // doesn't name its providers or the client sits below the top level.
        if blocksType == "oidc/client" {
            return "\(runtimePrefix)\(binding.base)<\(typeArgs.first.map(argName) ?? "String")>"
        }
        guard binding.isGeneric else { return "\(runtimePrefix)\(binding.base)" }
        return "\(runtimePrefix)\(binding.base)<\(typeArgs.first.map(argName) ?? "\(runtimePrefix)JSONValue")>"
    }
}

// MARK: - Transferable results

extension SwiftCodeGenerator {
    /// The transferable to hydrate for a result: a direct transferable, or a nullable-wrapped
    /// one whose tag has a known binding. A nullable unbound transferable returns nil (it keeps
    /// its prior `JSONValue?` behavior, since the UnknownTransferable fallback is direct-only).
    func transferableResult(_ type: ResolvedType) -> (type: ResolvedType, optional: Bool)? {
        switch type {
        case .transferable:
            return (type, false)
        case .nullable(let inner):
            guard case .transferable(let blocksType, _) = inner,
                  isBoundTag(blocksType) else { return nil }
            return (inner, true)
        default:
            return nil
        }
    }

    func unboundTransferableTag(_ type: ResolvedType) -> String? {
        guard case .transferable(let blocksType, _) = type,
              !isBoundTag(blocksType) else { return nil }
        return blocksType
    }

    /// A tag with a runtime type (BlocksRuntime's own) or one a block's native package declares.
    func isBoundTag(_ blocksType: String) -> Bool {
        knownTransferableTags.contains(blocksType) || declaredBindings[blocksType] != nil
    }

    /// The body lines that hydrate an operation's transferable result from its JSON descriptor: a realtime
    /// channel, a file handle, an OIDC client, or, for a tag with no runtime binding, `UnknownTransferable`.
    /// `nullResult` is the guard for a null body (`return nil` for a nullable result, else a throw).
    func transferableResultLines(
        _ type: ResolvedType, operation: Operation, names: OperationNames, messageType: String?,
        nullResult: String
    ) -> [String] {
        guard case .transferable(let blocksType, _) = type else { return [] }
        let result = names.result
        let descriptor = names.descriptor
        func descriptorLines() -> [String] {
            [
                "        \(nullResult)",
                "        guard let \(descriptor) = try JSONSerialization.jsonObject(with: \(result)) as? [String: Any] else {",
                "            throw \(runtimePrefix)TransferableError.invalidDescriptor(blocksType: \"\(blocksType)\", missingField: \"__blocks\")",
                "        }"
            ]
        }
        var lines: [String] = []
        switch blocksType {
        case "realtime/channel":
            let messageType = messageType ?? "\(runtimePrefix)JSONValue"
            lines.append("        \(nullResult)")
            // Decoded in BlocksRuntime: a message-decoding closure formed in generated code inherits the app's
            // MainActor default isolation and traps when the socket task calls it. The client's decoder carries the
            // client, so a message holding an OIDC client or a date decodes as it does in a result.
            lines.append(
                "        return try self.\(names.clientProperty).makeDecoder()"
                    + ".decode(\(runtimePrefix)RealtimeChannel<\(messageType)>.self, from: \(result))"
            )
        case "file-bucket/download":
            lines.append(contentsOf: descriptorLines())
            lines.append("        return try \(runtimePrefix)FileDownloadHandle.fromJSON(\(descriptor))")
        case "file-bucket/upload":
            lines.append(contentsOf: descriptorLines())
            lines.append("        return try \(runtimePrefix)FileUploadHandle.fromJSON(\(descriptor))")
        case "oidc/client":
            lines.append(contentsOf: descriptorLines())
            let property = "self.\(names.clientProperty)"
            let provider = messageType ?? "String"
            lines.append(
                "        return try \(runtimePrefix)OIDCClient<\(provider)>"
                    + ".fromJSON(\(descriptor), baseUrl: \(property).baseUrl, client: \(property))"
            )
        default:
            // A tag a block's native package declares hydrates into the declared type; any other tag is the
            // unbound fallback, `UnknownTransferable`.
            lines.append(contentsOf: descriptorLines())
            let hydration = transferableHydrationLines(
                declared: declaredBindings[blocksType],
                tagLiteral: "\"\(swiftStringContent(blocksType))\"",
                messageType: messageType ?? "\(runtimePrefix)JSONValue",
                runtimePrefix: runtimePrefix
            )
            lines.append(contentsOf: hydration.map { $0.replacingOccurrences(of: "(descriptor,", with: "(\(descriptor),") })
        }
        return lines
    }

    /// From the emission `qualifiedNames`, so it matches the emitted nesting; a `$ref` stays bare.
    /// `className` is the namespace's generated class, which holds the operation's nested types.
    private func diagnosticModelName(_ type: ResolvedType, className: String, qualifiedNames: [String: String]) -> String {
        switch type {
        case .record(let name, _, _, _), .enum(let name, _), .union(let name, _, _):
            return "\(className).\(qualifiedNames[name] ?? name)"
        case .typeReference(let name):
            return name
        case .list(let elementType, _):
            return diagnosticModelName(elementType, className: className, qualifiedNames: qualifiedNames)
        case .map(let valueType):
            return diagnosticModelName(valueType, className: className, qualifiedNames: qualifiedNames)
        case .nullable(let inner):
            return diagnosticModelName(inner, className: className, qualifiedNames: qualifiedNames)
        default:
            return ""
        }
    }

    /// The AWSBLOCKS-NATIVE-001 diagnostic. Names the operation, tag, platform, and generated type-argument
    /// models, never descriptor values.
    func formatUnboundTransferable(
        operation: String, blocksType: String, typeArgs: [ResolvedType], className: String,
        qualifiedNames: [String: String], cause: String = ""
    ) -> String {
        let models = typeArgs
            .map { diagnosticModelName($0, className: className, qualifiedNames: qualifiedNames) }
            .filter { !$0.isEmpty }
        let typeArgClause = switch models.count {
        case 0: "no generated type-argument models"
        case 1: "type argument \(models[0])"
        default: "type arguments \(models.joined(separator: ", "))"
        }
        let safeTag = escapedForDiagnostic(blocksType)
        return "AWSBLOCKS-NATIVE-001: \(escapedForDiagnostic(operation)) returns unbound transferable "
            + "'\(safeTag)' on swift\(cause); generated UnknownTransferable with \(typeArgClause)."
    }
}

// MARK: - Transferables in models

extension SwiftCodeGenerator {
    /// True when decoding `type` hydrates an `oidc/client` transferable, at any depth: in a field, a list, a map,
    /// an optional, a union variant, an open record's values, an embedded union, a channel's message type, or a
    /// type it references. `OIDCClient` decodes only with the calling `BlocksClient` in the decoder's `userInfo`.
    /// Also true when `type` holds a `Date` (`format: date-time`) anywhere: it decodes from an ISO 8601 string,
    /// which only the client's decoder (`BlocksClient.makeDecoder()`) reads.
    ///
    /// `nestedTypes` are the types the operation declares (`GetX.Result.Inner`). A reference resolves the way
    /// Swift resolves the bare name: the innermost nested type with that name, then a component schema. Each
    /// component schema is visited once, so recursive schemas terminate.
    func needsClientDecoder(_ type: ResolvedType, nestedTypes: [NestedTypeNode]) -> Bool {
        var visited: Set<String> = []
        return needsClientDecoder(type, scopes: [flattened(nestedTypes)], visited: &visited)
    }

    private func flattened(_ nodes: [NestedTypeNode]) -> [NestedTypeNode] {
        nodes.flatMap { [$0] + flattened($0.children) }
    }

    /// `scopes` lists the nested types visible at this point, innermost first.
    private func needsClientDecoder(_ type: ResolvedType, scopes: [[NestedTypeNode]], visited: inout Set<String>) -> Bool {
        switch type {
        case .transferable(let blocksType, let typeArgs):
            if blocksType == "oidc/client" { return true }
            return typeArgs.contains { needsClientDecoder($0, scopes: scopes, visited: &visited) }
        case .record(_, let fields, let additionalPropertiesType, let embeddedUnion):
            return fields.contains { needsClientDecoder($0.type, scopes: scopes, visited: &visited) }
                || additionalPropertiesType.map { needsClientDecoder($0, scopes: scopes, visited: &visited) } ?? false
                || embeddedUnion.map { needsClientDecoder($0, scopes: scopes, visited: &visited) } ?? false
        case .union(_, let variants, _):
            return variants.contains { variant in
                if let payload = variant.payloadTypeName,
                   needsClientDecoder(.typeReference(name: payload), scopes: scopes, visited: &visited) {
                    return true
                }
                let variantScopes = [variant.nestedTypes] + scopes
                return variant.fields.contains { needsClientDecoder($0.type, scopes: variantScopes, visited: &visited) }
                    || variant.additionalPropertiesType.map { needsClientDecoder($0, scopes: variantScopes, visited: &visited) } ?? false
                    || variant.embeddedUnion.map { needsClientDecoder($0, scopes: variantScopes, visited: &visited) } ?? false
                    || variant.valueType.map { needsClientDecoder($0, scopes: variantScopes, visited: &visited) } ?? false
            }
        case .typeReference(let name):
            for (depth, scope) in scopes.enumerated() {
                if let node = scope.first(where: { $0.name == name }) {
                    let nodeScopes = [node.children] + scopes[depth...]
                    // A nested type reached again with the same scope chain is a cycle: it adds nothing.
                    let key = "\(name)@\(nodeScopes.count)"
                    guard visited.insert(key).inserted else { return false }
                    defer { visited.remove(key) }
                    return needsClientDecoder(node.type, scopes: nodeScopes, visited: &visited)
                }
            }
            guard let referenced = typesByName[name], visited.insert(name).inserted else { return false }
            return needsClientDecoder(referenced, scopes: [nestedTypesByName[name] ?? []], visited: &visited)
        case .list(let elementType, _):
            return needsClientDecoder(elementType, scopes: scopes, visited: &visited)
        case .map(let valueType):
            return needsClientDecoder(valueType, scopes: scopes, visited: &visited)
        case .nullable(let inner):
            return needsClientDecoder(inner, scopes: scopes, visited: &visited)
        case .formattedType(let format, _):
            return format == .dateTime
        case .primitive, .enum:
            return false
        }
    }
}

// MARK: - Transferable parameters

extension SwiftCodeGenerator {
    /// Throws `CodegenError.transferableParameter` for the first operation parameter that is a transferable:
    /// directly, optional or nullable, in an array or a dictionary, or through a `$ref` to one. A transferable is
    /// read-only (the server hands it out and never re-hydrates one sent back), so a method taking one could only
    /// fail at call time. This refuses exactly what the Kotlin generator refuses, with its message: a model, an
    /// inline object or a union that holds a transferable still generates, as it does in Kotlin. Namespaces are
    /// walked in the order the spec first names them, each one's operations in spec order, as Kotlin generates
    /// them, so both name the same tag.
    func rejectTransferableParameters(_ model: CodegenModel) throws {
        let byName = Dictionary(uniqueKeysWithValues: model.apiNamespaces.map { ($0.name, $0) })
        for namespace in model.namespaceSpecOrder.compactMap({ byName[$0] }) {
            for operation in namespace.operations {
                for parameter in operation.parameters {
                    var visited: Set<String> = []
                    if let tag = transferableTag(parameter.type, visited: &visited) {
                        throw CodegenError.transferableParameter(tag: tag)
                    }
                }
            }
        }
    }

    /// The tag of the transferable `type` is, through nullables, arrays, dictionaries and references, or nil.
    /// Records and unions are not entered. Each reference is followed once, so an alias of itself terminates.
    private func transferableTag(_ type: ResolvedType, visited: inout Set<String>) -> String? {
        switch type {
        case .transferable(let blocksType, _):
            return blocksType
        case .nullable(let inner), .list(let inner, _), .map(let inner):
            return transferableTag(inner, visited: &visited)
        case .typeReference(let name):
            guard let referenced = typesByName[name], visited.insert(name).inserted else { return nil }
            return transferableTag(referenced, visited: &visited)
        case .record, .union, .primitive, .formattedType, .enum:
            return nil
        }
    }
}
