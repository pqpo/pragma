import { hashMissionCommandPayload } from "../../src/missions/controller/command-payload.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStaticRuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { createIntegrationError } from "@pragma/shared/integration";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { createMissionControllerStore } from "../../src/missions/controller/mission-controller-store.ts";
import { createMissionOwnerScope } from "../../src/missions/controller/owner-scope.ts";
import { createMissionControlApplication } from "../../src/missions/controller/mission-control.ts";
import {
  createLocalHostMissionExecutionService,
  type LocalHostMissionExecutionResourcePorts,
} from "../../src/missions/execution-service.ts";

const temporaryPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("shared Mission command outcome use case", { timeout: 30_000 }, () => {
  it.each(["expired", "failed", "rejected", "applied"] as const)(
    "forwards a durable %s command outcome without reporting false success",
    async (state) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-mission-command-outcome-"));
      temporaryPaths.push(root);
      const missions = createMissionStore({ missionsPath: join(root, "missions") });
      const mission = await missions.create({
        workspace: { path: root, basename: "workspace" },
        goal: "Preserve command outcomes",
        project: { id: "project", revision: 1 },
        executor: { kind: "expert", ref: "expert:aaaaaaaaaaaaaaaa", name: "Expert" },
      });
      const startTurn = vi.fn(() => ({ outputText: "unused", runtimeSessionId: "runtime" }));
      const runtime = defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "fake", kind: "fake", displayName: "Fake" },
        createSession: () => ({ id: "runtime" }),
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn,
        mapEvent: () => ({ events: [] }),
      });
      const controller = createMissionControllerStore({
        missionsPath: join(root, "missions"),
        missionPath: missions.storagePath,
      });
      const ownerScope = createMissionOwnerScope({ controller });
      const runner = createLocalHostMissionExecutionService({
        missions,
        pragmaHome: join(root, "state"),
        runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
        resourcePorts: {
          createCompileService: () => ({}),
        } as LocalHostMissionExecutionResourcePorts,
      });
      const failure = {
        message: "Durable command did not apply.",
        details: { missionId: mission.id, reason: "outcome-regression" },
      };
      const error =
        state === "failed"
          ? createIntegrationError({
              ...failure,
              code: "EXECUTION_FAILED",
              category: "execution",
              retryable: false,
            })
          : createIntegrationError({ ...failure, code: "COMMAND_REJECTED", category: "conflict" });
      const result = { requestedMode: "enqueue", effectiveMode: "enqueue" };
      const apply = vi.fn(async () => {
        if (state === "rejected") throw error;
        return { result };
      });
      const control = createMissionControlApplication({
        controller,
        ownerScope,
        consumer: { apply },
        assertMission: async (missionId) => {
          await missions.get(missionId);
        },
      });
      runner.missionControl.bindApplication(control);
      try {
        const requestId = crypto.randomUUID();
        const content = "Retry this durable command";
        const payload = { kind: "send" as const, input: { prompt: content, attachments: [] } };
        const input = { missionId: mission.id, requestId, kind: "send" as const, payload };
        if (state === "failed") {
          // Persist the terminal operation through the real Controller API;
          // command consumers normally produce applied/rejected outcomes.
          const payloadHash = hashMissionCommandPayload(input);
          await controller.appendCommand({
            missionId: mission.id,
            kind: "send",
            payload,
            request: {
              schemaVersion: "pragma.integration-request/v1",
              requestId,
              payloadHash,
              requestedAt: new Date().toISOString(),
              client: { surface: "desktop", version: "test", instanceId: crypto.randomUUID() },
            },
          });
          await control.completeOperation({
            missionId: mission.id,
            requestId,
            payloadHash,
            state: "failed",
            error,
          });
        } else {
          await control.submit({
            ...input,
            ...(state === "expired" ? { expiresAt: "2000-01-01T00:00:00.000Z" } : {}),
          });
        }
        const operation = await control.waitForTerminal({ missionId: mission.id, requestId });
        expect(operation.state).toBe(state);
        const retry = runner.sendMessage({ id: mission.id, content, requestId });
        if (state === "applied") {
          await expect(retry).resolves.toMatchObject(result);
        } else {
          await expect(retry).rejects.toMatchObject(operation.error!);
          // Fault-inject a missing error at the application return boundary.
          // The durable outcome remains unchanged; the fallback must be valid.
          const { error: persistedError, ...withoutError } = operation;
          expect(persistedError).toBeDefined();
          vi.spyOn(control, "waitForTerminal").mockResolvedValueOnce(withoutError);
          await expect(
            runner.sendMessage({ id: mission.id, content, requestId }),
          ).rejects.toMatchObject({
            code:
              state === "expired"
                ? "COMMAND_EXPIRED"
                : state === "failed"
                  ? "EXECUTION_FAILED"
                  : "COMMAND_REJECTED",
            retryable: false,
            message: `Mission command ${state}.`,
            details: { missionId: mission.id, requestId },
          });
        }
        expect(apply).toHaveBeenCalledTimes(state === "applied" || state === "rejected" ? 1 : 0);
        expect(startTurn).not.toHaveBeenCalled();
        await expect(
          controller.getOperation({ missionId: mission.id, requestId }),
        ).resolves.toEqual(operation);
      } finally {
        await control.stopOwner(mission.id);
      }
    },
  );
});
