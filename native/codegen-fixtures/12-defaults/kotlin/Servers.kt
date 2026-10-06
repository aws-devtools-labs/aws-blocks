package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksServer

public object Servers {
  public val local: BlocksServer = BlocksServer(name = "local", url = "http://localhost:3001")
}

public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.local)
