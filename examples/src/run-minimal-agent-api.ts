import { z } from "zod";
import { createRuntimeRegistry, defineAgent } from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

import { printRunResult } from "./harness/expert-agent-example-utils.ts";
import {
  createExpertAgentModelsConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { readBasicExampleCli } from "./harness/cli.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";
import { StreamEventPrinter } from "./harness/stream-output.ts";

const defaultQuery = "实现一个最小的 README 更新，并返回修改摘要。";

loadExamplesEnv();

const cli = readBasicExampleCli(defaultQuery);
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const coder = await defineAgent({
  id: "minimal-coder-example",
  name: "Minimal Coder Example",
  description: "A minimal agent declared through defineAgent().",
  tags: ["example", "coding"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models: createExpertAgentModelsConfig(modelConfig),
  instructions: `
你是一个资深 Coding Agent。
根据任务修改代码，并确保测试通过。
`,
});

const output = z.object({
  summary: z.string(),
  changedFiles: z.array(z.string()),
  testsPassed: z.boolean(),
});
const runtime = createPiRuntime({
  descriptor: {
    id: "pi",
    displayName: "PI Runtime",
  },
});

await exitIfRuntimeUnavailable(runtime);

const session = await coder.createSession({
  runtimes: createRuntimeRegistry({
    defaultRuntime: "pi",
    runtimes: [runtime],
  }),
});

try {
  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    const streamPrinter = new StreamEventPrinter();
    const handle = session.submit({
      query,
      output,
    });
    const events = (async () => {
      for await (const event of handle.events) {
        streamPrinter.print(event);
      }
    })();
    const result = await handle.result;
    await events;
    streamPrinter.finish();

    printRunResult(`turn-${index + 1}`);
    console.log(JSON.stringify(result.result.output, null, 2));
    console.log("");
  }
} finally {
  await session.abort();
}
