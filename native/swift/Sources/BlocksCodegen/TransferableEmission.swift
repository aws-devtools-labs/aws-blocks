//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

extension SwiftCodeGenerator {
    // MARK: - Transferable Helpers

    func isVoidType(_ type: ResolvedType) -> Bool {
        if case .primitive(let kind, _) = type { return kind == .void }
        if case .nullable(let inner) = type { return isVoidType(inner) }
        return false
    }

    /// The transferable to hydrate for a result: a direct transferable, or a nullable-wrapped
    /// one whose tag has a binding. A nullable unbound transferable returns nil (it keeps
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

    func isBoundTag(_ blocksType: String) -> Bool {
        knownTransferableTags.contains(blocksType) || declaredBindings[blocksType] != nil
    }

    func unboundTransferableTag(_ type: ResolvedType) -> String? {
        guard case .transferable(let blocksType, _) = type,
              !isBoundTag(blocksType) else { return nil }
        return blocksType
    }

    func transferableTypeName(
        _ blocksType: String,
        _ typeArgs: [ResolvedType],
        direct: Bool = false,
        renderArg: (ResolvedType) -> String
    ) -> String {
        guard let binding = knownTransferableBindings[blocksType] else { return "\(runtimePrefix)JSONValue" }
        // Only a direct result hydrates an OIDCClient; below the top level it decodes as its descriptor.
        // A direct one is typed by its provider enum, or `String` for an untyped spec.
        if blocksType == "oidc/client" {
            guard direct else { return "\(runtimePrefix)JSONValue" }
            return "\(runtimePrefix)\(binding.base)<\(typeArgs.first.map(renderArg) ?? "String")>"
        }
        guard binding.isGeneric else { return "\(runtimePrefix)\(binding.base)" }
        let argType = typeArgs.first.map(renderArg) ?? "\(runtimePrefix)JSONValue"
        return "\(runtimePrefix)\(binding.base)<\(argType)>"
    }

    /// From the emission `qualifiedNames`, so it matches the emitted nesting; a `$ref` stays bare.
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

    /// Names the operation, tag, platform, and generated type-argument models, never descriptor values.
    func formatUnboundTransferable(operation: String, blocksType: String, typeArgs: [ResolvedType], className: String, qualifiedNames: [String: String], cause: String = "") -> String {
        let models = typeArgs.map { diagnosticModelName($0, className: className, qualifiedNames: qualifiedNames) }.filter { !$0.isEmpty }
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
            + "'\(safeTag)' on swift\(cause); generated UnknownTransferable with \(typeArgClause)."
    }

    /// Escapes an untrusted tag so it cannot break the emitted Swift literal.
    func swiftStringLiteral(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
        return "\"\(escaped)\""
    }

    // MARK: - Swift Type Name Resolution

    /// Pre-emits any types that a given type depends on (ensures they're defined before use).
    func emitDependentTypes(_ type: ResolvedType, emitted: inout Set<String>, lines: inout [String]) {
        switch type {
        case .record(let name, _, _, let embeddedUnion):
            if !emitted.contains(name) {
                emitType(type, name: name, lines: &lines, emitted: &emitted)
            }
            if let embedded = embeddedUnion {
                emitDependentTypes(embedded, emitted: &emitted, lines: &lines)
            }
        case .enum(let name, _):
            if !emitted.contains(name) {
                emitType(type, name: name, lines: &lines, emitted: &emitted)
            }
        case .union(let name, _, _):
            if !emitted.contains(name) {
                emitType(type, name: name, lines: &lines, emitted: &emitted)
            }
        case .list(let elementType, _):
            emitDependentTypes(elementType, emitted: &emitted, lines: &lines)
        case .map(let valueType):
            emitDependentTypes(valueType, emitted: &emitted, lines: &lines)
        case .nullable(let inner):
            emitDependentTypes(inner, emitted: &emitted, lines: &lines)
        case .transferable(_, let typeArgs):
            for arg in typeArgs {
                emitDependentTypes(arg, emitted: &emitted, lines: &lines)
            }
        case .primitive, .formattedType, .typeReference:
            break
        }
    }

    /// Pure Swift type-name resolver. Does NOT emit any types — assumes the
    /// caller has already pre-emitted dependents (via `emitDependentTypes`).
    func swiftTypeNameNoEmit(_ type: ResolvedType) -> String {
        switch type {
        case .primitive(let kind, _):
            switch kind {
            case .string: return "String"
            case .boolean: return "Bool"
            case .integer: return "Int"
            case .number: return "Double"
            case .void: return "Void"
            case .unknown: return "\(runtimePrefix)JSONValue"
            }
        case .formattedType(let format, _):
            switch format {
            case .uuid:     return "UUID"
            case .dateTime: return "Date"
            case .date:     return "Date"
            case .time:     return "String"
            case .uri:      return "URL"
            }
        case .record(let name, _, _, _):
            return name
        case .enum(let name, _):
            return name
        case .list(let elementType, _):
            return "[\(swiftTypeNameNoEmit(elementType))]"
        case .map(let valueType):
            return "[String: \(swiftTypeNameNoEmit(valueType))]"
        case .nullable(let inner):
            return "\(swiftTypeNameNoEmit(inner))?"
        case .union(let name, _, _):
            return name
        case .typeReference(let name):
            return name
        case .transferable(let blocksType, let typeArgs):
            return transferableTypeName(blocksType, typeArgs) { swiftTypeNameNoEmit($0) }
        }
    }
}
