import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
} from "@pragma/core";
import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import type { MissionConversationSnapshot } from "../shared/contracts/index.ts";
import { applyMissionChatPatches } from "../renderer/src/pages/missions/mission-conversation-model.ts";
import { consumeLiveChatOutput, type LiveMissionChat } from "@pragma/local-host";
import {
  ensureTerminalExecutionResultEntry,
  finalizeHistoricalChatEntries,
  messageRecordsToChatEntries,
  mergeMissionChatEntriesWithLive,
} from "@pragma/local-host";

describe("Antigravity native stream through Core and Mission", () => {
  it.each([
    "aggregate",
    "repeated-final",
    "tool-last",
    "missing-result-tool-last",
    "recovered-tool-last",
    "normalized-recovery-tool-last",
    "textless-result-tool-last",
  ] as const)(
    "keeps live and durable messages identical (%s)",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-agy-projection-review-"));
      const workspace = join(root, "workspace");
      const pragmaHome = join(root, "pragma-home");
      await mkdir(workspace, { recursive: true });
      const before = "Before tool.\n";
      const multipleToolLast = scenario.endsWith("tool-last") && scenario !== "tool-last";
      const final =
        scenario === "repeated-final"
          ? before + "Final answer."
          : multipleToolLast
            ? "Between tools.\n"
            : "Final answer.";
      const missingResult = multipleToolLast && scenario !== "textless-result-tool-last";
      const recoverTranscript =
        scenario === "recovered-tool-last" || scenario === "normalized-recovery-tool-last";
      const conversationId = "11111111-2222-4333-8444-555555555551";
      const records = [
        { event: "init", conversation_id: conversationId },
        {
          event: "step_update",
          step_update: {
            step_index: 1,
            step_type: "agent_response",
            state: "DONE",
            text_delta: before,
            raw_thought: "Think before.",
          },
        },
        {
          event: "step_update",
          step_update: {
            step_index: 2,
            step_type: "tool",
            state: "DONE",
            tool_info: {
              name: "list_dir",
              parameters: { DirectoryPath: workspace },
              output: "empty",
            },
          },
        },
        ...(scenario === "tool-last"
          ? []
          : [
              {
                event: "step_update",
                step_update: {
                  step_index: 3,
                  step_type: "agent_response",
                  state: "DONE",
                  text_delta: final,
                  raw_thought: "Think after.",
                },
              },
            ]),
        ...(multipleToolLast
          ? [
              {
                event: "step_update",
                step_update: {
                  step_index: 4,
                  step_type: "tool",
                  state: "DONE",
                  tool_info: {
                    name: "list_dir",
                    parameters: { DirectoryPath: workspace },
                    output: "empty",
                  },
                },
              },
            ]
          : []),
        ...(missingResult
          ? []
          : [
              {
                event: "result",
                result: {
                  status: "SUCCESS",
                  ...(scenario === "textless-result-tool-last"
                    ? {}
                    : {
                        response:
                          scenario === "repeated-final"
                            ? final
                            : scenario === "tool-last"
                              ? before
                              : before + final,
                      }),
                },
              },
            ]),
      ];
      const runtime = createAntigravityRuntime({
        authenticationMode: "isolated-environment",
        env: { AGY_ADC_AUTH: "1" },
        canUse: () => ({ usable: true }),
        listModels: async () => [],
        spawn: (_command, _args, options) => {
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            kill: () => {
              queueMicrotask(() => {
                child.stdout.end();
                child.stderr.end();
                child.emit("exit", 0, null);
              });
              return true;
            },
          });
          child.stdin.once(
            "data",
            () =>
              void (async () => {
                if (recoverTranscript) {
                  const directory = join(
                    options.env["HOME"]!,
                    ".gemini",
                    "antigravity",
                    "brain",
                    conversationId,
                    ".system_generated",
                    "logs",
                  );
                  await mkdir(directory, { recursive: true });
                  await writeFile(
                    join(directory, "transcript.jsonl"),
                    [
                      { type: "USER_INPUT", content: "Run projection regression" },
                      ...[before, final].map((content) => ({
                        type: "PLANNER_RESPONSE",
                        source: "MODEL",
                        status: "DONE",
                        content:
                          scenario === "normalized-recovery-tool-last" ? content.trim() : content,
                      })),
                    ]
                      .map((record) => JSON.stringify(record))
                      .join("\n"),
                  );
                }
                child.stdout.write(
                  records.map((record) => JSON.stringify(record)).join("\n") + "\n",
                );
                if (missingResult) {
                  child.stdout.end();
                  child.stderr.end();
                  child.emit("exit", 0, null);
                }
              })(),
          );
          return child as unknown as ChildProcessWithoutNullStreams;
        },
      });
      const loggerProvider = createLoggerProvider({ handler: { write() {} } });
      const app = createPragma({
        pragmaHome,
        loggerProvider,
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
      });
      const expert = await defineExpert({
        id: "01h8z8e7m6p5t4r3",
        name: "Projection review",
        description: "Native stream regression",
        scope: "test",
        tags: [],
        workspace,
        pragmaHome,
        loggerProvider,
      });
      const session = await app.experts.createSession(expert);
      try {
        const turn = await session.prompt("Run projection regression");
        const chat: LiveMissionChat = {
          executionId: turn.executionId,
          entries: [],
          messageOrdinals: new Map(),
          close: async () => undefined,
        };
        const subscription = await turn.subscribeOutput({ scope: { kind: "root" } });
        let rendered: MissionConversationSnapshot = {
          missionId: "00000000-0000-4000-8000-000000000000",
          revision: 0,
          entries: [],
          page: {},
          pendingInteractions: [],
        };
        const consume = (async () => {
          for await (const item of subscription) {
            const applied = applyMissionChatPatches(
              rendered,
              consumeLiveChatOutput(chat, item),
              rendered.revision + 1,
            );
            expect(applied).not.toBeNull();
            rendered = applied!;
          }
        })();
        const result = await turn.result;
        expect(result).toBe(scenario === "tool-last" ? before : final);
        await consume;
        await subscription.close();
        const state = await turn.getState();
        const history = messageRecordsToChatEntries(
          (await turn.getMessageHistory({ scope: { kind: "root" } })).flatMap(
            (invocation) => invocation.messages,
          ),
        );
        const durable = finalizeHistoricalChatEntries(
          ensureTerminalExecutionResultEntry(history, state, String(result)),
          true,
          state.rootInvocationId,
        );
        const summarize = (entries: typeof history) =>
          entries.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            ...(entry.kind === "assistant" || entry.kind === "thinking"
              ? { content: entry.content, streaming: entry.streaming }
              : {}),
            ...(entry.kind === "assistant" ? { finalAnswer: entry.finalAnswer } : {}),
          }));
        expect(summarize(chat.entries)).toEqual(summarize(durable));
        expect(summarize(rendered.entries)).toEqual(summarize(durable));
        expect(summarize(mergeMissionChatEntriesWithLive(durable, chat.entries))).toEqual(
          summarize(durable),
        );
        expect(
          durable.filter((entry) => entry.kind === "assistant").map((entry) => entry.content),
        ).toEqual(scenario === "tool-last" ? [before] : [before, final]);
      } finally {
        await session.close("Projection review completed");
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
