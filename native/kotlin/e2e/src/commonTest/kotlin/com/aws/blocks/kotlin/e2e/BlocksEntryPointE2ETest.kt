package com.aws.blocks.kotlin.e2e

import blocks.e2e.invoke
import com.aws.blocks.kotlin.Blocks
import io.kotest.matchers.shouldNotBe
import kotlin.test.Test

/**
 * Compiles and runs the generated zero-argument accessor, which the rest of the suite does not:
 * every other case builds a `Blocks` from `BLOCKS_URL`. No request is made, so the server the
 * CI spec happens to declare does not matter.
 */
class BlocksEntryPointE2ETest {

    @Test
    fun zeroArgumentEntryPointResolves() {
        Blocks().use { blocks ->
            blocks.client() shouldNotBe null
        }
    }
}
