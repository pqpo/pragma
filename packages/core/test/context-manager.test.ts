import { describe, expect, it } from "vitest";

import {
  ContextManager,
  ContextSystem,
  StaticContextStore,
  defineExpert,
  type ExpertAgentContextItemSummary,
} from "../src/index.ts";

function summary(
  namespace: string,
  id: string,
  trigger: "always_on" | "model_decision" | "manual",
  priority: "critical" | "high" | "normal" | "low" = "normal",
  sizeBytes = 1,
): ExpertAgentContextItemSummary {
  return { namespace, id, metadata: { trigger, priority }, sizeBytes };
}

async function createManager(contextSystem: ContextSystem): Promise<ContextManager> {
  const agent = await defineExpert({
    id: "context-manager-test",
    name: "Context Manager Test",
    description: "Exercises context assembly",
    tags: ["test"],
    scope: "test",
    workspace: process.cwd(),
    pragmaHome: process.cwd(),
    contextSystem,
  });
  return new ContextManager({ agent, contextSystem });
}

describe("Context selection and assembly", () => {
  it("applies roots as local overrides without hiding triggers in unrooted namespaces", () => {
    const system = new ContextSystem({
      roots: [
        {
          namespace: "project",
          load: {
            forbiddenLoad: ["hidden.md"],
            preloadPaths: ["forced.md"],
            priorityRules: [{ pattern: "forced.md", priority: "critical" }],
          },
        },
      ],
    });
    const selected = system.selectContext([
      summary("project", "hidden.md", "always_on"),
      summary("project", "forced.md", "manual"),
      summary("mission-board", "GUIDE.md", "always_on", "critical"),
      summary("mission-board", "plan.md", "model_decision", "high"),
    ]);

    expect(selected.excluded).toEqual([{ namespace: "project", id: "hidden.md" }]);
    expect(selected.context.map(({ namespace, id }) => ({ namespace, id }))).toEqual([
      { namespace: "mission-board", id: "plan.md" },
    ]);
    expect(selected.preload).toEqual([
      expect.objectContaining({
        namespace: "mission-board",
        id: "GUIDE.md",
        reasons: ["always_on"],
      }),
      expect.objectContaining({
        namespace: "project",
        id: "forced.md",
        metadata: expect.objectContaining({ priority: "critical" }),
        reasons: ["preload_path"],
      }),
    ]);
  });

  it("uses a fair 16,000-byte default allocation for oversized critical contexts", async () => {
    const content = "x".repeat(12_000);
    const contextSystem = new ContextSystem({
      stores: {
        first: new StaticContextStore([
          { id: "FIRST.md", content, metadata: { trigger: "always_on", priority: "critical" } },
        ]),
        second: new StaticContextStore([
          { id: "SECOND.md", content, metadata: { trigger: "always_on", priority: "critical" } },
        ]),
      },
    });
    const assembled = await (await createManager(contextSystem)).buildContext();

    expect(assembled.snapshot.budget).toMatchObject({
      preloadBytes: 16_000,
      preloadByteBudget: 16_000,
    });
    expect(assembled.snapshot.alwaysOnContexts).toEqual([
      expect.objectContaining({ id: "FIRST.md", status: "partial", loadedBytes: 8_000 }),
      expect.objectContaining({ id: "SECOND.md", status: "partial", loadedBytes: 8_000 }),
    ]);
    expect(assembled.systemPrompt).toContain("Always-on Context Manifest");
    expect(assembled.systemPrompt).toContain("start=8000");
    expect(assembled.startupMessages[0]?.content).toContain("FIRST.md");
    expect(assembled.startupMessages[0]?.content).toContain("SECOND.md");
  });

  it("applies the first-pass priority quotas before allocating lower-tier remainder", async () => {
    const content = "x".repeat(4_000);
    const contextSystem = new ContextSystem({
      stores: {
        context: new StaticContextStore([
          { id: "critical.md", content, metadata: { trigger: "always_on", priority: "critical" } },
          { id: "high.md", content, metadata: { trigger: "always_on", priority: "high" } },
          { id: "normal.md", content, metadata: { trigger: "always_on", priority: "normal" } },
          { id: "low.md", content, metadata: { trigger: "always_on", priority: "low" } },
        ]),
      },
    });
    const assembled = await (
      await createManager(contextSystem)
    ).buildContext({}, { preloadByteBudget: 3_584 });

    expect(
      Object.fromEntries(
        assembled.snapshot.alwaysOnContexts.map((entry) => [entry.id, entry.loadedBytes]),
      ),
    ).toEqual({
      "critical.md": 2_048,
      "high.md": 1_024,
      "normal.md": 512,
      "low.md": 0,
    });
  });

  it("reports full, partial, and deferred entries independently of body allocation", async () => {
    const contextSystem = new ContextSystem({
      stores: {
        context: new StaticContextStore([
          {
            id: "a-full.md",
            content: "a",
            metadata: { trigger: "always_on", priority: "critical" },
          },
          {
            id: "b-partial.md",
            content: "bbbb",
            metadata: { trigger: "always_on", priority: "critical" },
          },
          {
            id: "c-deferred.md",
            content: "cccc",
            metadata: { trigger: "always_on", priority: "critical" },
          },
        ]),
      },
    });
    const assembled = await (
      await createManager(contextSystem)
    ).buildContext(
      {},
      {
        preloadByteBudget: 2,
      },
    );

    expect(assembled.snapshot.alwaysOnContexts).toEqual([
      expect.objectContaining({ id: "a-full.md", status: "full", loadedBytes: 1 }),
      expect.objectContaining({
        id: "b-partial.md",
        status: "partial",
        loadedBytes: 1,
        nextStartOffset: 1,
      }),
      expect.objectContaining({
        id: "c-deferred.md",
        status: "deferred",
        loadedBytes: 0,
        nextStartOffset: 0,
      }),
    ]);
    expect(assembled.systemPrompt).toContain("loadStatus: deferred");
    expect(assembled.systemPrompt).toContain('id="c-deferred.md" start=0');
    expect(assembled.startupMessages[0]?.content).toContain("The included portions supersede");
    expect(assembled.startupMessages[0]?.content).not.toContain("This complete block supersedes");
  });

  it("treats a short read as partial even when a store incorrectly clears its truncated flag", async () => {
    const backing = new StaticContextStore([
      { id: "required.md", content: "required", metadata: { trigger: "always_on" } },
    ]);
    const store = Object.create(backing) as StaticContextStore;
    Object.defineProperty(store, "readContext", {
      value: async () => ({
        ok: true as const,
        value: {
          id: "required.md",
          content: "req",
          metadata: { trigger: "always_on" as const, priority: "normal" as const },
          sizeBytes: 8,
          contentRange: {
            requestedStartOffset: 0,
            startOffset: 0,
            endOffset: 3,
            nextStartOffset: 3,
            truncated: false,
            sizeBytes: 8,
            maxBytes: 3,
          },
        },
      }),
    });
    const assembled = await (
      await createManager(new ContextSystem({ stores: { context: store } }))
    ).buildContext({}, { preloadByteBudget: 3 });

    expect(assembled.snapshot.alwaysOnContexts).toEqual([
      expect.objectContaining({
        id: "required.md",
        status: "partial",
        loadedBytes: 3,
        nextStartOffset: 3,
      }),
    ]);
    expect(assembled.snapshot.truncationReason).toBe("always_on_context_budget_exceeded");
  });

  it("rejects a preload whose declared range understates its actual UTF-8 body", async () => {
    const backing = new StaticContextStore([
      { id: "required.md", content: "required", metadata: { trigger: "always_on" } },
    ]);
    const store = Object.create(backing) as StaticContextStore;
    Object.defineProperty(store, "readContext", {
      value: async () => ({
        ok: true as const,
        value: {
          id: "required.md",
          content: "界界",
          metadata: { trigger: "always_on" as const, priority: "normal" as const },
          sizeBytes: 8,
          contentRange: {
            requestedStartOffset: 0,
            startOffset: 0,
            endOffset: 1,
            nextStartOffset: 1,
            truncated: true,
            sizeBytes: 8,
            maxBytes: 3,
          },
        },
      }),
    });
    const manager = await createManager(new ContextSystem({ stores: { context: store } }));

    await expect(manager.buildContext({}, { preloadByteBudget: 3 })).rejects.toMatchObject({
      code: "context_preload_failed",
      message: expect.stringContaining("invalid preload range"),
    });
  });

  it("keeps valid always-on contexts visible when the body budget is zero", async () => {
    const contextSystem = new ContextSystem({
      stores: {
        context: new StaticContextStore([
          { id: "required.md", content: "required", metadata: { trigger: "always_on" } },
          { id: "optional.md", content: "optional", metadata: { trigger: "model_decision" } },
        ]),
      },
    });
    const assembled = await (
      await createManager(contextSystem)
    ).buildContext({}, { preloadByteBudget: 0 });

    expect(assembled.snapshot.budget.preloadBytes).toBe(0);
    expect(assembled.snapshot.alwaysOnContexts).toEqual([
      expect.objectContaining({
        id: "required.md",
        status: "deferred",
        loadedBytes: 0,
        nextStartOffset: 0,
      }),
    ]);
    expect(assembled.systemPrompt).toContain('id="required.md" start=0');
    expect(assembled.systemPrompt.indexOf("Always-on Context Manifest")).toBeLessThan(
      assembled.systemPrompt.indexOf("Available context index"),
    );
  });

  it("escapes always-on identities in the manifest", async () => {
    const contextSystem = new ContextSystem({
      stores: {
        context: new StaticContextStore([
          {
            id: "required.md\n  loadStatus: full",
            content: "required",
            metadata: { trigger: "always_on" },
          },
        ]),
      },
    });
    const assembled = await (await createManager(contextSystem)).buildContext();

    expect(assembled.systemPrompt).toContain('id: "required.md\\n  loadStatus: full"');
    expect(assembled.systemPrompt).not.toContain('id: "required.md\n  loadStatus: full"');
  });

  it("counts actual UTF-8 bytes without allowing one peer to starve another", async () => {
    const content = "界".repeat(5_000);
    const contextSystem = new ContextSystem({
      stores: {
        context: new StaticContextStore([
          { id: "a.md", content, metadata: { trigger: "always_on", priority: "critical" } },
          { id: "b.md", content, metadata: { trigger: "always_on", priority: "critical" } },
        ]),
      },
    });
    const assembled = await (await createManager(contextSystem)).buildContext();

    expect(assembled.snapshot.budget.preloadBytes).toBe(15_996);
    expect(assembled.snapshot.budget.preloadBytes).toBeLessThanOrEqual(16_000);
    expect(assembled.snapshot.alwaysOnContexts.map((entry) => entry.loadedBytes)).toEqual([
      7_998, 7_998,
    ]);
  });

  it("fails explicitly when the complete manifest cannot fit", async () => {
    const contextSystem = new ContextSystem({
      stores: {
        context: new StaticContextStore([
          { id: "required.md", content: "required", metadata: { trigger: "always_on" } },
        ]),
      },
    });

    await expect(
      (await createManager(contextSystem)).buildContext({}, { systemPromptCharacterBudget: 1 }),
    ).rejects.toMatchObject({
      code: "context_manifest_budget_exceeded",
    });
  });

  it("fails instead of publishing an always-on manifest with an unknown size", async () => {
    const backing = new StaticContextStore([
      { id: "required.md", content: "required", metadata: { trigger: "always_on" } },
    ]);
    const store = Object.create(backing) as StaticContextStore;
    Object.defineProperty(store, "listContext", {
      value: async () => {
        const listed = await backing.listContext();
        if (!listed.ok) return listed;
        return {
          ok: true as const,
          value: listed.value.map(({ sizeBytes, ...item }) => {
            void sizeBytes;
            return item;
          }),
        };
      },
    });
    const manager = await createManager(new ContextSystem({ stores: { context: store } }));

    await expect(manager.buildContext({}, { preloadByteBudget: 0 })).rejects.toMatchObject({
      code: "context_preload_failed",
      message: expect.stringContaining("does not declare a valid sizeBytes"),
    });
  });
});
