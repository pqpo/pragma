import {
  AGENTS_DOCUMENT_ID,
  ExpertAgent,
  createInMemoryDocumentStore,
} from "@expertmesh/agent-core";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ExpertAgentTestHarness } from "./testing/expert-agent-test-harness.ts";
import { loadTestScriptEnv, readCliQuery, workspaceRoot } from "./testing/paths.ts";

const defaultQuery = [
  "测试 ExpertMesh workspace + document 能力：",
  "1. 先基于 always-on AGENTS.md 说明本仓库最重要的边界约束。",
  "2. 再使用 document 工具查找 workspace-overview.md，确认 Phase 0 的当前入口。",
  "3. 最后结合 workspace 中的 package.json 或 test_script/package.json，给出后续测试脚本应该如何运行。",
].join("\n");

loadTestScriptEnv();

const agentsDocument = await readFile(resolve(workspaceRoot, AGENTS_DOCUMENT_ID), "utf8");
const documentStore = createInMemoryDocumentStore({
  documents: {
    [AGENTS_DOCUMENT_ID]: agentsDocument,
    "workspace-overview.md": [
      "---",
      "description: ExpertMesh Phase 0 workspace overview for runtime document retrieval tests.",
      "trigger: model_decision",
      "trustLevel: workspace",
      "sensitivity: internal",
      "---",
      "",
      "# ExpertMesh Workspace Overview",
      "",
      "ExpertMesh is currently in Phase 0 Harness.",
      "The active app entry points are apps/web, apps/server, and apps/worker.",
      "The test_script workspace package is used for manual runtime smoke tests.",
      "Agent documents should be exposed through the ExpertAgent document store.",
      "Cross-package code must use @expertmesh/* package imports instead of relative paths.",
    ].join("\n"),
  },
});

const agent = new ExpertAgent({
  schemaVersion: "expertmesh.expert/v1",
  id: "workspace-document-test-expert",
  displayName: "Workspace Document Test Expert",
  description:
    "A test ExpertAgent that exercises workspace access, always-on AGENTS.md context, and memory-backed document tools.",
  tags: ["test-script", "workspace", "documents"],
  version: "0.0.0",
  scope: "local-test",
  workspace: workspaceRoot,
  documents: documentStore,
});

await new ExpertAgentTestHarness({
  agent,
  defaultQuery,
  query: readCliQuery(defaultQuery),
  inspectContext: true,
}).run();
