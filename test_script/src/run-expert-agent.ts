import { ExpertAgent } from "@expertmesh/agent-core";
import type { ExpertAgentModelApi } from "@expertmesh/agent-core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/agent-runtime";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_API_VALUES = new Set<ExpertAgentModelApi>([
  "anthropic-messages",
  "google-generative-ai",
  "openai-completions",
  "openai-responses",
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const testScriptDir = resolve(scriptDir, "..");
const workspace = resolve(testScriptDir, "..");

loadEnv({
  path: resolve(testScriptDir, ".env"),
  quiet: true,
});

const provider = process.env.EXPERTMESH_MODEL_PROVIDER ?? "openai";
const modelName = process.env.EXPERTMESH_MODEL_NAME ?? "gpt-4o-mini";
const baseApi = process.env.EXPERTMESH_MODEL_BASE_API ?? "https://api.openai.com/v1";
const key = process.env.EXPERTMESH_MODEL_API_KEY ?? process.env.OPENAI_API_KEY;
const api = readModelApi(process.env.EXPERTMESH_MODEL_API ?? "openai-responses");
const query =
  process.argv.slice(2).join(" ").trim() ||
  "用一句话介绍 ExpertMesh 的 Phase 0 Harness 是什么。";

if (key === undefined || key.trim().length === 0) {
  throw new Error(
    "Missing model key. Set EXPERTMESH_MODEL_API_KEY or OPENAI_API_KEY before running this script.",
  );
}

const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "test-script-expert",
  displayName: "Test Script Expert",
  description: "A minimal ExpertAgent instance used by the test_script example.",
  tags: ["test-script"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models: {
    defaultModelName: `${provider}/${modelName}`,
    providers: [
      {
        provider,
        modelNames: [modelName],
        baseApi,
        key,
        api,
      },
    ],
  },
});

const runtime = createCloudPiRuntimeAdapter<string>();
const session = await runtime.createSession({ agent });

try {
  console.log(`Running ${agent.displayName} with ${provider}/${modelName}`);
  console.log(`Task: ${query}`);
  console.log("");

  const result = await session.submit({
    query,
    onEvent(event) {
      if (event.type === "message.delta") {
        process.stdout.write(event.payload.delta);
      }
    },
  });

  console.log("");
  console.log("");
  console.log(`Run ID: ${result.runId}`);
} finally {
  await session.abort();
}

function readModelApi(value: string): ExpertAgentModelApi {
  if (MODEL_API_VALUES.has(value as ExpertAgentModelApi)) {
    return value as ExpertAgentModelApi;
  }

  throw new Error(
    `Unsupported EXPERTMESH_MODEL_API "${value}". Expected one of: ${[...MODEL_API_VALUES].join(
      ", ",
    )}.`,
  );
}
