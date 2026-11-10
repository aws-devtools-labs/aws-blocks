package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksServer

public object Servers {
  public val main___val_x___1___: BlocksServer =
      BlocksServer(name = "main\"; val x = 1 //", url = "https://example.com")
}

public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.main___val_x___1___)

public val Blocks.Companion.defaultServer: BlocksServer
  get() = Servers.main___val_x___1___
