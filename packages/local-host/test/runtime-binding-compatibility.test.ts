import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PragmaPaths, createFileExpertSessionStore } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createRuntimeEnvironmentService,
  createRuntimeEnvironmentStore,
} from "../src/deployment/index.ts";
import { withExactLegacyRuntimeBindings } from "../src/runtime-resolver.ts";
import { createLocalHostNodeApplication } from "../src/node-application.ts";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";
import {
  createPublishedProjectResources,
  writePublishedProjectFixture,
} from "./fixtures/published-project.ts";

describe("historical RuntimeProfile new Mission compatibility", () => {
  it("creates canonical shared bindings from codex-local and never invokes the static resolver", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-retired-runtime-profile-"));
    const paths = new PragmaPaths({ pragmaHome: home });
    const legacy = vi.fn(() => {
      throw new Error("New Missions must not use static authority");
    });
    const startTurn = vi.fn(async () => ({ outputText: "CANONICAL_SHARED_RUNTIME" }));
    const store = createRuntimeEnvironmentStore({ pragmaHome: home });
    const current = createRuntimeEnvironmentService({
      store,
      bindAliases: { "codex-local": "codex" },
      factories: [
        {
          id: "pragma.runtime.codex",
          version: "v1",
          create: (environment) =>
            defineRuntimeTestDriver<never, { id: string }>({
              descriptor: { id: environment.id, kind: "test", displayName: "Shared Codex" },
              canUse: () => ({ usable: true }),
              createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
              readSession: (session) => ({ runtimeSessionId: session.id }),
              startTurn,
              mapEvent: () => ({ events: [] }),
            }),
        },
      ],
    });
    const runtimes = withExactLegacyRuntimeBindings({
      current,
      legacy,
    });
    const resources = createPublishedProjectResources().map((resource) =>
      resource.kind === "RuntimeProfile"
        ? { ...resource, spec: { ...resource.spec, config: { runtimeId: "codex-local" } } }
        : resource,
    );
    const expert = resources.find((resource) => resource.kind === "Expert")!;
    await writePublishedProjectFixture(home, resources);
    const app = createLocalHostNodeApplication({
      pragmaHome: home,
      runtimes,
      client: { surface: "cli", version: "test", instanceId: randomUUID() },
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async (path) => path,
      },
    });
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    try {
      const run = await app.run!.start({
        requestId: randomUUID(),
        command: "expert.run",
        executor: { kind: "expert", id: expert.metadata.id },
        workspace: await app.resolveWorkspace(home),
        prompt: "use the historical profile",
        detach: false,
      });
      expect((await run.outcome).status).toBe("succeeded");
      const mission = await createMissionStore({ missionsPath: paths.missionsRoot() }).get(
        run.missionId,
      );
      const sessions = createFileExpertSessionStore({ pragmaHome: home, executions });
      const session = (await sessions.get(mission.execution!.sessionId!))!;
      const expected = await current.bind({ runtimeId: "codex" });
      expect(session.contexts[session.rootContextId]?.runtime).toEqual(expected.binding);
      expect(startTurn).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      const owned = await store.create({
        schemaVersion: "pragma.runtime-environment/v1",
        id: "codex-local",
        displayName: "Explicitly registered Runtime",
        origin: "registered",
        adapter: { id: "pragma.runtime.codex", version: "v1" },
        config: {},
      });
      expect((await runtimes.bind({ runtimeId: "codex-local" })).binding).toEqual({
        runtimeId: owned.runtimeId,
        revision: owned.revision,
        fingerprint: owned.fingerprint,
      });
      await store.delete({ runtimeId: owned.runtimeId, expectedRevision: owned.revision });
      await expect(runtimes.bind({ runtimeId: "codex-local" })).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
      expect(legacy).not.toHaveBeenCalled();
    } finally {
      await app.dispose?.();
      await executions.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
