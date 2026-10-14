import { appendFile, stat, access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLocalHostApplication,
  createLocalHostRunApplication,
  createControllerRunMissionPort,
  createMissionControllerStore,
  createMissionQuery,
  type LocalHostRunTerminal,
} from "@pragma/local-host";
import { CliOwnerFrameSchema } from "@pragma/shared/integration";
import { runMissionOwnerRequest } from "../../src/mission-owner-runtime.ts";

process.once("message", (value) => {
  void runMissionOwnerRequest(
    value,
    () => {
      const home = process.env["PRAGMA_TEST_OWNER_HOME"]!;
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const run = createLocalHostRunApplication({
        mission: createControllerRunMissionPort(controller),
        executors: {
          resolve: async ({ ref }) => ({
            descriptor: {
              schemaVersion: "pragma.integration-executor/v1",
              ref,
              name: "Deterministic fixture",
              description: "Shared Host lifecycle with deterministic executor",
              source: "built_in",
              availability: { status: "ready", blockingCodes: [] },
              workspace: { required: true, allowNonGitDirectory: true },
              capabilities: {
                interactive: false,
                resumable: false,
                steerable: false,
                supportsQueue: false,
              },
            },
          }),
          start: async () => {
            const executionId = randomUUID();
            await appendFile(join(home, "starts.jsonl"), `${executionId}\n`);
            let settle!: (value: LocalHostRunTerminal) => void;
            const result = new Promise<LocalHostRunTerminal>((resolve) => {
              settle = resolve;
            });
            const timer = setTimeout(
              () =>
                settle({
                  status: "succeeded",
                  executionId,
                  result: { answer: "finished after client exit" },
                }),
              2500,
            );
            return {
              executionId,
              result,
              cancel: async () => {
                clearTimeout(timer);
                settle({ status: "interrupted", executionId });
              },
            };
          },
        },
      });
      const readOnly = createLocalHostApplication({
        integrationCapability: async () => ({
          schemaVersion: "pragma.integration-capability/v1",
          protocol: "pragma.integration/v2",
          readableVersions: ["pragma.integration/v2"],
          migratableFromVersions: [],
          features: [],
        }),
        catalog: {
          listProjects: async () => [],
          getProjectRevision: async () => undefined,
          listExecutors: async () => [],
        },
        missions: {
          get: async (id) => controller.readSnapshot({ missionId: id }),
          list: async () => [],
          query: createMissionQuery({ controller }).queryMission,
        },
        board: { list: async () => [], read: async () => ({}), search: async () => [] },
        workspace: {
          stat,
          access: async (path, mode) => access(path, mode === "read" ? 4 : 2),
          realpath,
        },
        runtime: { resolver: {} as never },
      });
      return { ...readOnly, run, dispose: async () => undefined };
    },
    async (frame) => {
      const parsed = CliOwnerFrameSchema.parse(frame);
      if (!process.connected) return;
      await new Promise<void>((resolve) => {
        try {
          process.send?.(parsed, () => resolve());
        } catch {
          resolve();
        }
      });
    },
  ).finally(() => process.disconnect?.());
});
