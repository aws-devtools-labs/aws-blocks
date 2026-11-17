package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksServer

public object Servers {
  public val mainValX1: BlocksServer =
      BlocksServer(name = "main\"; val x = 1 //", url = "https://example.com")
}

public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.mainValX1)

public val Blocks.Companion.defaultServer: BlocksServer
  get() = Servers.mainValX1
