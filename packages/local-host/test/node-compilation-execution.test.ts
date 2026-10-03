import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStaticRuntimeResolver, PragmaPaths } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { PragmaCapabilityResourceSchema } from "@pragma/interpreter/ast";
import { CapabilityDefinitionSchema, CapabilityManifestSchema } from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalHostNodeApplication } from "../src/node-application.ts";
import * as nodeCompiler from "../src/node-mission-compiler.ts";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";
import { createLocalHostProjectCatalogFromHome } from "../src/project-catalog.ts";
import { createLocalHostResourceResolvers } from "../src/resources/resolvers.ts";
import {
  createPublishedProjectResources,
  PUBLISHED_FLOW_ID,
  PUBLISHED_TEAM_ID,
  writePublishedProjectFixture,
} from "./fixtures/published-project.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
});

async function fixture(fail = false, checkpoint = false) {
  const home = await mkdtemp(join(tmpdir(), "pragma-node-compiled-execution-"));
  roots.push(home);
  const driver = defineRuntimeTestDriver<never, { readonly id: string }>({
    descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
    createSession: ({ systemSessionId }) => ({ id: `native-${systemSessionId}` }),
    restoreSession: ({ systemSessionId }) => ({ id: `native-${systemSessionId}` }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async (session) => {
      if (fail) throw new Error("fixture execution failure");
      return { outputText: "done", runtimeSessionId: session.id };
    },
    mapEvent: () => ({ events: [] }),
  });
  const canUse = vi.spyOn(driver, "canUse").mockReturnValue({ usable: true });
  const runtimes = createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [driver],
  });
  const resources = [...createPublishedProjectResources()];
  const expert = resources.find((resource) => resource.kind === "Expert")!;
  if (expert.kind !== "Expert") throw new Error("Missing fixture Expert.");
  const capabilityId = "00000000-0000-4000-8000-000000000051";
  const resourceId = "pcr7npvx0gv8fpka";
  expert.spec.capabilities = [{ ref: `capability:${resourceId}`, kind: "tools" }];
  resources.push(
    PragmaCapabilityResourceSchema.parse({
      apiVersion: expert.apiVersion,
      kind: "Capability",
      metadata: { id: resourceId, name: "Fixture", description: "Fixture", tags: [] },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: `binding:desktop-capability.${Buffer.from(capabilityId).toString("base64url")}`,
        config: { key: "fixture" },
      },
    }),
  );
  if (checkpoint) {
    const flow = resources.find((resource) => resource.kind === "Flow")!;
    if (flow.kind !== "Flow") throw new Error("Missing fixture Flow.");
    flow.spec.graph.steps["approve"] = {
      human: {
        selectionMode: "single",
        prompt: { segments: [{ text: "Continue?" }] },
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      },
    };
    flow.spec.graph.transitions["run"] = "approve";
    flow.spec.graph.transitions["approve"] = { end: true };
  }
  await writePublishedProjectFixture(home, resources);
  const paths = new PragmaPaths({ pragmaHome: home });
  const capabilityRoot = join(paths.dataRoot(), "capabilities", capabilityId);
  const definition = CapabilityDefinitionSchema.parse({
    kind: "code_service",
    name: "Fixture",
    description: "Fixture",
    language: "javascript",
    timeoutMs: 1000,
    tool: {
      name: "fixture_tool",
      description: "Fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      source: "function main() { return {}; }",
    },
  });
  await mkdir(join(capabilityRoot, "revisions", "000003"), { recursive: true });
  const date = new Date().toISOString();
  await writeFile(
    join(capabilityRoot, "capability.json"),
    JSON.stringify(
      CapabilityManifestSchema.parse({
        schemaVersion: "pragma.capability/v4",
        id: capabilityId,
        runtimeKey: "fixture_tool_capability",
        name: "Fixture",
        kind: "code_service",
        latestRevision: 3,
        activeRevision: 3,
        createdAt: date,
        updatedAt: date,
      }),
    ),
  );
  await writeFile(
    join(capabilityRoot, "revisions", "000003", "definition.json"),
    JSON.stringify(definition),
  );
  await writeFile(
    join(capabilityRoot, "health.json"),
    JSON.stringify({ revision: 3, status: "ready", checkedAt: date }),
  );
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
  const workspace = await app.resolveWorkspace(home);
  return { home, runtimes, app, workspace, canUse, capabilityId, expertId: expert.metadata.id };
}

