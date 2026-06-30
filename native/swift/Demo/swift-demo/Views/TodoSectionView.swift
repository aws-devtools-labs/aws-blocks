//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import SwiftUI

struct TodoSectionView: View {
    @EnvironmentObject var appState: AppState

    @State private var todos: [Todo] = []
    @State private var newTitle = ""
    @State private var newPriority: Int = 2
    @State private var sortBy: Api.ListTodos.SortBy?
    @State private var error: String?
    @State private var isLoading = false

    var body: some View {
        List {
            if !appState.isSignedIn {
                Section {
                    Text("Please sign in to view todos")
                        .foregroundStyle(.secondary)
                }
            } else {
                // Add todo
                Section {
                    HStack {
                        TextField("New todo...", text: $newTitle)
                            .onSubmit { Task { await addTodo() } }

                        Picker("Priority", selection: $newPriority) {
                            Text("🔴 High").tag(1)
                            Text("🟡 Medium").tag(2)
                            Text("🟢 Low").tag(3)
                        }
                        .labelsHidden()
                        .pickerStyle(.menu)

                        Button {
                            Task { await addTodo() }
                        } label: {
                            Image(systemName: "plus.circle.fill")
                                .font(.title2)
                        }
                        .disabled(newTitle.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }

                // Sort
                Section {
                    Picker("Sort by", selection: $sortBy) {
                        Text("Todo ID").tag(Api.ListTodos.SortBy?.none)
                        Text("Created").tag(Api.ListTodos.SortBy?.some(.createdAt))
                        Text("Priority").tag(Api.ListTodos.SortBy?.some(.priority))
                        Text("Title").tag(Api.ListTodos.SortBy?.some(.title))
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: sortBy) { _ in
                        Task { await refreshTodos() }
                    }
                }

                // Error
                if let error {
                    Section {
                        Text(error)
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                // Todo list
                Section {
                    if isLoading {
                        ProgressView()
                            .frame(maxWidth: .infinity)
                    } else if todos.isEmpty {
                        Text("No todos yet. Add one above!")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(todos, id: \.todoId) { todo in
                            TodoRowView(
                                todo: todo,
                                onToggle: { completed in await toggleTodo(todo.todoId, completed: completed) },
                                onUpdateTitle: { title in await updateTitle(todo.todoId, title: title) },
                                onChangePriority: { priority in await changePriority(todo.todoId, priority: priority) },
                                onDelete: { await deleteTodo(todo.todoId) }
                            )
                        }
                    }
                }
            }
        }
        .task {
            if appState.isSignedIn {
                await refreshTodos()
            }
        }
        .onChange(of: appState.isSignedIn) { signedIn in
            if signedIn {
                Task { await refreshTodos() }
            } else {
                todos = []
            }
        }
    }

    // MARK: - Actions

    private func refreshTodos() async {
        isLoading = true
        defer { isLoading = false }
        error = nil
        do {
            todos = try await appState.api.listTodos(sortBy: sortBy)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func addTodo() async {
        let title = newTitle.trimmingCharacters(in: .whitespaces)
        guard !title.isEmpty else { return }
        error = nil
        do {
            _ = try await appState.api.createTodo(title: title, priority: Double(newPriority))
            newTitle = ""
            await refreshTodos()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func toggleTodo(_ todoId: String, completed: Bool) async {
        error = nil
        do {
            _ = try await appState.api.updateTodo(
                todoId: todoId,
                updates: Api.UpdateTodo.Updates(completed: completed, priority: nil, title: nil)
            )
            await refreshTodos()
        } catch {
            self.error = error.localizedDescription
            await refreshTodos()
        }
    }

    private func updateTitle(_ todoId: String, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else {
            await refreshTodos()
            return
        }
        error = nil
        do {
            _ = try await appState.api.updateTodo(
                todoId: todoId,
                updates: Api.UpdateTodo.Updates(completed: nil, priority: nil, title: trimmed)
            )
            await refreshTodos()
        } catch {
            self.error = error.localizedDescription
            await refreshTodos()
        }
    }

    private func changePriority(_ todoId: String, priority: Int) async {
        error = nil
        do {
            _ = try await appState.api.updateTodo(
                todoId: todoId,
                updates: Api.UpdateTodo.Updates(completed: nil, priority: Double(priority), title: nil)
            )
            await refreshTodos()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func deleteTodo(_ todoId: String) async {
        error = nil
        do {
            _ = try await appState.api.deleteTodo(todoId: todoId)
            await refreshTodos()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: - Todo Row

struct TodoRowView: View {
    let todo: Todo
    let onToggle: (Bool) async -> Void
    let onUpdateTitle: (String) async -> Void
    let onChangePriority: (Int) async -> Void
    let onDelete: () async -> Void

    @State private var editingTitle: String = ""
    @State private var isEditing = false

    private var priorityInt: Int {
        Int(todo.priority)
    }

    var body: some View {
        HStack(spacing: 10) {
            // Checkbox
            Button {
                Task { await onToggle(!todo.completed) }
            } label: {
                Image(systemName: todo.completed ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(todo.completed ? .green : .secondary)
                    .font(.title3)
            }
            .buttonStyle(.plain)

            // Title (tap to edit)
            if isEditing {
                TextField("Title", text: $editingTitle, onCommit: {
                    isEditing = false
                    Task { await onUpdateTitle(editingTitle) }
                })
                .textFieldStyle(.roundedBorder)
            } else {
                Text(todo.title)
                    .strikethrough(todo.completed)
                    .foregroundStyle(todo.completed ? .secondary : .primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        editingTitle = todo.title
                        isEditing = true
                    }
            }

            // Priority picker
            Picker("Priority", selection: Binding(
                get: { priorityInt },
                set: { newVal in Task { await onChangePriority(newVal) } }
            )) {
                Text("🔴").tag(1)
                Text("🟡").tag(2)
                Text("🟢").tag(3)
            }
            .labelsHidden()
            .pickerStyle(.menu)

            // Delete
            Button(role: .destructive) {
                Task { await onDelete() }
            } label: {
                Image(systemName: "trash")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
        }
    }
}
