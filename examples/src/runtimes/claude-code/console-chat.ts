import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";

import { runRuntimeConsoleChat } from "../shared/console-runtime-chat.ts";

await runRuntimeConsoleChat({
  runtimeName: "Claude Code CLI",
  expertId: "claude-code-runtime-chat",
  createRuntime: (defaultModelName) =>
    createClaudeCodeRuntime({
      ...(defaultModelName === undefined ? {} : { defaultModelName }),
    }),
});