describe("default Node compilation reaches persisted Execution", { timeout: 15_000 }, () => {
  it.each(["expert", "team", "flow"] as const)(
    "records compiled environment and active Capability revision for %s",
    async (kind) => {
      const f = await fixture();
      const id =
        kind === "expert" ? f.expertId : kind === "team" ? PUBLISHED_TEAM_ID : PUBLISHED_FLOW_ID;
      const catalog = createLocalHostProjectCatalogFromHome({
        pragmaHome: f.home,
        runtimes: f.runtimes,
      });
      const resolved = await catalog.resolve({ ref: { kind, id }, workspace: f.workspace });
      const active = await createLocalHostResourceResolvers({
        pragmaHome: f.home,
      }).capabilityAuthority.resolve(f.capabilityId);
      expect(resolved?.compilation?.capabilities).toEqual([active]);
      expect(resolved?.environment?.resources).toEqual([
        { kind: "capability", id: f.capabilityId, revision: 3, fingerprint: active.fingerprint },
      ]);
      const handle = await f.app.run!.start({
        requestId: randomUUID(),
        command: `${kind}.run`,
        executor: { kind, id },
        project: { projectId: "studio", revision: 1 },
        workspace: f.workspace,
        prompt: "done",
        detach: false,
      });
      const outcome = await handle.outcome;
      expect("error" in outcome ? outcome.error : undefined).toBeUndefined();
      expect(outcome).toMatchObject({ status: "succeeded" });
      const executions = createSqliteExecutionStore({ pragmaHome: f.home });
      try {
        const record = await executions.get(handle.executionId!);
        expect(record?.environment).toEqual(resolved?.environment);
        expect(record?.environment?.resources?.[0]).toMatchObject({
          revision: 3,
          fingerprint: active.fingerprint,
        });
      } finally {
        executions.close();
      }
    },
  );

  it("interrupts a cold default Node Flow after readiness API and Capability become unavailable", async () => {
    const f = await fixture(false, true);
    const started = await f.app.run!.start({
      requestId: randomUUID(),
      command: "flow.run",
      executor: { kind: "flow", id: PUBLISHED_FLOW_ID },
      project: { projectId: "studio", revision: 1 },
      workspace: f.workspace,
      detach: false,
    });
    expect((await started.outcome).status).toBe("input_required");
    // Override the Host-facing adapter readiness API. The test driver's
    // separately configured Native Session availability remains usable, so
    // this verifies compile/preflight isolation, not cancellation of an
    // unavailable Native provider.
    f.canUse.mockReturnValue({ usable: false, reason: "Host readiness API unavailable" });
    f.canUse.mockClear();
    await rm(
      join(new PragmaPaths({ pragmaHome: f.home }).dataRoot(), "capabilities", f.capabilityId),
      { recursive: true },
    );
    const cold = createLocalHostNodeApplication({
      pragmaHome: f.home,
      runtimes: f.runtimes,
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async (path) => path,
      },
    });
    const requestId = randomUUID();
    await cold.missionControl!.submit({
      missionId: started.missionId,
      requestId,
      kind: "interrupt",
      payload: { kind: "interrupt", reason: "Stop cold Flow" },
    });
    const operation = await cold.missionControl!.waitForTerminal({
      missionId: started.missionId,
      requestId,
      timeoutMs: 5_000,
    });
    expect(operation.state).toBe("applied");
    // This counter covers the external adapter API, not Native Session probes.
    expect(f.canUse).not.toHaveBeenCalled();
    const executions = createSqliteExecutionStore({ pragmaHome: f.home });
    try {
      expect((await executions.get(started.executionId!))?.status).toBe("cancelled");
    } finally {
      executions.close();
    }
    const sendRequestId = randomUUID();
    await cold.missionControl!.submit({
      missionId: started.missionId,
      requestId: sendRequestId,
      kind: "send",
      payload: { kind: "send", input: { prompt: "continue" } },
    });
    const rejected = await cold.missionControl!.waitForTerminal({
      missionId: started.missionId,
      requestId: sendRequestId,
      timeoutMs: 5_000,
    });
    expect(rejected).toMatchObject({ state: "rejected", error: { code: "RUNTIME_UNAVAILABLE" } });
    await cold.missionControl!.stopOwner(started.missionId);
    expect(f.canUse).toHaveBeenCalled();
  });

  it("invalidates successful readiness when the default Node execution fails", async () => {
    const createCompiler = nodeCompiler.createLocalHostNodeMissionCompiler;
    let compiler: nodeCompiler.LocalHostNodeMissionCompiler | undefined;
    let invalidate: ReturnType<typeof vi.spyOn> | undefined;
    vi.spyOn(nodeCompiler, "createLocalHostNodeMissionCompiler").mockImplementation((options) => {
      compiler = createCompiler(options);
      invalidate = vi.spyOn(compiler.readiness, "invalidate");
      return compiler;
    });
    const f = await fixture(true);
    const request = {
      command: "expert.run" as const,
      executor: { kind: "expert" as const, id: f.expertId },
      project: { projectId: "studio", revision: 1 },
      workspace: f.workspace,
      prompt: "fail",
      detach: false,
    };
    const first = await f.app.run!.start({ ...request, requestId: randomUUID() });
    expect((await first.outcome).status).toBe("failed");
    expect(invalidate).toHaveBeenCalledOnce();
    const probes = f.canUse.mock.calls.length;
    if (compiler === undefined) throw new Error("Default Node compiler was not created.");
    await compiler.assertReady(
      compiler.service.createRequestScope({
        id: first.missionId,
        project: { id: "studio", revision: 1 },
        executor: { kind: "expert", ref: `expert:${f.expertId}`, name: "Fixture" },
        workspace: { path: f.home },
        contextMounts: [],
      }),
    );
    expect(f.canUse).toHaveBeenCalledTimes(probes + 1);
  });
});
