//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - String Helpers

// Grounded in the Swift Reference § Keywords and Punctuation.
// Only true reserved keywords that cannot appear bare as identifiers.
// Contextual modifiers (final, required, override, lazy, weak, etc.)
// compile bare as struct field names and are intentionally excluded.
let swiftKeywords: Set<String> = [
    // Declarations
    "class", "struct", "enum", "protocol", "func", "var", "let",
    "import", "typealias", "associatedtype", "init", "deinit",
    "subscript", "operator", "precedencegroup", "extension",
    "static", "indirect",
    // Statements
    "if", "else", "switch", "case", "default", "for", "while",
    "repeat", "do", "break", "continue", "return", "fallthrough",
    "guard", "defer", "where", "in",
    // Expressions & types
    "as", "is", "try", "throw", "throws", "rethrows", "catch",
    "self", "Self", "super", "inout", "some", "any",
    "async", "await",
    // Access control (reserved, not contextual modifiers)
    "internal", "private", "public", "fileprivate",
    // Literals
    "true", "false", "nil",
    // Used as keyword in identifier position
    "type",
]

/// Type names that collide with Swift standard library, Foundation, or SwiftUI types.
let reservedTypeNames: Set<String> = [
    "State", "Type", "Method", "Error", "Result", "Action",
    "View", "Body", "Content", "Image", "Text", "Button",
    "List", "Group", "Section", "Form", "Label", "Picker",
    "Color", "Font", "Path", "Shape", "Scene", "App",
    "Binding", "Published", "Observable", "Environment",
    "Any", "AnyObject", "Optional", "Array", "Dictionary", "Set"
]

/// PascalCase string transformer. Splits on `-`, `.`, and `:` (always); preserves
/// underscores so deliberately-namespaced names like `Fields_SignUp` survive.
/// Each segment between underscores is independently PascalCased so
/// `fields_signUp` becomes `Fields_SignUp` (not `FieldsSignUp`, which would
/// collide with `Fields_SignUp` from the spec's component schemas).
/// Splitting on `:` lets Cognito custom-attribute names like `custom:email`
/// survive into a Swift-legal type name (`CustomEmail`).
///
/// Exception: SCREAMING_SNAKE_CASE strings (all uppercase + digits + underscores)
/// collapse underscores so `CONFIRM_SIGN_UP` → `ConfirmSignUp`.
func pascalCase(_ s: String) -> String {
    let isScreamingSnake = s.contains("_") && s.allSatisfy { $0.isUppercase || $0.isNumber || $0 == "_" }
    if isScreamingSnake {
        return s.split(separator: "_")
            .map { segment in
                segment.prefix(1).uppercased() + segment.dropFirst().lowercased()
            }
            .joined()
    }
    return s.split(separator: "_", omittingEmptySubsequences: false)
     .map { underscorePart -> String in
         underscorePart.split(separator: "-")
             .flatMap { $0.split(separator: ".") }
             .flatMap { $0.split(separator: ":") }
             .map { segment in
                 if segment.allSatisfy({ $0.isUppercase || $0.isNumber }) && segment.count > 1 {
                     return segment.prefix(1).uppercased() + segment.dropFirst().lowercased()
                 }
                 return segment.prefix(1).uppercased() + segment.dropFirst()
             }
             .joined()
     }
     .joined(separator: "_")
}

/// Names a union variant from its discriminator field + value.
/// Boolean discriminators (`isSignedIn: true`) become `IsSignedInTrue` / `IsSignedInFalse`
/// to avoid collisions. String discriminators use the value directly.
func variantNameFromDiscriminator(fieldName: String, value: String) -> String {
    if value == "true" || value == "false" {
        return pascalCase(fieldName) + pascalCase(value)
    }
    return pascalCase(value)
}

func camelCase(_ s: String) -> String {
    let pascal = pascalCase(s)
    return pascal.prefix(1).lowercased() + pascal.dropFirst()
}

func singularize(_ s: String) -> String {
    if s.hasSuffix("s") && !s.hasSuffix("ss") {
        return String(s.dropLast())
    }
    return s
}

func swiftMethodName(_ rpcName: String) -> String {
    let parts = rpcName.split(separator: ".", maxSplits: 1)
    if parts.count > 1 {
        return String(parts[1])
    }
    return camelCase(rpcName)
}

/// Returns a safe Swift type name, prefixing with parentName if the name collides
/// with a reserved Swift/SwiftUI type. If no parent is available, appends "Value" suffix.
func safeTypeName(_ name: String, parentName: String?) -> String {
    if reservedTypeNames.contains(name) {
        if let parent = parentName, !parent.isEmpty {
            return parent + name
        }
        return name + "Value"
    }
    return name
}

/// Returns true if `name` is a valid Swift identifier:
/// starts with letter/underscore, rest are letters/digits/underscores.
func isValidSwiftIdentifier(_ name: String) -> Bool {
    guard let first = name.first else { return false }
    if !(first.isLetter || first == "_") { return false }
    for ch in name.dropFirst() {
        if !(ch.isLetter || ch.isNumber || ch == "_") { return false }
    }
    return true
}

/// Sanitize an arbitrary spec property name into a Swift-legal identifier.
/// Replaces illegal chars with underscores and prefixes a leading underscore
/// when the name starts with a digit or is empty. Used for record field names
/// like `custom:email` (Cognito attributes) which are valid JSON keys but
/// not valid Swift property names.
func sanitizedSwiftName(_ name: String) -> String {
    if name.isEmpty { return "_unnamed" }
    var result = ""
    for (i, ch) in name.enumerated() {
        if ch.isLetter || ch == "_" || (i > 0 && ch.isNumber) {
            result.append(ch)
        } else {
            result.append("_")
        }
    }
    if let first = result.first, first.isNumber {
        result = "_" + result
    }
    return result
}

/// Escape a Swift identifier for use as a property/parameter name.
/// Wraps Swift keywords in backticks and sanitizes illegal characters.
func escapedSwiftName(_ name: String) -> String {
    let safe = isValidSwiftIdentifier(name) ? name : sanitizedSwiftName(name)
    if swiftKeywords.contains(safe) {
        return "`\(safe)`"
    }
    return safe
}
