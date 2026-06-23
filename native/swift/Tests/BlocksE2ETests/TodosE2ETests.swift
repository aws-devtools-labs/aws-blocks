//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class TodosE2ETests: BlocksE2ETestCase {

    private let password = "pass1234"
    private lazy var username = "todouser_swift_\(Int(Date().timeIntervalSince1970))_\(Int.random(in: 1_000 ... 9_999))"

    private func signIn() async throws {

        _ = try await api.basicSignUp(username: username, password: password)
        _ = try await api.basicSignIn(username: username, password: password)
    }

    func testAuthGateRejectsUnauthenticated() async throws {
        let freshApi = Api(server: Self.server)
        do {
            _ = try await freshApi.listTodos(sortBy: nil)
            XCTFail("Expected auth error")
        } catch {
            // Expected
        }
    }

    func testCreateAndList() async throws {
        try await signIn()

        let firstTodo = try await api.createTodo(title: "first todo", priority: 1)
        XCTAssertFalse(firstTodo.todoId.isEmpty)
        XCTAssertEqual(firstTodo.title, "first todo")
        XCTAssertEqual(firstTodo.completed, false)
        XCTAssertEqual(firstTodo.priority, 1)

        let todos = try await api.listTodos(sortBy: nil)
        XCTAssertGreaterThanOrEqual(todos.count, 1)
    }

    func testGetTodo() async throws {
        try await signIn()

        let todo = try await api.createTodo(title: "get me")
        let fetched = try await api.getTodo(todoId: todo.todoId)
        XCTAssertEqual(fetched?.title, "get me")
    }

    func testListSortedByPriority() async throws {
        try await signIn()

        _ = try await api.createTodo(title: "low", priority: 3)
        _ = try await api.createTodo(title: "high", priority: 1)
        _ = try await api.createTodo(title: "mid", priority: 2)

        let byPriority = try await api.listTodos(sortBy: .priority)
        XCTAssertGreaterThanOrEqual(byPriority.count, 3)
        for idx in 0 ..< (byPriority.count - 1) {
            XCTAssertLessThanOrEqual(byPriority[idx].priority, byPriority[idx + 1].priority)
        }
    }

    func testUpdate() async throws {
        try await signIn()

        let todo = try await api.createTodo(title: "update me")
        _ = try await api.updateTodo(todoId: todo.todoId, updates: .init(completed: true, priority: nil, title: "updated"))

        let fetched = try await api.getTodo(todoId: todo.todoId)
        XCTAssertEqual(fetched?.completed, true)
        XCTAssertEqual(fetched?.title, "updated")
    }

    func testDelete() async throws {
        try await signIn()

        let todo = try await api.createTodo(title: "delete me")
        _ = try await api.deleteTodo(todoId: todo.todoId)

        let fetched = try await api.getTodo(todoId: t.todoId)
        XCTAssertNil(fetched)
    }

    func testIsolationAfterSignOut() async throws {
        try await signIn()
        _ = try await api.createTodo(title: "before signout")
        _ = try await api.basicSignOut()

        do {
            _ = try await api.listTodos(sortBy: nil)
            XCTFail("Expected auth error after sign out")
        } catch {
            // Expected
        }
    }
}
