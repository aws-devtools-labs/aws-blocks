package com.example.app.roundtrip

import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api.GetEvent
import com.example.app.Status
import com.example.app.Task
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * Fixture 43: every enum a result reaches is open. A value the client was generated without
 * decodes to `Unknown` holding the string, and encodes back as that string.
 */
class OpenEnumsRoundTripTest : FunSpec({

    fun label(status: Status): String = when (status) {
        Status.Todo -> "todo"
        Status.InProgress -> "in progress"
        Status.Done -> "done"
        is Status.Unknown -> "unknown ${status.value}"
    }

    test("unknown values in a field, a list, a map and an optional decode and round-trip") {
        val wire = json(
            """{"id":"t1","status":"archived","history":["todo","in-progress","blocked"],""" +
                """"labels":{"a":"red","b":"purple"},"priority":"urgent","source":"unknown"}""",
        )
        val task = BlocksJson.decodeFromJsonElement(Task.serializer(), wire)
        task.status shouldBe Status.Unknown("archived")
        label(task.status) shouldBe "unknown archived"
        task.history shouldBe listOf(Status.Todo, Status.InProgress, Status.Unknown("blocked"))
        task.labels["b"] shouldBe Task.Labels.Unknown("purple")
        task.priority shouldBe Task.Priority.Unknown("urgent")
        task.source shouldBe Task.Source.Unknown
        BlocksJson.encodeToJsonElement(Task.serializer(), task) shouldBe wire
    }

    test("known values decode to their cases") {
        Status.fromValue("in-progress") shouldBe Status.InProgress
        Status.entries shouldBe listOf(Status.Todo, Status.InProgress, Status.Done)
        BlocksJson.encodeToJsonElement(Status.Serializer, Status.Done) shouldBe json("\"done\"")
    }

    test("an unknown value in a union arm's field decodes") {
        val event = BlocksJson.decodeFromJsonElement(
            GetEvent.Result.serializer(),
            json("""{"kind":"flagged","severity":"critical"}"""),
        )
        event shouldBe GetEvent.Result.Flagged(GetEvent.Result.Flagged.Severity.Unknown("critical"))
    }
})
