import { parsePragmaYaml } from "@pragma/interpreter";
import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { createRuntimeTokenCounter } from "@pragma/core";
import { BUILT_IN_SKILLS, PRAGMA_MANAGEMENT_TOOL_DEFINITIONS } from "@pragma/built-in-agents";
import { MANAGEMENT_COMMAND_TOOLS, describeManagementCommand } from "@pragma/local-host/management";
import type { ManagementCommand } from "@pragma/shared/integration";

const counter = createRuntimeTokenCounter();
await counter.load();
const groups = new Set(["mission", "workspace", "home-project", "knowledge-store", "automation"]);
const commands = Object.keys(MANAGEMENT_COMMAND_TOOLS) as ManagementCommand[];
const names = new Set(
  commands
    .filter((command) => groups.has(command.split(".")[0]!))
    .map((command) => MANAGEMENT_COMMAND_TOOLS[command]),
);
const tools = PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.filter((tool) => names.has(tool.name)).map(
  (tool) => ({
    name: tool.name,
    schemaBytes: Buffer.byteLength(JSON.stringify(tool.inputSchema), "utf8"),
    definition: counter.countText(
      JSON.stringify(
        { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        null,
        2,
      ),
    ),
    approval: tool.approval,
  }),
);
const result = {
  serialization:
    "formatted JSON {name,description,parameters}; per-tool sum, excluding provider wrapping and output schemas",
  stage: 3,
  removedToolCount: tools.length,
  removedSchemaBytes: tools.reduce((sum, tool) => sum + tool.schemaBytes, 0),
  removedDefinitionTokens: tools.reduce((sum, tool) => sum + tool.definition.tokens, 0),
  tools,
  commandCount: commands.length,
  commands: commands.map((command) => ({
    command: `pragma manage ${command.replaceAll(".", " ")}`,
    helpSchema: counter.countText(
      JSON.stringify(describeManagementCommand(command).inputSchema, null, 2),
    ),
  })),
  skills: BUILT_IN_SKILLS.map((skill) => {
    const header = z
      .object({ name: z.string(), description: z.string() })
      .parse(parsePragmaYaml(skill.files["SKILL.md"]!.split("---")[1]!));
    return {
      name: header.name,
      displayName: skill.name,
      discoverySerialization: "frontmatter name and description, excluding Core index formatting",
      index: counter.countText(`${header.name}\n${header.description}`),
      body: counter.countText(skill.files["SKILL.md"]!),
      references: Object.entries(skill.files)
        .filter(([path]) => path.startsWith("references/"))
        .map(([path, content]) => ({ path, count: counter.countText(content) })),
    };
  }),
  caveat:
    "Static reference estimates only. Provider reported input, cache conditions and extra turns determine task cost.",
};
await writeFile(
  process.argv[2] ??
    "docs/architecture/management-tools-cli-skills-phase-three-token-estimate.json",
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    tools: tools.length,
    tokens: result.removedDefinitionTokens,
    commands: commands.length,
    skills: BUILT_IN_SKILLS.length,
  }),
);
counter.dispose();
