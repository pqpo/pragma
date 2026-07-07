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

const skillContext = await defaultAgent.addContext({
  namespace: "memory",
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
console.log(`- memory namespace writable for skill cards: ${skillContext.ok}`);

const summary = await defaultAgent.readContext({
  namespace: "memory",
  id: "summary.md",
});
console.log(`- summary readable: ${summary.ok}`);
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
console.log(`- has task tools: ${hasTool(selectiveAgent, "append_task_memory")}`);
console.log(`- has experience tools: ${hasTool(selectiveAgent, "append_experience_memory")}`);
console.log(`- has fact tools: ${hasTool(selectiveAgent, "write_fact_memory")}`);

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
