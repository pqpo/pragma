`episodic-data-v6.sqlite` was written by `createEpisodicMemoryStore` at commit
`f14214e8d2bf7ffc2cfe56da0f4143708d084638` before these review fixes. That writer
opened the synthetic v5 fixture, performed its own upgrade, and called
`tightenAccess` with unchanged bindings to produce a v6 notification. The store
was closed before copying. No version numbers were rewritten.
