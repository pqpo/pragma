import {
  ExpertAgent,
  createConsoleLoggerProvider,
  createExpertAgentLogger,
  createRuntimeRegistry,
  setDefaultRuntimeRegistryFactory,
} from "@pragma/core";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";

const loggerProvider = createConsoleLoggerProvider();

setDefaultRuntimeRegistryFactory(() =>
  createRuntimeRegistry({
    defaultRuntime: "pi",
    runtimes: [
      createPiRuntime({
        descriptor: {
          id: "pi",
          displayName: "PI Runtime",
        },
        loggerProvider,
      }),
      createCodexRuntime({
        descriptor: {
          id: "codex",
          displayName: "Codex Runtime",
        },
        loggerProvider,
      }),
    ],
  }),
);

const workerAgent = await ExpertAgent.create({
  schemaVersion: "pragma.expert/v1",
  id: "worker-orchestrator",
  name: "Worker Orchestrator",
  description: "ExpertAgent used by the worker entrypoint to initialize runtime context.",
  tags: ["worker", "orchestration"],
  version: "0.0.0",
  scope: "worker",
  workspace: ".",
  loggerProvider,
});

void workerAgent;

createExpertAgentLogger(loggerProvider, {
  component: "expert-agent",
  agentId: workerAgent.id,
  name: "worker",
}).info("Pragma Worker Ready");
