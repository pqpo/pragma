import { ExpertAgent } from "@expertmesh/agent-core";

const placeholderAgent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "phase-0-placeholder",
  displayName: "Phase 0 Placeholder",
  description: "Placeholder ExpertAgent for the Phase 0 worker entrypoint.",
  tags: ["phase-0"],
  version: "0.0.0",
  scope: "phase-0",
  workspace: "."
});

void placeholderAgent;

console.log("ExpertMesh Worker Ready");
