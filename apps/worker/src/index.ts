import {
  ExpertAgent,
  createConsoleLoggerProvider,
  createExpertAgentLogger,
} from "@expertmesh/agent-core";

const loggerProvider = createConsoleLoggerProvider();

const placeholderAgent = await ExpertAgent.create({
  schemaVersion: "expertmesh.expert/v1",
  id: "phase-0-placeholder",
  displayName: "Phase 0 Placeholder",
  description: "Placeholder ExpertAgent for the Phase 0 worker entrypoint.",
  tags: ["phase-0"],
  version: "0.0.0",
  scope: "phase-0",
  workspace: ".",
  loggerProvider,
});

void placeholderAgent;

createExpertAgentLogger(loggerProvider, {
  component: "expert-agent",
  agentId: placeholderAgent.id,
  name: "worker",
}).info("ExpertMesh Worker Ready");
