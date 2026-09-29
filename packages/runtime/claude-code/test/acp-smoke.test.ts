import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import {
  AcpRuntimeSession,
  RuntimeProcessSupervisor,
  type AcpRuntimeEvent,
  type RuntimeTurnContext,
} from "@pragma/core";
import { expect, it, vi } from "vitest";
import { resolveClaudeAcpWorkerPath } from "../src/acp-executable.ts";
import { resolveClaudeCodeExecutablePath } from "../src/executable.ts";

// Requires the user's authenticated Claude CLI. No network or native runtime in normal CI.
it.skipIf(process.env["PRAGMA_CLAUDE_ACP_SMOKE"] !== "1")(
  "loads a session written by the removed stream-json runtime through the bundled ACP worker",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pragma-acp-history-")));
    const workspace = join(root, "workspace");
    const config = join(root, "config");
    const nativeId = "719b0278-a54a-4da4-b30a-f3b9e664b7b2";
    await Promise.all([mkdir(workspace), mkdir(config)]);
    await copyFile(join(homedir(), ".claude/settings.json"), join(config, "settings.json")).catch(
      () => {},
    );
    const destination = join(
      config,
      "projects",
      workspace.replace(/[^a-zA-Z0-9]/gu, "-"),
      `${nativeId}.jsonl`,
    );
    await mkdir(dirname(destination), { recursive: true });
    const history = await readFile(
      new URL(`./fixtures/legacy-2.1.195/${nativeId}.jsonl`, import.meta.url),
      "utf8",
    );
    const historicalMessageIds = new Set(
      history
        .trim()
        .split("\n")
        .flatMap((line) => {
          const entry = JSON.parse(line) as { uuid?: string; message?: { id?: string } };
          return [entry.uuid, entry.message?.id].filter((id): id is string => id !== undefined);
        }),
    );
    await writeFile(
      destination,
      history.replaceAll("<LEGACY_ROOT>", root).replaceAll("<HOME>", homedir()),
    );
    const command = {
      executablePath: process.env["PRAGMA_CLAUDE_ACP_NODE"] ?? process.execPath,
      args: [resolveClaudeAcpWorkerPath(process.env["PRAGMA_CLAUDE_ACP_WORKER"])],
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_CODE_EXECUTABLE: resolveClaudeCodeExecutablePath(),
      },
    };
    const child = spawn(command.executablePath, command.args, {
      cwd: workspace,
      env: command.env,
      stdio: "pipe",
    });
    child.stderr.resume();
    // Initialized synchronously before notifications arrive.
    // eslint-disable-next-line prefer-const
    let session: AcpRuntimeSession;
    const connection = client()
      .onNotification(methods.client.session.update, ({ params }) =>
        session.update(params.sessionId, params.update),
      )
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    const supervisor = new RuntimeProcessSupervisor(child);
    void supervisor.exit.then(() => connection.close());
    session = new AcpRuntimeSession(connection, supervisor, {
      promptUsageScope: "turn",
      command,
      session: {
        cwd: workspace,
        mcpServers: [],
        _meta: {
          systemPrompt: { append: "When asked for SYSTEM_MARKER, report SYSTEM_PROMPT_6824." },
          claudeCode: {
            options: {
              settingSources: [],
              settings: join(config, "settings.json"),
              extraArgs: { bare: null, "strict-mcp-config": null },
            },
          },
        },
      },
    });
    try {
      await session.open(nativeId);
      expect(JSON.stringify(session.messages)).toContain("LEGACY_RECORDED_5083");
      const events: AcpRuntimeEvent[] = [];
      const prompt =
        "Reply with the LEGACY_MEMORY marker, the STARTUP marker, and the SYSTEM_MARKER from your instructions, each on a line.";
      const reported = vi.spyOn(session, "recordReportedUsage");
      const turn = {
        runId: "historical-resume",
        rawQuery: prompt,
        prompt,
        attempt: 1,
        isRetry: false,
        attachments: [],
        startupMessages: [
          { role: "user", content: "Remember: the STARTUP marker is STARTUP_CONTEXT_7246." },
        ],
        signal: new AbortController().signal,
        stream: {
          writeNative: (event: AcpRuntimeEvent) => {
            events.push(event);
          },
          write: () => {},
        },
      } as unknown as RuntimeTurnContext<AcpRuntimeEvent>;
      const result = await session.prompt(turn);
      expect(result.outputText).toContain("LEGACY_MEMORY_5083");
      expect(result.outputText).toContain("STARTUP_CONTEXT_7246");
      expect(result.outputText).toContain("SYSTEM_PROMPT_6824");
      expect(result.usage.measurement).toBe("reported");
      expect(result.usage.input).toBe(reported.mock.calls[0]?.[0].inputTokens);
      const next = await session.prompt({
        ...turn,
        startupMessages: [],
        runId: "historical-second-turn",
      });
      expect(next.outputText).toContain("LEGACY_MEMORY_5083");
      expect(next.outputText).toContain("STARTUP_CONTEXT_7246");
      expect(next.outputText).toContain("SYSTEM_PROMPT_6824");
      expect(next.usage.input).toBe(reported.mock.calls[1]?.[0].inputTokens);
      expect(next.usage.output).toBe(reported.mock.calls[1]?.[0].outputTokens);
      expect(next.usage.totalTokens).toBeGreaterThan(0);
      // New reasoning may mention historical text. Replay is identified by the
      // original message identity, not by a substring in newly generated content.
      for (const event of events) {
        if (event.update !== undefined && "messageId" in event.update)
          expect(historicalMessageIds.has(event.update.messageId as string)).toBe(false);
        expect(event.completedText).not.toBe("LEGACY_RECORDED_5083");
      }
    } finally {
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
