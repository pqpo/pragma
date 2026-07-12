import { createCodexRuntime } from "@pragma/runtime-codex";

import { runRuntimeConsoleChat } from "../shared/console-runtime-chat.ts";

await runRuntimeConsoleChat({
  runtimeName: "Codex CLI",
  expertId: "codex-runtime-chat",
  createRuntime: (defaults) =>
    createCodexRuntime({
      ...(defaults?.modelName === undefined ? {} : { defaultModelName: defaults.modelName }),
      ...(defaults?.thinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: defaults.thinkingLevel }),
    }),
});
