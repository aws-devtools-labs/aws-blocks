//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

final class HelpersTests: XCTestCase {

    // MARK: - pascalCase

    func testPascalCaseSimple() {
        XCTAssertEqual(pascalCase("hello"), "Hello")
    }

    // pascalCase deliberately preserves underscores so synthesized type names
    // like `Fields_SignUp` survive intact — see Helpers.swift docstring. JSON
    // field names go through `escapedSwiftName`, not pascalCase, so this only
    // affects type-name segments.
    func testPascalCaseSnakeCase() {
        XCTAssertEqual(pascalCase("created_at"), "Created_At")
    }

    func testPascalCaseKebabCase() {
        XCTAssertEqual(pascalCase("my-component"), "MyComponent")
    }

    func testPascalCaseDotSeparated() {
        XCTAssertEqual(pascalCase("api.createTodo"), "ApiCreateTodo")
    }

    func testPascalCaseMixed() {
        XCTAssertEqual(pascalCase("get_user-name.full"), "Get_UserNameFull")
    }

    func testPascalCaseAlreadyPascal() {
        XCTAssertEqual(pascalCase("MyType"), "MyType")
    }

    // MARK: - camelCase

    func testCamelCaseSimple() {
        XCTAssertEqual(camelCase("Hello"), "hello")
    }

    func testCamelCaseSnakeCase() {
        // Underscores survive — see pascalCase docstring.
        XCTAssertEqual(camelCase("created_at"), "created_At")
    }

    func testCamelCaseKebabCase() {
        XCTAssertEqual(camelCase("my-component"), "myComponent")
    }

    func testCamelCaseSingleChar() {
        XCTAssertEqual(camelCase("x"), "x")
    }

    // MARK: - singularize

    func testSingularizePlural() {
        XCTAssertEqual(singularize("items"), "item")
        XCTAssertEqual(singularize("todos"), "todo")
    }

    func testSingularizeDoesNotStripSS() {
        XCTAssertEqual(singularize("class"), "class")
        XCTAssertEqual(singularize("address"), "address")
    }

    func testSingularizeSingular() {
        XCTAssertEqual(singularize("item"), "item")
    }

    // MARK: - swiftMethodName

    func testSwiftMethodNameDotted() {
        XCTAssertEqual(swiftMethodName("api.createTodo"), "createTodo")
    }

    func testSwiftMethodNameNoDot() {
        XCTAssertEqual(swiftMethodName("listItems"), "listItems")
    }

    // MARK: - safeTypeName

    func testSafeTypeNameReservedWithParent() {
        XCTAssertEqual(safeTypeName("State", parentName: "AuthState"), "AuthStateState")
        XCTAssertEqual(safeTypeName("Type", parentName: "AuthField"), "AuthFieldType")
        XCTAssertEqual(safeTypeName("Method", parentName: "AuthAction"), "AuthActionMethod")
    }

    func testSafeTypeNameReservedWithoutParent() {
        XCTAssertEqual(safeTypeName("State", parentName: nil), "StateValue")
        XCTAssertEqual(safeTypeName("Type", parentName: nil), "TypeValue")
        XCTAssertEqual(safeTypeName("Error", parentName: nil), "ErrorValue")
    }

    func testSafeTypeNameNotReserved() {
        XCTAssertEqual(safeTypeName("Todo", parentName: "Api"), "Todo")
        XCTAssertEqual(safeTypeName("Priority", parentName: nil), "Priority")
    }

    // MARK: - escapedSwiftName

    func testEscapedSwiftNameKeyword() {
        XCTAssertEqual(escapedSwiftName("type"), "`type`")
        XCTAssertEqual(escapedSwiftName("class"), "`class`")
        XCTAssertEqual(escapedSwiftName("default"), "`default`")
        XCTAssertEqual(escapedSwiftName("self"), "`self`")
    }

    func testEscapedSwiftNameNonKeyword() {
        XCTAssertEqual(escapedSwiftName("name"), "name")
        XCTAssertEqual(escapedSwiftName("title"), "title")
        XCTAssertEqual(escapedSwiftName("userId"), "userId")
    }

    func testEscapedSwiftNameNewKeywords() {
        XCTAssertEqual(escapedSwiftName("do"), "`do`")
        XCTAssertEqual(escapedSwiftName("internal"), "`internal`")
        XCTAssertEqual(escapedSwiftName("guard"), "`guard`")
        XCTAssertEqual(escapedSwiftName("defer"), "`defer`")
        XCTAssertEqual(escapedSwiftName("fallthrough"), "`fallthrough`")
        XCTAssertEqual(escapedSwiftName("Self"), "`Self`")
        XCTAssertEqual(escapedSwiftName("async"), "`async`")
        XCTAssertEqual(escapedSwiftName("await"), "`await`")
    }

    func testContextualModifiersNotEscaped() {
        XCTAssertEqual(escapedSwiftName("required"), "required")
        XCTAssertEqual(escapedSwiftName("final"), "final")
        XCTAssertEqual(escapedSwiftName("override"), "override")
        XCTAssertEqual(escapedSwiftName("lazy"), "lazy")
        XCTAssertEqual(escapedSwiftName("weak"), "weak")
        XCTAssertEqual(escapedSwiftName("convenience"), "convenience")
        XCTAssertEqual(escapedSwiftName("unowned"), "unowned")
        XCTAssertEqual(escapedSwiftName("open"), "open")
    }
}
