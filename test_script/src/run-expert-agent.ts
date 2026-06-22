import { ExpertAgent } from "@expertmesh/agent-core";

import { ExpertAgentTestHarness } from "./testing/expert-agent-test-harness.ts";
import { loadTestScriptEnv, readCliQuery, workspaceRoot } from "./testing/paths.ts";

const defaultQuery = "用一句话介绍 ExpertMesh 的 Phase 0 Harness 是什么。";

loadTestScriptEnv();

const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "test-script-expert",
  displayName: "Test Script Expert",
  description: "A minimal ExpertAgent instance used by the test_script example.",
  tags: ["test-script"],
  version: "0.0.0",
  scope: "local-test",
  workspace: workspaceRoot,
});

await new ExpertAgentTestHarness({
  agent,
  defaultQuery,
  query: readCliQuery(defaultQuery),
}).run();
