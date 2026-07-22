package com.aws.blocks.kotlin.e2e

import blocks.e2e.Api
import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.exceptions.ApiException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldHaveAtLeastSize
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotBeBlank
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.Test

class TodosE2ETest {

    private val api = createApi()
    private val suffix = Clock.System.now().toEpochMilliseconds().toString()
    private val username = "todouser_$suffix"
    private val password = "pass1234"

    @Test
    fun authGateRejectsUnauthenticated() = runTest {
        BlocksClient.clearCookies()

        shouldThrow<ApiException> { api.listTodos() }
        shouldThrow<ApiException> { api.createTodo("should-fail") }
    }

    @Test
    fun createAndGetTodo() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        val t = api.createTodo("first todo", 1.0)
        t.todoId.shouldNotBeBlank()
        t.title shouldBe "first todo"
        t.completed.shouldBeFalse()
        t.priority shouldBe 1.0

        val got = api.getTodo(t.todoId)
        got.shouldNotBeNull()
        got.title shouldBe "first todo"
    }

    @Test
    fun listTodos() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        api.createTodo("todo 1", 1.0)
        api.createTodo("todo 2", 3.0)
        api.createTodo("todo 3", 2.0)

        val all = api.listTodos()
        all.shouldHaveAtLeastSize(3)
    }

    @Test
    fun listTodosSortedByPriority() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        api.createTodo("low", 1.0)
        api.createTodo("high", 3.0)
        api.createTodo("mid", 2.0)

        val sorted = api.listTodos(Api.ListTodos.SortBy.Priority)
        val priorities = sorted.map { it.priority }
        priorities shouldBe priorities.sorted()
    }

    @Test
    fun updateTodo() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        val t = api.createTodo("to update", 2.0)
        val r = api.updateTodo(t.todoId, Api.UpdateTodo.Updates(completed = true, title = "updated"))
        r.success.shouldBeTrue()

        val got = api.getTodo(t.todoId)
        got.shouldNotBeNull()
        got.completed.shouldBeTrue()
        got.title shouldBe "updated"
    }

    @Test
    fun deleteTodo() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)

        val t = api.createTodo("to delete", 2.0)
        val r = api.deleteTodo(t.todoId)
        r.success.shouldBeTrue()

        val got = api.getTodo(t.todoId)
        got.shouldBeNull()
    }

    @Test
    fun isolationAfterSignOut() = runTest {
        api.basicSignUp(username, password)
        api.basicSignIn(username, password)
        api.createTodo("some todo", 1.0)
        api.basicSignOut()

        shouldThrow<ApiException> { api.listTodos() }
    }
}
