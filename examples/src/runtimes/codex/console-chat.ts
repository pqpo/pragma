import { createCodexRuntime } from "@pragma/runtime-codex";

import { runRuntimeConsoleChat } from "../shared/console-runtime-chat.ts";

await runRuntimeConsoleChat({
  runtimeName: "Codex CLI",
  expertId: "codex-runtime-chat",
  createRuntime: (defaultModelName) =>
    createCodexRuntime({
      ...(defaultModelName === undefined ? {} : { defaultModelName }),
    }),
});
