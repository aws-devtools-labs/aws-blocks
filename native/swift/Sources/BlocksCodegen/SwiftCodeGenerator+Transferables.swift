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
    /// `OIDCClient`. `argName` names a channel's message type, so the caller decides how it's spelled: bare inside
    /// the type that declares it, qualified (`GetChannel.ResultMessage`) in an operation's signature, which sits
    /// outside the operation's nested types.
    func transferableSwiftTypeName(
        _ blocksType: String, typeArgs: [ResolvedType], argName: (ResolvedType) -> String
    ) -> String {
        // `knownTransferableBindings` is the one list of tags with a runtime type; an unbound tag is `JSONValue`
        // where it's nested (an operation's direct result is `UnknownTransferable`, see `emitOperation`).
        guard let binding = knownTransferableBindings[blocksType] else { return "JSONValue" }
        guard binding.isGeneric else { return binding.base }
        return "\(binding.base)<\(typeArgs.first.map(argName) ?? "JSONValue")>"
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
                  knownTransferableTags.contains(blocksType) else { return nil }
            return (inner, true)
        default:
            return nil
        }
    }

    func unboundTransferableTag(_ type: ResolvedType) -> String? {
        guard case .transferable(let blocksType, _) = type,
              !knownTransferableTags.contains(blocksType) else { return nil }
        return blocksType
    }

    /// The body lines that hydrate an operation's transferable result from its JSON descriptor: a realtime
    /// channel, a file handle, an OIDC client, or, for a tag with no runtime binding, `UnknownTransferable`.
    /// `nullResult` is the guard for a null body (`return nil` for a nullable result, else a throw).
    func transferableResultLines(
        _ type: ResolvedType, operation: Operation, names: OperationNames, messageType: String?,
        nullResult: String, methodLiteral: String
    ) -> [String] {
        guard case .transferable(let blocksType, let typeArgs) = type else { return [] }
        let result = names.result
        let descriptor = names.descriptor
        func descriptorLines(_ kind: String) -> [String] {
            [
                "        \(nullResult)",
                "        guard let \(descriptor) = try JSONSerialization.jsonObject(with: \(result)) as? [String: Any] else {",
                "            throw RPCError(message: \"Invalid \(kind) descriptor for \(methodLiteral)\")",
                "        }"
            ]
        }
        var lines: [String] = []
        switch blocksType {
        case "realtime/channel":
            let messageType = messageType ?? "JSONValue"
            lines.append(contentsOf: descriptorLines("channel"))
            // A message holding an OIDC client or a date at any depth decodes with the client's decoder.
            if let payload = typeArgs.first, needsClientDecoder(payload, nestedTypes: operation.nestedTypes) {
                // The closure captures the client property; a parameter of its name would be captured instead.
                let property = names.clientProperty
                let capture = names.clientIsHidden ? "\(property) = self.\(property)" : property
                lines.append(
                    "        return RealtimeChannel<\(messageType)>.fromJSON(\(descriptor), baseHost: BlocksClient.baseHost)"
                    + " { [\(capture)] data in"
                )
                lines.append("            try \(property).makeDecoder().decode(\(messageType).self, from: data)")
            } else {
                lines.append("        return RealtimeChannel<\(messageType)>.fromJSON(\(descriptor), baseHost: BlocksClient.baseHost) { data in")
                lines.append("            try JSONDecoder().decode(\(messageType).self, from: data)")
            }
            lines.append("        }")
        case "file-bucket/download":
            lines.append(contentsOf: descriptorLines("file"))
            lines.append("        return try FileDownloadHandle.fromJSON(\(descriptor))")
        case "file-bucket/upload":
            lines.append(contentsOf: descriptorLines("file"))
            lines.append("        return try FileUploadHandle.fromJSON(\(descriptor))")
        case "oidc/client":
            lines.append(contentsOf: descriptorLines("OIDC client"))
            let property = "self.\(names.clientProperty)"
            lines.append("        return try OIDCClient.fromJSON(\(descriptor), baseUrl: \(property).baseUrl, client: \(property))")
        default:
            // Any tag with no known binding: the unbound fallback.
            lines.append(contentsOf: descriptorLines("transferable"))
            let tag = swiftStringContent(blocksType)
            lines.append("        return try BlocksRuntime.UnknownTransferable.fromJSON(\(descriptor), expectedTag: \"\(tag)\")")
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
        qualifiedNames: [String: String]
    ) -> String {
        let models = typeArgs
            .map { diagnosticModelName($0, className: className, qualifiedNames: qualifiedNames) }
            .filter { !$0.isEmpty }
        let typeArgClause = switch models.count {
        case 0: "no generated type-argument models"
        case 1: "type argument \(models[0])"
        default: "type arguments \(models.joined(separator: ", "))"
        }
        // Keep the diagnostic on one log line even if a tag carries a newline.
        let safeTag = blocksType
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "AWSBLOCKS-NATIVE-001: \(operation) returns unbound transferable "
            + "'\(safeTag)' on swift; generated UnknownTransferable with \(typeArgClause)."
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
