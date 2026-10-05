package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksServer

public object Servers {
  public val local: BlocksServer = BlocksServer(name = "local", url = "http://localhost:3001")
}

/**
 * Reaches the backend on [Servers.local], the first server the spec declares.
 *
 * Name another one with `Blocks(Servers.other)`.
 */
public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.local)
