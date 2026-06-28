import {
  ExpertAgent,
  createConsoleLoggerProvider,
  createExpertAgentLogger,
} from "@expertmesh/core";

const loggerProvider = createConsoleLoggerProvider();

const workerAgent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
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
}).info("ExpertMesh Worker Ready");
