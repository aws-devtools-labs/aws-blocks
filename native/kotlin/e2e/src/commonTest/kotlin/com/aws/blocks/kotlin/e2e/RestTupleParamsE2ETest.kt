package com.aws.blocks.kotlin.e2e

import blocks.e2e.Api.EchoForwardedArgs
import blocks.e2e.Api.EchoTuples
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.test.runTest
import kotlin.test.Test

/**
 * Tuples on the wire, against the real server, which calls a method with its params spread
 * (`method(...params)`).
 *
 * A rest parameter typed as a tuple (`...args: [label: string, count?: number]`, or
 * `...args: Parameters<typeof describeKey>`) takes one positional param per element. The spec
 * used to describe it as one param holding the tuple, so the client sent `[["x", 2]]` and the
 * method's `args` was `[["x", 2]]`. A tuple is a JSON array: `["abc"]`, never `{"item0":"abc"}`.
 */
class RestTupleParamsE2ETest {

    private val api = createApi()

    @Test
    fun restTupleElementsArePositionalParams() = runTest {
        val both = api.echoRestArgs("x", 2.0)
        both.argCount shouldBe 2.0
        both.label shouldBe "x"
        both.count shouldBe 2.0
        val labelOnly = api.echoRestArgs("y")
        labelOnly.argCount shouldBe 1.0
        labelOnly.count.shouldBeNull()
    }

    @Test
    fun parametersOfAFunctionArePositionalParams() = runTest {
        val forwarded = api.echoForwardedArgs("k", EchoForwardedArgs.Options(tag = "t"))
        forwarded.argCount shouldBe 2.0
        forwarded.key shouldBe "k"
        forwarded.tag shouldBe "t"
    }

    @Test
    fun tuplesAreJsonArrays() = runTest {
        val tuples = api.echoTuples(EchoTuples.One("abc"))
        tuples.one shouldBe EchoTuples.Result.One(3.0)
        tuples.short shouldBe EchoTuples.Result.Short("abc", null)
        tuples.pair shouldBe EchoTuples.Result.Pair("abc", 3.0)
    }
}
