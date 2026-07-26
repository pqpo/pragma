import { defineExpert, createConsoleLoggerProvider, createPragmaLogger } from "@pragma/core";

const loggerProvider = createConsoleLoggerProvider();

const workerAgent = await defineExpert({
  schemaVersion: "pragma.expert/v1",
  id: "worker-orchestrator",
  name: "Worker Orchestrator",
  description: "Expert used by the worker entrypoint to initialize runtime context.",
  tags: ["worker", "orchestration"],
  scope: "worker",
  workspace: ".",
  loggerProvider,
});

void workerAgent;

createPragmaLogger(loggerProvider, {
  component: "worker.main",
  scope: { agentId: workerAgent.id, processKind: "worker" },
}).info("worker.ready", "Pragma Worker Ready");
