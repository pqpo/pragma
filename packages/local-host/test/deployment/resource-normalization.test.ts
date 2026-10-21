import { describe, expect, it } from "vitest";
import {
  PragmaForwardCompatibleResourceSchema,
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import { desktopCapabilityBindingRef } from "../../src/deployment/bindings.ts";
import { normalizeHostBoundResources } from "../../src/deployment/projects/resource-normalization.ts";

const capability = (id: string, hostId = "code", option = false): PragmaResource => ({
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "Capability",
  metadata: {
    id,
    name: `Capability ${hostId}`,
    description: "Capability binding",
    tags: option ? ["default-agent-option"] : [],
  },
  spec: {
    adapter: "pragma.capability.host@v1",
    binding: desktopCapabilityBindingRef(hostId),
    config: { key: hostId },
  },
});
const expert = (id: string, name: string, capabilityId: string): PragmaResource => ({
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "Expert",
  metadata: { id, name, description: "Expert", tags: [], avatarId: "pragma.avatar.expert.default" },
  spec: {
    scope: "Development",
    instructions: "Develop",
    runtime: { ref: "runtime-profile:zdkgs0fde4xt00vr" },
    capabilities: [{ ref: `capability:${capabilityId}`, kind: "tools", tools: [name] }],
    toolApprovals: { [name]: "ask" },
    contextStores: [],
    plugins: [],
    tools: [],
  },
});
const runtime: PragmaResource = {
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "RuntimeProfile",
  metadata: {
    id: "zdkgs0fde4xt00vr",
    name: "Built-in Runtime / qwen",
    description: "Shared runtime",
    tags: [],
  },
  spec: {
    adapter: "pragma.runtime.profile@v1",
    config: { runtimeId: "pi", providerId: "qwen", model: "qwen", thinkingLevel: "high" },
  },
};

describe("Host bound resource normalization", () => {
  it("honors Capability Unicode name limits when adding collision suffixes", async () => {
    const name = "😀".repeat(50);
    const resources = [
      capability("nv27faxmxpqnxwqr", "first"),
      capability("20k21q9j9wexjv50", "second"),
    ];
    const result = await normalizeHostBoundResources(resources, {
      capabilityName: async () => name,
    });
    expect(
      result.resources.find((resource) => resource.metadata.id === "20k21q9j9wexjv50")?.metadata
        .name,
    ).toBe(name);
    for (const resource of result.resources)
      expect(PragmaForwardCompatibleResourceSchema.safeParse(resource).success).toBe(true);
  });

  it("disambiguates same-name capabilities without merging distinct Host identities", async () => {
    const first = capability("nv27faxmxpqnxwqr", "first");
    const second = capability("20k21q9j9wexjv50", "second");
    const result = await normalizeHostBoundResources([first, second], {
      capabilityName: async () => "code",
    });
    expect(result.resources).toHaveLength(2);
    expect(new Set(result.resources.map((resource) => resource.metadata.name)).size).toBe(2);
    expect(result.resources.map((resource) => resource.spec)).toEqual([first.spec, second.spec]);
  });

  it("uses Host identity preference only among existing aliases and preserves a rebound resource ID", async () => {
    const original = capability("nv27faxmxpqnxwqr", "rebound-host");
    const result = await normalizeHostBoundResources([original], {
      canonicalCapabilityId: () => "20k21q9j9wexjv50",
    });
    expect(result.resources).toEqual([original]);
  });

  it("preserves compatible unknown fields when resolving a historical alias through the catalog", async () => {
    const legacy = PragmaForwardCompatibleResourceSchema.parse({
      ...capability("nv27faxmxpqnxwqr"),
      future: { enabled: true },
    });
    const catalog = capability("20k21q9j9wexjv50", "code", true);
    const result = await normalizeHostBoundResources([legacy], { capabilityResources: [catalog] });
    expect(result.resources).toEqual([
      {
        ...legacy,
        metadata: { ...legacy.metadata, id: catalog.metadata.id, tags: ["default-agent-option"] },
      },
    ]);
  });

  it("prefers the actual catalog identity over a copied option with a lower ID", async () => {
    const copy = capability("0000000000000001", "code", true);
    const catalog = capability("20k21q9j9wexjv50", "code", true);
    const result = await normalizeHostBoundResources([copy, catalog], {
      capabilityResources: [catalog],
    });
    expect(result.resources.map((resource) => resource.metadata.id)).toEqual([catalog.metadata.id]);
  });

  it("keeps Runtime names unique when single and shared user labels coincide", async () => {
    const shared = structuredClone(runtime);
    shared.metadata.id = "0000000000000001";
    const a = expert("1xddvess309a6gme", "A", "nv27faxmxpqnxwqr");
    const b = expert("3sfd30h5017wd17d", "B", "nv27faxmxpqnxwqr");
    for (const resource of [a, b])
      if (resource.kind === "Expert")
        resource.spec.runtime = { ref: "runtime-profile:0000000000000001" };
    const literal = expert("0000000000000002", "A / B", "nv27faxmxpqnxwqr");
    const result = await normalizeHostBoundResources([runtime, shared, a, b, literal]);
    const names = result.resources
      .filter((resource) => resource.kind === "RuntimeProfile")
      .map((resource) => resource.metadata.name);
    expect(new Set(names).size).toBe(2);
    expect((await normalizeHostBoundResources(result.resources)).resources).toEqual(
      result.resources,
    );
  });

  it("bounds long generated names, distinguishes same-name users, and preserves every reference", async () => {
    const first = expert("1xddvess309a6gme", "同名😀", "nv27faxmxpqnxwqr");
    const second = expert("3sfd30h5017wd17d", "同名😀", "nv27faxmxpqnxwqr");
    const result = await normalizeHostBoundResources([runtime, first, second]);
    expect(result.resources[0]!.metadata.name).toBe(
      "同名😀 (1xddvess309a6gme) / 同名😀 (3sfd30h5017wd17d) Runtime",
    );
    const users = Array.from({ length: 10 }, (_, index) =>
      expert(`000000000000000${index}`, "😀".repeat(50), "nv27faxmxpqnxwqr"),
    );
    const overflow = await normalizeHostBoundResources([runtime, ...users]);
    expect(overflow.resources[0]!.metadata.name.length).toBeLessThanOrEqual(200);
    expect(overflow.resources[0]!.metadata.name).toMatch(/… Runtime$/);
    expect(overflow.resources.slice(1)).toEqual(users);
  });

  it("unions explicit tool selections when one Expert used two aliases", async () => {
    const selected = expert("1xddvess309a6gme", "Writer", "nv27faxmxpqnxwqr");
    if (selected.kind !== "Expert") throw new Error("Expected Expert");
    selected.spec.capabilities.push({
      ref: "capability:20k21q9j9wexjv50",
      kind: "tools",
      tools: ["read"],
    });
    const result = await normalizeHostBoundResources([
      selected,
      capability("nv27faxmxpqnxwqr"),
      capability("20k21q9j9wexjv50", "code", true),
    ]);
    expect(result.resources[0]).toMatchObject({
      spec: {
        capabilities: [
          { ref: "capability:20k21q9j9wexjv50", kind: "tools", tools: ["Writer", "read"] },
        ],
        toolApprovals: { Writer: "ask" },
      },
    });
  });

  it("unifies aliases while retaining selections, approvals, identities and shared Runtime config", async () => {
    const resources = [
      runtime,
      expert("1xddvess309a6gme", "Writer", "nv27faxmxpqnxwqr"),
      expert("3sfd30h5017wd17d", "Reviewer", "20k21q9j9wexjv50"),
      capability("nv27faxmxpqnxwqr"),
      capability("20k21q9j9wexjv50", "code", true),
      capability("kqh4nx7rx26mb3e7", "aone-km"),
    ];
    const original = structuredClone(resources);
    const normalized = await normalizeHostBoundResources(resources, {
      capabilityName: async (id) => id,
    });
    expect(resources).toEqual(original);
    expect(
      normalized.resources
        .filter((r) => r.kind === "Capability")
        .map((r) => [r.metadata.id, r.metadata.name]),
    ).toEqual([
      ["20k21q9j9wexjv50", "code"],
      ["kqh4nx7rx26mb3e7", "aone-km"],
    ]);
    expect(normalized.resources.find((r) => r.kind === "RuntimeProfile")).toEqual({
      ...runtime,
      metadata: { ...runtime.metadata, name: "Writer / Reviewer Runtime" },
    });
    const experts = normalized.resources.filter((r) => r.kind === "Expert");
    expect(experts.map((r) => r.spec.capabilities)).toEqual([
      [{ ref: "capability:20k21q9j9wexjv50", kind: "tools", tools: ["Writer"] }],
      [{ ref: "capability:20k21q9j9wexjv50", kind: "tools", tools: ["Reviewer"] }],
    ]);
    expect(experts.map((r) => r.spec.toolApprovals)).toEqual([
      { Writer: "ask" },
      { Reviewer: "ask" },
    ]);
    expect(
      (
        await normalizeHostBoundResources(normalized.resources, {
          capabilityName: async (id) => id,
        })
      ).resources,
    ).toEqual(normalized.resources);
  });

  it("refuses to merge differing configurations for the same Host capability", async () => {
    const first = capability("nv27faxmxpqnxwqr");
    const second = capability("20k21q9j9wexjv50");
    if (second.kind === "Capability") second.spec.config = { key: "code", extra: true };
    await expect(normalizeHostBoundResources([first, second])).rejects.toThrow(
      "conflicting configurations",
    );
  });

  it("keeps distinct Host identities and unavailable names without guessing", async () => {
    const resources = [
      capability("nv27faxmxpqnxwqr", "first"),
      capability("20k21q9j9wexjv50", "second"),
    ];
    expect((await normalizeHostBoundResources(resources)).resources).toEqual(resources);
  });
});
