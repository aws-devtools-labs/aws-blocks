package com.example.app.roundtrip

import com.aws.blocks.kotlin.json.BlocksJson
import com.example.app.Api.GetEvent
import com.example.app.Kind
import com.example.app.Labels
import com.example.app.Status
import com.example.app.Task
import io.kotest.core.spec.style.FunSpec
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

/**
 * Fixture 45: every enum a result reaches is open. A value the client was generated without
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

    test("a value named companion is a case of its own beside the named companion object") {
        Task.Phase.fromValue("companion") shouldBe Task.Phase.Companion
        Task.Phase.Known.entries shouldBe listOf(Task.Phase.Companion, Task.Phase.Other)
        BlocksJson.encodeToJsonElement(Task.Phase.Serializer, Task.Phase.Companion) shouldBe json("\"companion\"")
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

    test("constants named like their enum or differing only in case are distinct cases") {
        // Every case is referenced, so each nested class has to load: on a case-insensitive file
        // system two class names that differ only in case would overwrite one another.
        Kind.fromValue("kind") shouldBe Kind.KindValue
        Kind.entries shouldBe listOf(Kind.KindValue, Kind.Other)
        Labels.Spelling.entries shouldBe listOf(Labels.Spelling.Unknown, Labels.Spelling.UnKnown2)
        Labels.Spelling.fromValue("un-known") shouldBe Labels.Spelling.UnKnown2
        Labels.Spelling.fromValue("x") shouldBe Labels.Spelling.UnknownValue("x")
        Labels.Case.entries.map { it.value } shouldBe listOf("foo-bar", "foo_bar", "fooBar", "FOO_BAR", "foo bar")
        Labels.Case.entries shouldBe
            listOf(Labels.Case.FooBar, Labels.Case.FooBar2, Labels.Case.FooBar3, Labels.Case.FooBar4, Labels.Case.FooBar5)
        Labels.Fallback.entries shouldBe
            listOf(Labels.Fallback.Unknown, Labels.Fallback.UnknownValue, Labels.Fallback.UnknownValue2)
        Labels.Fallback.fromValue("x") shouldBe Labels.Fallback.UnknownValue3("x")

        val wire = json(
            """{"kind":"kind","spelling":"un-known","case":"FOO_BAR","fallback":"unknownValue","maybe":null}""",
        )
        val labels = BlocksJson.decodeFromJsonElement(Labels.serializer(), wire)
        labels.kind shouldBe Kind.KindValue
        labels.`case` shouldBe Labels.Case.FooBar4
        labels.maybe shouldBe null
        BlocksJson.decodeFromJsonElement(Labels.serializer(), json("""{"kind":"kind","spelling":"unknown",""" +
            """"case":"foo bar","fallback":"unknown","maybe":"perhaps"}""")).maybe shouldBe Labels.Maybe.Unknown("perhaps")
    }
})
