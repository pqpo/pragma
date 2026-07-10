import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContextSystem,
  ExpertAgent,
  FileSystemContextStore,
  HOST_CONTEXT_NAMESPACE,
} from "@pragma/core";
import type { ExpertAgentRunContext } from "@pragma/core";

type ExampleRole = "member" | "admin";

const workspace = await mkdtemp(join(tmpdir(), "pragma-context-authorization-"));
const contextDir = join(workspace, "context");

try {
  await seedContextFiles(contextDir);

  const store = new FileSystemContextStore({
    rootDir: contextDir,
    authorize: ({ operation, ids, context }) => {
      const role = readRole(context);
      const authorizedIds =
        role === "admin"
          ? ids
          : operation === "list" || operation === "read" || operation === "search"
            ? ids.filter((id) => id.startsWith("public/"))
            : [];

      console.log(
        `[authorize] role=${role} operation=${operation} ids=${JSON.stringify(ids)} allowed=${JSON.stringify(authorizedIds)}`,
      );

      return authorizedIds;
    },
  });
  const agent = await ExpertAgent.create({
    schemaVersion: "pragma.expert/v1",
    id: "context-authorization-example",
    name: "Context Authorization Example",
    description: "Demonstrates run-context-based authorization for Context Tools.",
    tags: ["example", "context", "authorization"],
    version: "0.0.0",
    scope: "local-test",
    workspace,
    contextSystem: new ContextSystem({ store }),
  });

  await runAs(agent, "member");
  await runAs(agent, "admin");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

async function runAs(agent: ExpertAgent, role: ExampleRole): Promise<void> {
  const runContext: ExpertAgentRunContext = {
    source: { type: "user", id: `${role}-user` },
    attributes: { role },
  };
  const tools = agent.createDefaultTools({ getContext: () => runContext });

  console.log(`\n=== ${role.toUpperCase()} ===`);
  await callTool(tools, "list_expert_context", {});
  await callTool(tools, "search_expert_context", {
    query: "Deployment",
    scope: "content",
  });
  await callTool(tools, "read_expert_context", {
    namespace: HOST_CONTEXT_NAMESPACE,
    id: "private/runbook.md",
  });
  await callTool(tools, "edit_expert_context", {
    namespace: HOST_CONTEXT_NAMESPACE,
    id: "public/guide.md",
    mode: "replace",
    content: `# Public guide\n\nUpdated by ${role}.`,
  });
}

async function callTool(
  tools: ReturnType<ExpertAgent["createDefaultTools"]>,
  name: string,
  args: unknown,
): Promise<void> {
  const tool = tools.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`Default tool is unavailable: ${name}`);
  }

  const result = await tool.call(args, undefined);
  console.log(`\n[tool] ${name} isError=${result.isError ?? false}`);
  console.log(result.text);
}

function readRole(context: ExpertAgentRunContext | undefined): ExampleRole | "anonymous" {
  const role = context?.attributes?.["role"];
  return role === "member" || role === "admin" ? role : "anonymous";
}

async function seedContextFiles(contextDir: string): Promise<void> {
  await mkdir(join(contextDir, "public"), { recursive: true });
  await mkdir(join(contextDir, "private"), { recursive: true });
  await writeFile(
    join(contextDir, "public", "guide.md"),
    "# Public guide\n\nDeployment documentation for every member.",
    "utf8",
  );
  await writeFile(
    join(contextDir, "private", "runbook.md"),
    "# Private runbook\n\nDeployment credentials and production recovery steps.",
    "utf8",
  );
}
