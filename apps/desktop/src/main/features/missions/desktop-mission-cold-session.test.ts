import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileExpertSessionStore,
  createRuntimeSessionRecord,
  readRuntimeSessionsForOwners,
  updateRuntimeSessionRecord,
  createExpertAgentPluginPackageFingerprint,
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  ExpertSessionManager,
  PragmaPaths,
  type ExpertSession,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import {
  createMissionControlApplication,
  createMissionControllerStore,
  createMissionOwnerScope,
  createSqliteExecutionStore,
} from "@pragma/local-host";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaRuntimeProfileResourceSchema,
} from "@pragma/interpreter/ast";
import { expect, it, vi } from "vitest";

import { missionExecutorSnapshot } from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import {
  createDesktopMissionTestApplication,
  type DesktopMissionTestApplication,
} from "./fixtures/desktop-mission-test-application.ts";
import { createMissionStore } from "@pragma/local-host";

it.each(["expert", "team"] as const)(
  "cold-stops a real %s checkpoint without execute resources and resumes healthy sends",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), `pragma-cold-${kind}-stop-`));
    const home = join(root, "original");
    const coldHome = join(root, "cold");
    const loggerProvider = createNoopLoggerProvider();
    const pluginRoot = join(root, "plugin");
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(
      join(pluginRoot, "package.json"),
      JSON.stringify({ name: "fixture", version: "1.0.0", type: "module", main: "./index.mjs" }),
    );
    await writeFile(
      join(pluginRoot, "plugin.json"),
      JSON.stringify({
        schemaVersion: "pragma.plugin/v2",
        id: "fixture",
        name: "Fixture",
        description: "Fixture",
        version: "1.0.0",
        tags: [],
        runtime: { type: "expert-agent-plugin", entry: "./index.mjs", trust: "trusted-host" },
        capabilities: [],
        configuration: { type: "object", properties: {}, additionalProperties: false },
        permissions: { filesystem: [], shell: [], network: [], environment: [] },
      }),
    );
    await writeFile(
      join(pluginRoot, "index.mjs"),
      "import { readFileSync } from 'node:fs'; const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf8')); export default { id: manifest.id, name: manifest.name, version: manifest.version, manifest, setup: () => ({}) };\n",
    );
    const packageFingerprint = await createExpertAgentPluginPackageFingerprint(pluginRoot);
    const profile = PragmaRuntimeProfileResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: { id: "rdzgnq05qfqcpqcm", name: "Fixture", description: "Fixture", tags: [] },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "fake", providerId: "test", model: "test-model" },
      },
    });
    const expert = PragmaExpertResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: "1xddvess309a6gme",
        avatarId: "pragma.avatar.expert.default",
        name: "Fixture",
        description: "Fixture",
        tags: [],
      },
      spec: {
        scope: "Fixture",
        instructions: "Respond.",
        runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [{ ref: "plugin:fixture@1.0.0" }],
        tools: [],
      },
    });
    const member = PragmaExpertResourceSchema.parse({
      ...expert,
      metadata: { ...expert.metadata, id: "3sfd30h5017wd17d", name: "Member" },
    });
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ExpertTeam",
      metadata: {
        id: "vyv9pwwzaksth2dd",
        avatarId: "pragma.avatar.team.default",
        name: "Team",
        description: "Fixture",
        tags: [],
      },
      spec: {
        coordinator: { ref: `expert:${expert.metadata.id}` },
        members: [{ ref: `expert:${member.metadata.id}` }],
        delegation: { maxDepth: 2, maxConcurrency: 2, permissions: { interact: {} }, runtimes: {} },
        contextStores: [],
      },
    });
    const target = kind === "expert" ? expert : team;
    const project = createPragmaProjectStore({
      projectsPath: join(root, "projects"),
      loggerProvider,
    });
    const snapshot = await project.publish({
      expectedRevision: 0,
      resources: [profile, expert, member, ...(kind === "team" ? [team] : [])],
    });
    const missionsPath = join(root, "missions");
    const missions = createMissionStore({ missionsPath });
    const mission = await missions.create({
      workspace: { path: root, basename: "fixture" },
      goal: "Hold the first turn",
      project: { id: snapshot.projectId, revision: snapshot.revision },
      executor: missionExecutorSnapshot(target),
    });
    let broken = false;
    let finishNormally = false;
    const readiness = vi.fn(async () => {
      if (broken) throw new Error("execution readiness unavailable");
    });
    const secret = vi.fn(async () => {
      if (broken) throw new Error("secret store locked");
      return "fixture-secret";
    });
    const inspect = vi.fn(async () => {
      if (broken) throw new Error("plugin unavailable");
      await secret();
      return {
        ref: "plugin:fixture@1.0.0" as const,
        status: "ready" as const,
        packageFingerprint,
        verificationFingerprint: "b".repeat(64),
        issues: [],
      };
    });
    const resolve = vi.fn(async () => {
      if (broken) throw new Error("plugin unavailable");
      await secret();
      return {
        ref: "plugin:fixture@1.0.0" as const,
        source: pluginRoot,
        packageFingerprint,
        verificationFingerprint: "b".repeat(64),
        cachePolicy: "host-managed" as const,
        userConfig: {},
      };
    });
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolveStarted) => (markStarted = resolveStarted));
    const startTurn = vi.fn(
      async (
        _session: { id: string },
        turn: Parameters<
          NonNullable<
            Parameters<typeof defineRuntimeTestDriver<never, { id: string }>>[0]["startTurn"]
          >
        >[1],
      ) => {
        if (!finishNormally) {
          markStarted();
          await new Promise<void>((_resolve, reject) => {
            turn.signal.throwIfAborted();
            turn.signal.addEventListener("abort", () => reject(turn.signal.reason), { once: true });
          });
        }
        return { outputText: "done", runtimeSessionId: _session.id };
      },
    );
    const runtime = defineRuntimeTestDriver<never, { id: string }>({
      descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
      createSession: ({ systemSessionId }) => ({ id: systemSessionId }),
      restoreSession: ({ request }) => ({ id: request.runtimeSession!.id }),
      readSession: (session) => ({ runtimeSessionId: session.id }),
      startTurn,
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const executionStore = createSqliteExecutionStore({ pragmaHome: home });
    const coldStore = createSqliteExecutionStore({ pragmaHome: coldHome });
    const common: Parameters<typeof createDesktopMissionTestApplication>[0] = {
      missions,
      project,
      loggerProvider,
      capabilityStore: {} as CapabilityStore,
      capabilityCredentials: {} as CapabilityCredentialStore,
      capabilitiesPath: join(root, "capabilities"),
      pragmaHome: home,
      executionStore,
      assertExecutorReady: readiness,
      plugins: { inspect, resolve } as unknown as PluginStore,
      resolveSecret: secret,
      runtimes: createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" }),
    };
    const original = createDesktopMissionTestApplication(common);
    let restarted: DesktopMissionTestApplication | undefined;
    const originalResume = ExpertSessionManager.prototype.resumeSession;
    let controlSession: ExpertSession | undefined;
    const resume = vi
      .spyOn(ExpertSessionManager.prototype, "resumeSession")
      .mockImplementation(async function (this: ExpertSessionManager, ...args) {
        const session = await originalResume.apply(this, args);
        controlSession = session;
        return session;
      });
    try {
      await original.startRun(mission.id);
      await started;
      await vi.waitFor(
        async () => expect((await missions.get(mission.id)).execution?.status).toBe("running"),
        { timeout: 10_000 },
      );
      const queuedRequestId = randomUUID();
      await original.sendMessage({
        id: mission.id,
        content: "Queued before restart",
        requestId: queuedRequestId,
      });
      const runningMission = await missions.get(mission.id);
      const sessionId = runningMission.execution!.sessionId!;
      const sourceSessions = createFileExpertSessionStore({
        pragmaHome: home,
        executions: executionStore,
      });
      const checkpoint = (await sourceSessions.readSnapshot(sessionId))!;
      expect(checkpoint.prompts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ requestId: queuedRequestId, status: "queued" }),
        ]),
      );
      // Clone actual aggregates, not SQLite files/WAL or manufactured Session data.
      for (const executionId of checkpoint.session.executionIds) {
        const execution = (await executionStore.get(executionId))!;
        const invocations = await executionStore.listInvocations(executionId);
        await coldStore.create(
          execution,
          invocations.find((entry) => entry.invocationId === execution.rootInvocationId)!,
        );
        await coldStore.commit({
          commitId: `checkpoint:${executionId}`,
          executionId,
          invocationPuts: invocations.filter(
            (entry) => entry.invocationId !== execution.rootInvocationId,
          ),
          contextPuts: await executionStore.listContexts(executionId),
          agentPuts: await executionStore.listAgents(executionId),
          events: (await executionStore.readEvents(executionId)).map((event) => ({
            eventId: event.eventId,
            invocationId: event.invocationId,
            type: event.type,
            data: event.data,
            occurredAt: event.occurredAt,
          })),
        });
      }
      const coldSessions = createFileExpertSessionStore({
        pragmaHome: coldHome,
        executions: coldStore,
      });
      await coldSessions.create(checkpoint.session);
      await coldSessions.transact(sessionId, () => ({
        result: undefined,
        session: checkpoint.session,
        prompts: checkpoint.prompts,
      }));
      const paths = new PragmaPaths({ pragmaHome: home });
      const coldPaths = new PragmaPaths({ pragmaHome: coldHome });
      const nativeRecords = await readRuntimeSessionsForOwners(paths, [sessionId]);
      expect(nativeRecords.length).toBeGreaterThan(0);
      for (const record of nativeRecords) {
        await createRuntimeSessionRecord({
          paths: coldPaths,
          owner: record.owner,
          systemSessionId: record.systemSessionId,
          agentId: record.expertId,
          runtime: { ...record.runtime, displayName: "Fixture" },
          workspace: record.currentWorkspace,
        });
        await updateRuntimeSessionRecord(coldPaths, record, {});
      }
      await original.stopLocalController(mission.id);
      // A separate Inbox/owner scope prevents the original standalone control
      // loop from consuming a command intended for this cold Host.
      const coldMissionsPath = join(coldHome, "missions");
      const coldMissions = createMissionStore({ missionsPath: coldMissionsPath });
      await coldMissions.create({
        id: mission.id,
        workspace: { path: root, basename: "fixture" },
        goal: "Hold the first turn",
        project: { id: snapshot.projectId, revision: snapshot.revision },
        executor: missionExecutorSnapshot(target),
      });
      await coldMissions.updateExecution(mission.id, runningMission.execution!);
      broken = true;
      readiness.mockClear();
      inspect.mockClear();
      resolve.mockClear();
      secret.mockClear();
      startTurn.mockClear();
      restarted = createDesktopMissionTestApplication({
        ...common,
        pragmaHome: coldHome,
        executionStore: coldStore,
        missions: coldMissions,
      });
      const controller = createMissionControllerStore({
        missionsPath: coldMissionsPath,
        missionPath: coldMissions.storagePath,
      });
      const ownerScope = createMissionOwnerScope({
        controller,
        recoverSemanticWrite: async () => undefined,
      });
      const control = createMissionControlApplication({
        controller,
        ownerScope,
        consumer: restarted.missionControl.consumer,
        assertMission: async (id) => {
          await coldMissions.get(id);
        },
        assertAcquisitionAllowed: restarted.missionControl.assertAcquisitionAllowed,
        resolveStrictTarget: restarted.missionControl.resolveStrictTarget,
        resolveExecutionTarget: restarted.missionControl.resolveExecutionTarget,
        client: { surface: "desktop", version: "test", instanceId: randomUUID() },
      });
      restarted.missionControl.bindApplication(control);
      await expect(
        restarted.missionControl.assertAcquisitionAllowed(mission.id, "execute"),
      ).rejects.toThrow("execution readiness unavailable");
      readiness.mockClear();
      await restarted.interrupt(mission.id, runningMission.execution!.id);
      expect(readiness).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(secret).not.toHaveBeenCalled();
      expect(startTurn).not.toHaveBeenCalled();
      expect(controlSession).toBeDefined();
      await expect(
        controlSession!.prompt("This stop definition must not execute"),
      ).rejects.toMatchObject({ code: "STOP_ONLY_DEFINITION" });
      expect((await coldSessions.get(sessionId))?.status).toBe("open");
      expect(await coldSessions.listPrompts(sessionId)).toEqual(
        expect.arrayContaining([
          // The public interrupt command clears pending work. Its durable
          // receipt and original content remain inspectable after release.
          expect.objectContaining({
            requestId: queuedRequestId,
            executionId: checkpoint.prompts.find((entry) => entry.requestId === queuedRequestId)!
              .executionId,
            content: "Queued before restart",
            status: "cancelled",
          }),
        ]),
      );
      await expect(
        restarted.sendMessage({
          id: mission.id,
          content: "Still unavailable",
          requestId: randomUUID(),
        }),
      ).rejects.toThrow("execution readiness unavailable");
      broken = false;
      finishNormally = true;
      const newRequestId = randomUUID();
      await restarted.sendMessage({
        id: mission.id,
        content: "Resources recovered",
        requestId: newRequestId,
      });
      await restarted.resumeQueue(mission.id);
      await vi.waitFor(
        async () => {
          const prompts = await coldSessions.listPrompts(sessionId);
          expect(prompts.find((entry) => entry.requestId === newRequestId)?.status).toBe(
            "succeeded",
          );
        },
        { timeout: 10_000 },
      );
      expect(inspect).toHaveBeenCalled();
      expect(resolve).toHaveBeenCalled();
      expect(secret).toHaveBeenCalled();
      expect(startTurn).toHaveBeenCalled();
      expect((await coldMissions.get(mission.id)).execution?.sessionId).toBe(sessionId);
    } finally {
      resume.mockRestore();
      await restarted?.stopLocalController(mission.id);
      await original.stopLocalController(mission.id);
      await executionStore.close();
      await coldStore.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  },
  30_000,
);
