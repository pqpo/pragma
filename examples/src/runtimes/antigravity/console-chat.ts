import { createAntigravityRuntime } from "@pragma/runtime-antigravity";

import { runRuntimeConsoleChat } from "../shared/console-runtime-chat.ts";

await runRuntimeConsoleChat({
  runtimeName: "Antigravity CLI",
  expertId: "antigravity-runtime-chat",
  createRuntime: (defaults) =>
    createAntigravityRuntime({
      ...(defaults?.modelName === undefined ? {} : { defaultModelName: defaults.modelName }),
      ...(defaults?.thinkingLevel === undefined
        ? {}
        : { defaultThinkingLevel: defaults.thinkingLevel }),
    }),
});
