import { defineAgent } from "@pragma/core";

import { defaultWorkspaceRoot, ensureWorkspaceDir } from "./harness/paths.ts";

const workspace = `${defaultWorkspaceRoot}/memory-system-example`;

await ensureWorkspaceDir(workspace);

const defaultAgent = await defineAgent({
  id: "memory-default-agent",
  name: "Memory Default Agent",
  description: "Demonstrates the default memory system wiring.",
  tags: ["example", "memory"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
});

console.log("Default memory agent:");
console.log(`- workspace: ${workspace}`);
console.log(`- tools: ${formatTools(defaultAgent.tools?.map((tool) => tool.name) ?? [])}`);

const taskWrite = await callTool(defaultAgent, "append_task_memory", {
  visibility: "shared",
  kind: "note",
  content: "Current task: document the memory system.",
  status: "active",
  workflowRunId: "memory-demo-workflow",
});
console.log(`- append_task_memory: ${taskWrite.text}`);

const experienceWrite = await callTool(defaultAgent, "append_experience_memory", {
  scope: "workspace",
  kind: "tool",
  summary: "Searched docs and examples to map the current memory-related entry points.",
  content: "Searched docs and examples to map the current memory-related entry points.",
  status: "summarized",
  workflowRunId: "memory-demo-workflow",
  evidence: [{ type: "external", id: "repo-search-1", label: "repo search" }],
});
console.log(`- append_experience_memory: ${experienceWrite.text}`);

const factWrite = await callTool(defaultAgent, "write_fact_memory", {
  scope: "workspace",
  statement: "@pragma/core now defaults to loading task, experience, fact, and skill memory.",
  confidence: "verified",
  observedAt: new Date().toISOString(),
  evidence: [{ type: "external", id: "repo-search-2", label: "repo inspection" }],
});
console.log(`- write_fact_memory: ${factWrite.text}`);

const skillContext = await defaultAgent.addContext({
  namespace: "skill-memory",
  id: "skills/memory-boundaries.md",
  content: [
    "# Skill Card",
    "",
    "## Skill Scope",
    "Memory boundary classification",
    "",
    "## Recommended Fix Next Time",
    "Treat code search traces as experience and stable path claims as facts.",
  ].join("\n"),
});
console.log(`- skill-memory writable: ${skillContext.ok}`);
console.log("");

const selectiveAgent = await defineAgent({
  id: "memory-selective-agent",
  name: "Memory Selective Agent",
  description: "Disables experience and fact memory while keeping task and skill memory.",
  tags: ["example", "memory"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  memory: {
    experience: false,
    fact: false,
  },
});

console.log("Selective memory agent:");
console.log(`- tools: ${formatTools(selectiveAgent.tools?.map((tool) => tool.name) ?? [])}`);
console.log(
  `- has experience tools: ${hasTool(selectiveAgent, "append_experience_memory")}`,
);
console.log(`- has fact tools: ${hasTool(selectiveAgent, "write_fact_memory")}`);
console.log(`- has task tools: ${hasTool(selectiveAgent, "append_task_memory")}`);

async function callTool(
  agent: Awaited<ReturnType<typeof defineAgent>>,
  toolName: string,
  input: unknown,
): Promise<{ readonly text: string }> {
  const tool = agent.tools?.find((candidate) => candidate.name === toolName);

  if (tool === undefined) {
    throw new Error(`Tool not found: ${toolName}`);
  }

  const result = await tool.call(input, undefined, {
    runContext: {
      source: {
        type: "example",
        id: "memory-system-example",
      },
      attributes: {
        "execution.workflowRunId": "memory-demo-workflow",
      },
    },
  });

  return {
    text: result.text,
  };
}

function hasTool(
  agent: Awaited<ReturnType<typeof defineAgent>>,
  toolName: string,
): boolean {
  return agent.tools?.some((tool) => tool.name === toolName) ?? false;
}

function formatTools(toolNames: readonly string[]): string {
  return toolNames.length === 0 ? "(none)" : toolNames.join(", ");
}
