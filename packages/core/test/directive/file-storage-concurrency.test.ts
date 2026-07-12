import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MailboxMessage } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createFileStateManager } from "../../src/directive/file-state-manager.ts";
import { createFileRunEventStore } from "../../src/directive/run-event-store.ts";

describe("file Workflow storage concurrency", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("serializes event cursors across independent store instances", async () => {
    const pragmaHome = await createTempHome();
    const first = createFileRunEventStore({ pragmaHome });
    const second = createFileRunEventStore({ pragmaHome });
    const rootWorkflowRunId = "workflow-concurrent-events";

    await Promise.all([
      first.append(createMessage("message-1", rootWorkflowRunId), rootWorkflowRunId),
      second.append(createMessage("message-2", rootWorkflowRunId), rootWorkflowRunId),
    ]);

    const events = await first.readAfter({ rootWorkflowRunId, sequence: 0 });
    expect(events.map((event) => event.cursor.sequence)).toEqual([1, 2]);
    expect(new Set(events.map((event) => event.id))).toEqual(
      new Set(["message-1", "message-2"]),
    );
  });

  it("makes concurrent Human responses first-writer-wins and durable", async () => {
    const pragmaHome = await createTempHome();
    const first = createFileStateManager({ pragmaHome });
    const second = createFileStateManager({ pragmaHome });
    await first.createWorkflowRun({
      id: "workflow-concurrent-human",
      directiveId: "human-root",
      directiveVersion: "1.0.0",
      input: {},
      state: {
        input: {},
        context: {},
        artifacts: {},
        results: {},
        flags: {},
        messages: [],
        metrics: {},
        private: {},
      },
      startStepId: "approval",
      defaultSandbox: { id: "sandbox", kind: "test", workspaceRoot: pragmaHome },
    });
    const interaction = await first.createHumanInteraction({
      workflowRunId: "workflow-concurrent-human",
      request: { kind: "approval", title: "Approve once" },
    });

    const responses = await Promise.all([
      first.resolveHumanInteraction({
        interactionId: interaction.id,
        response: { approved: true },
      }),
      second.resolveHumanInteraction({
        interactionId: interaction.id,
        response: { approved: false },
      }),
    ]);

    expect(responses.filter((response) => !response.duplicate)).toHaveLength(1);
    expect(responses.filter((response) => response.duplicate)).toHaveLength(1);
    const persisted = await createFileStateManager({ pragmaHome }).getHumanInteraction(
      interaction.id,
    );
    expect(persisted?.status).toBe("responded");
    expect(persisted?.response).toEqual(
      responses.find((response) => !response.duplicate)?.interaction.response,
    );
  });

  async function createTempHome(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pragma-storage-concurrency-"));
    roots.push(root);
    return root;
  }
});

function createMessage(id: string, workflowRunId: string): MailboxMessage {
  return {
    id,
    kind: "event",
    type: "workflow.started",
    workflowRunId,
    occurredAt: new Date().toISOString(),
    producer: { id: "test", kind: "external" },
    payload: {},
  };
}
