import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createFileExpertSessionStore,
  createNoopLoggerProvider,
  createStaticRuntimeResolver,
  describeExpertExecutionDefinition,
  type RuntimeNativeSessionContext,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import { createMissionStore, createSqliteExecutionStore } from "@pragma/local-host";
import { createCapabilityStore, createPragmaProjectStore } from "@pragma/local-host/deployment";
import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { createDesktopMissionTestApplication } from "./fixtures/desktop-mission-test-application.ts";
import { expect, it, vi } from "vitest";

it.each(["root", "dependency", "root with model override"] as const)(
  "keeps the original Session, native history and Skill revision after a %s system Expert changes",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-pinned-mission-"));
    const home = join(root, "home");
    const capabilitiesPath = join(root, "capabilities");
    const loggerProvider = createNoopLoggerProvider();
    const credentials = {
      fingerprint: async () => "f".repeat(64),
      pending: async () => undefined,
    } as unknown as CapabilityCredentialStore;
    const capabilities = createCapabilityStore({
      capabilitiesPath,
      credentials,
      isReferenced: async () => false,
      verify: async (definition) => ({
        definition,
        health: { status: "ready", checkedAt: new Date().toISOString() },
      }),
      mutations: {
        publish: async (input) => {
          await input.validateCurrent?.();
          return await input.commit();
        },
        publishHealth: async (input) => {
          await input.validateCurrent?.();
          return await input.commit();
        },
        mutate: async (input) => {
          await input.validateCurrent?.();
          await input.commit();
        },
      },
    });
    const skillSource = join(root, "skill");
    await mkdir(skillSource);
    const document =
      "---\nname: pinned-skill\ndescription: A pinned Skill.\n---\n\nskill-version-one\n";
    await writeFile(join(skillSource, "SKILL.md"), document);
    const skill = await capabilities.importSkill({ sourcePath: skillSource });
    const registry = createDesktopSystemExpertRegistry();
    let extraSkillId: string | undefined;
    const configure = async (marker: string, includeSkill = true) => {
      await registry.update(STORE_REVISION_EXPERT_REF, {
        name: marker,
        description: "Fixture",
        tags: [],
        additionalInstructions: "",
        capabilities: includeSkill
          ? [
              { kind: "skill", capabilityId: skill.manifest.id },
              ...(extraSkillId === undefined
                ? []
                : [{ kind: "skill" as const, capabilityId: extraSkillId }]),
            ]
          : [],
        toolApprovals: {},
        plugins: [],
        contextStoreMounts: [],
        resourceTools: [],
      });
    };
    await configure("original-agent-definition");
    await registry.update(BUILT_IN_PRAGMA_REF, {
      name: "Pragma fixture",
      description: "Fixture",
      tags: [],
      additionalInstructions: "",
      capabilities: [],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
      resourceTools: [
        { adapter: "pragma.tool.delegate@v1", targets: [{ ref: STORE_REVISION_EXPERT_REF }] },
      ],
    });
    const project = createPragmaProjectStore({
      projectsPath: join(root, "projects"),
      loggerProvider,
    });
    const revision = await project.ensurePublished();
    const missions = createMissionStore({ missionsPath: join(root, "missions") });
    const ref = kind === "dependency" ? BUILT_IN_PRAGMA_REF : STORE_REVISION_EXPERT_REF;
    const createMission = async () =>
      await missions.create({
        goal: "Remember the codeword violet",
        workspace: { path: root, basename: "fixture" },
        project: { id: revision.projectId, revision: revision.revision },
        executor: { kind: "expert", ref, name: "Fixture" },
        ...(kind === "root with model override"
          ? { modelOverride: { providerId: "fixture", modelId: "mission-model" } }
          : {}),
      });
    const mission = await createMission();
    const nativeHistory = new Map<string, string[]>();
    const observations: {
      nativeId: string;
      definition: string;
      skills: string[];
      history: string[];
      model: string | undefined;
    }[] = [];
    const created = vi.fn((context: RuntimeNativeSessionContext) => {
      const nativeId = randomUUID();
      nativeHistory.set(nativeId, []);
      return { nativeId, context };
    });
    const restored = vi.fn((context: RuntimeNativeSessionContext) => ({
      nativeId: context.request.runtimeSession!.id,
      context,
    }));
    const runtime = defineRuntimeTestDriver({
      descriptor: { id: "fake", kind: "test", displayName: "Fixture" },
      createSession: created,
      restoreSession: restored,
      readSession: (session) => ({ runtimeSessionId: session.nativeId }),
      async startTurn(session, turn) {
        const history = nativeHistory.get(session.nativeId)!;
        const skills = await Promise.all(
          (session.context.agent.skills?.skills ?? []).map(async (entry) =>
            entry.type === "local" && entry.path !== undefined
              ? await readFile(entry.path, "utf8")
              : "",
          ),
        );
        observations.push({
          nativeId: session.nativeId,
          definition: JSON.stringify(describeExpertExecutionDefinition(session.context.agent)),
          skills,
          history: [...history],
          model: turn.modelSelection?.model?.modelId,
        });
        history.push(turn.rawQuery);
        return { outputText: history.join(" | "), runtimeSessionId: session.nativeId };
      },
      mapEvent: () => ({ events: [] }),
      closeSession: () => undefined,
    });
    const runtimes = createStaticRuntimeResolver({ runtimes: [runtime], defaultRuntimeId: "fake" });
    const executions = createSqliteExecutionStore({ pragmaHome: home });
    const sessions = createFileExpertSessionStore({ executions, pragmaHome: home });
    const get = vi.spyOn(capabilities, "get");
    const runners: ReturnType<typeof createDesktopMissionTestApplication>[] = [];
    let configuredRuntime = "fake";
    const createRunner = () => {
      const runner = createDesktopMissionTestApplication({
        missions,
        project,
        loggerProvider,
        pragmaHome: home,
        executionStore: executions,
        capabilitiesPath,
        capabilityStore: capabilities,
        capabilityCredentials: credentials,
        runtimes,
        getSystemExecutorResource: registry.getResource,
        getSystemDependencyResource: registry.getDependencyResource,
        getSystemExecutorFingerprint: registry.fingerprint,
        systemExecutorSource: async ({
          mission: request,
          runtimes: resolver,
          adapterHost,
          pinnedSource,
        }) => {
          const resource = registry.getResource(request.executor.ref);
          if (resource === undefined) return undefined;
          const runtimeDefaults = pinnedSource?.rootExecutionOverride ?? {
            runtimeId: configuredRuntime,
            modelSelection: {
              model: {
                providerId: "fixture",
                modelId: request.modelOverride?.modelId ?? "base-model",
              },
            },
          };
          // Preparation itself must use the saved profile, before compilation overlays it.
          await resolver.bind(runtimeDefaults);
          return {
            rootExecutionOverride: runtimeDefaults,
            ref: request.executor.ref as typeof ref,
            expertResource: {
              ...resource,
              spec: {
                ...resource.spec,
                capabilities: resource.spec.capabilities.filter(
                  (binding) => registry.getDependencyResource(binding.ref) !== undefined,
                ),
              },
            },
            additionalResources: registry.getAdditionalResources(request.executor.ref),
            environmentId: "desktop",
            definitionStateRoot: join(home, "cache", "definitions"),
            workspace: root,
            pragmaHome: home,
            runtimes: resolver,
            loggerProvider,
            adapterHost,
          };
        },
      });
      runners.push(runner);
      return runner;
    };
    let runner = createRunner();
    const waitForTurn = async (id: string, count: number) => {
      await vi.waitFor(
        async () => {
          expect((await missions.get(id)).execution?.status).toBe("succeeded");
          expect(observations).toHaveLength(count);
        },
        { timeout: 15_000 },
      );
    };
    try {
      await runner.startRun(mission.id);
      await waitForTurn(mission.id, 1);
      const originalMission = await missions.get(mission.id);
      const original = (await sessions.get(originalMission.execution!.sessionId!))!;
      const snapshotPath = join(missions.storagePath!(mission.id), "execution-snapshot.json");
      const originalSnapshot = await readFile(snapshotPath, "utf8");
      if (kind === "root with model override") {
        expect(observations[0]!.model).toBe("mission-model");
        expect(
          JSON.parse(originalSnapshot).sources[ref].rootExecutionOverride.modelSelection.model
            .modelId,
        ).toBe("base-model");
        await runner.updateOptions({
          id: mission.id,
          modelOverride: null,
        });
      }
      expect(JSON.parse(originalSnapshot).capabilities).toEqual([
        expect.objectContaining({ capabilityId: skill.manifest.id, resolvedRevision: 1 }),
      ]);
      await capabilities.saveSkillFiles({
        id: skill.manifest.id,
        baseRevision: 1,
        files: [
          { path: "SKILL.md", content: document.replace("skill-version-one", "skill-version-two") },
        ],
      });
      await capabilities.ensureActiveRevision(skill.manifest.id, 2);
      const extraSource = join(root, "extra-skill");
      await mkdir(extraSource);
      await writeFile(
        join(extraSource, "SKILL.md"),
        "---\nname: extra-skill\ndescription: Newly attached Skill.\n---\n\nnewly-attached-skill\n",
      );
      extraSkillId = (await capabilities.importSkill({ sourcePath: extraSource })).manifest.id;
      await configure("updated-agent-definition");
      configuredRuntime = "unavailable-new-default";
      await runner.sendMessage({
        id: mission.id,
        content: "What was the codeword?",
        requestId: randomUUID(),
      });
      await waitForTurn(mission.id, 2);
      await runner.stopLocalController(mission.id, "shutdown");
      runner = createRunner();
      await runner.sendMessage({
        id: mission.id,
        content: "Continue after restart",
        requestId: randomUUID(),
      });
      await waitForTurn(mission.id, 3);
      if (kind === "root with model override")
        expect(observations.slice(1).map((observation) => observation.model)).toEqual([
          "base-model",
          "base-model",
        ]);
      const after = (await sessions.get((await missions.get(mission.id)).execution!.sessionId!))!;
      expect(after.sessionId).toBe(original.sessionId);
      expect(after.rootContextId).toBe(original.rootContextId);
      expect(after.contexts[after.rootContextId]!.snapshot).toEqual(
        original.contexts[original.rootContextId]!.snapshot,
      );
      expect(created).toHaveBeenCalledOnce();
      expect(restored).toHaveBeenCalledOnce();
      expect(observations[2]!.history).toEqual([mission.goal, "What was the codeword?"]);
      expect(
        observations.every(
          (observation) =>
            observation.definition.includes("original-agent-definition") &&
            !observation.definition.includes("updated-agent-definition"),
        ),
      ).toBe(true);
      if (kind !== "dependency")
        expect(
          observations.every((observation) =>
            observation.skills.some(
              (content) =>
                content.includes("skill-version-one") && !content.includes("skill-version-two"),
            ),
          ),
        ).toBe(true);
      expect(get).toHaveBeenCalledWith(skill.manifest.id, 1);
      expect(await readFile(snapshotPath, "utf8")).toBe(originalSnapshot);
      // A new Mission adopts the new Agent and the newly active Skill.
      configuredRuntime = "fake";
      const fresh = await createMission();
      await runner.startRun(fresh.id);
      await waitForTurn(fresh.id, 4);
      expect(observations[3]!.definition).toContain("updated-agent-definition");
      expect(
        JSON.parse(
          await readFile(join(missions.storagePath!(fresh.id), "execution-snapshot.json"), "utf8"),
        ).capabilities.find(
          (pin: { capabilityId: string }) => pin.capabilityId === skill.manifest.id,
        ).resolvedRevision,
      ).toBe(2);
      await runner.stopLocalController(fresh.id, "shutdown");
      // Missing pinned files fail with the original owner and native history intact.
      await runner.stopLocalController(mission.id, "shutdown");
      const oldRevisionPath = dirname(await capabilities.skillFilesPath(skill.manifest.id, 1));
      const backup = join(root, "revision-backup");
      await cp(oldRevisionPath, backup, { recursive: true });
      await rm(oldRevisionPath, { recursive: true });
      runner = createRunner();
      await expect(
        runner.sendMessage({
          id: mission.id,
          content: "Try missing Skill",
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
      expect((await missions.get(mission.id)).execution!.sessionId).toBe(original.sessionId);
      expect(created).toHaveBeenCalledTimes(2);
      await cp(backup, oldRevisionPath, { recursive: true });
      await runner.sendMessage({
        id: mission.id,
        content: "Retry after restoring the pinned Skill",
        requestId: randomUUID(),
      });
      await waitForTurn(mission.id, 5);
      expect((await missions.get(mission.id)).execution!.sessionId).toBe(original.sessionId);
      expect(observations[4]!.nativeId).toBe(observations[0]!.nativeId);
      expect(created).toHaveBeenCalledTimes(2);
      await runner.stopLocalController(mission.id, "shutdown");
      await writeFile(snapshotPath, '{"schemaVersion":"future"}');
      runner = createRunner();
      await expect(
        runner.sendMessage({
          id: mission.id,
          content: "Try future snapshot",
          requestId: randomUUID(),
        }),
      ).rejects.toThrow();
      expect((await missions.get(mission.id)).execution!.sessionId).toBe(original.sessionId);
    } finally {
      for (const active of runners.reverse())
        await active.stopLocalController(mission.id, "shutdown").catch(() => undefined);
      await executions.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  60_000,
);
