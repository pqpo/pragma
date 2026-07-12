import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";

import { runRuntimeConsoleChat } from "../shared/console-runtime-chat.ts";

await runRuntimeConsoleChat({
  runtimeName: "Claude Code CLI",
  expertId: "claude-code-runtime-chat",
  createRuntime: (defaults) =>
    createClaudeCodeRuntime({
      ...(defaults?.modelName === undefined ? {} : { defaultModelName: defaults.modelName }),
      ...(defaults?.thinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: defaults.thinkingLevel }),
    }),
});
