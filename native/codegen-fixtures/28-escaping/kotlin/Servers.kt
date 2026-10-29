package com.example.app

import com.aws.blocks.kotlin.Blocks
import com.aws.blocks.kotlin.BlocksServer

public object Servers {
  public val primary: BlocksServer =
      BlocksServer(name = "primary", url = "https://example.com/a'b${'$'}c${'$'}{x}\"d\\e")
}

public operator fun Blocks.Companion.invoke(): Blocks = Blocks(Servers.primary)
