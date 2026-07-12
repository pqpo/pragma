import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

import {
  ContextSystem,
  createExpertAgentLogger,
  createExpertToolsMcpServer,
  createInMemoryContextStore,
  createLoggerProvider,
  defineExpert,
} from "./packages/core/src/index.ts";

const cli =
  "C:\\Users\\Administrator\\AppData\\Local\\nvm\\v22.17.0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
const dir = await mkdtemp(join(tmpdir(), "pragma-claude-stream-probe-"));
const stamp = () => new Date().toISOString();
const logger = createExpertAgentLogger(
  createLoggerProvider((record) => {
    process.stderr.write(`[HOST ${record.timestamp}] ${record.message} ${JSON.stringify(record.context ?? {})}\n`);
  }),
  { component: "runtime-adapter", agentId: "raw-claude-probe" },
);
const expert = await defineExpert({
  id: "raw-claude-probe",
  name: "Raw Claude Probe",
  description: "Probe raw Claude CLI MCP stream event timing",
  instructions: "Use the context tool when explicitly requested.",
  tags: [],
  version: "1.0.0",
  scope: "probe",
  workspace: process.cwd(),
  contextSystem: new ContextSystem({
    store: createInMemoryContextStore({
      context: {
        "probe/item.md": "Probe marker: RAW-TOOL-RESULT-7319",
      },
    }),
  }),
});
const server = await createExpertToolsMcpServer({
  agent: expert,
  getContext: () => undefined,
  logger,
  state: {},
});
const mcpConfig = join(dir, "mcp.json");
await writeFile(
  mcpConfig,
  JSON.stringify({ mcpServers: { pragma: { type: "http", url: server.url } } }),
  "utf8",
);

const child = spawn(
  cli,
  [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--bare",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfig,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "deepseek-v4-pro",
  ],
  { cwd: process.cwd(), env: process.env },
);

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => {
  process.stderr.write(`[CLI-STDERR ${stamp()}] ${chunk}`);
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const readLines = (async () => {
  for await (const line of lines) {
    process.stdout.write(`[CLI-STDOUT ${stamp()}] ${line}\n`);
  }
})();

child.stdin.write(
  `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "text",
          text: "Call mcp__pragma__list_expert_context exactly once, then reply with only DONE.",
        },
      ],
    },
  })}\n`,
);

const timeout = setTimeout(() => child.kill("SIGKILL"), 90_000);
const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
await readLines;
process.stderr.write(`[CLI-EXIT ${stamp()}] ${JSON.stringify(exit)}\n`);
await server.dispose();
await rm(dir, { recursive: true, force: true });

