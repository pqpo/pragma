import { derivePragmaResourceId } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
  DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
} from "@pragma/shared";
import {
  CURRENT_PRAGMA_DSL_API_VERSION,
  PragmaDslMigrationError,
  formatPragmaYaml,
  inspectPragmaProjectApiVersion,
  migratePragmaDslProjectToCurrent,
} from "../src/index.ts";

describe("Pragma DSL project migrations", () => {
  it("migrates a complete v2 project to the current DSL with one shared identity map", () => {
    const files = v2ProjectFiles();
    const original = new Map(files);

    const result = migratePragmaDslProjectToCurrent({ projectId: "studio", files });

    expect(result.sourceApiVersion).toBe("pragma/v2");
    expect(result.targetApiVersion).toBe(CURRENT_PRAGMA_DSL_API_VERSION);
    expect(result.migrated).toBe(true);
    expect(result.resources.map((resource) => resource.kind).toSorted()).toEqual(
      [
        "Automation",
        "Capability",
        "ContextStore",
        "Expert",
        "Expert",
        "ExpertTeam",
        "Flow",
        "RuntimeProfile",
      ].toSorted(),
    );
    expect(result.artifacts).toEqual(new Map([["skills/release/SKILL.md", "# Release\n"]]));
    expect(files).toEqual(original);

    const id = (kind: string, sourceId: string) =>
      derivePragmaResourceId(`studio\0${kind}\0${sourceId}`);
    const writerId = id("Expert", "writer");
    const reviewerId = id("Expert", "reviewer");
    const runtimeId = id("RuntimeProfile", "runtime");
    const capabilityId = id("Capability", "repo");
    const contextId = id("ContextStore", "notes");
    const teamId = id("ExpertTeam", "delivery");
    const flowId = id("Flow", "release");

    const writer = result.resources.find(
      (resource) => resource.kind === "Expert" && resource.metadata.id === writerId,
    );
    expect(writer).toMatchObject({
      apiVersion: "pragma/v4",
      metadata: { avatarId: DEFAULT_PRAGMA_EXPERT_AVATAR_ID },
      spec: {
        runtime: { ref: `runtime-profile:${runtimeId}` },
        capabilities: [{ ref: `capability:${capabilityId}` }],
        contextStores: [{ ref: `context-store:${contextId}` }],
      },
    });
    const team = result.resources.find((resource) => resource.kind === "ExpertTeam");
    expect(team).toMatchObject({
      metadata: { id: teamId, avatarId: DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID },
      spec: {
        coordinator: { ref: `expert:${writerId}` },
        members: [{ ref: `expert:${reviewerId}` }],
        delegation: {
          allow: { [writerId]: [reviewerId] },
          runtimes: { [reviewerId]: `runtime-profile:${runtimeId}` },
        },
      },
    });
    const flow = result.resources.find((resource) => resource.kind === "Flow");
    expect(flow).toMatchObject({
      metadata: { id: flowId },
      spec: {
        graph: {
          steps: {
            deliver: {
              team: { ref: `team:${teamId}` },
              runtimes: { [writerId]: `runtime-profile:${runtimeId}` },
            },
          },
        },
      },
    });
    if (flow?.kind !== "Flow") throw new Error("Expected migrated Flow.");
    expect(flow.spec.graph.steps["deliver"]).not.toHaveProperty("version");
    expect(result.identityMigrations).toHaveLength(8);
  });

  it("migrates a real v3 Expert and ExpertTeam to distinct default avatar IDs", () => {
    const files = v3ProjectFiles();
    const original = new Map(files);

    const result = migratePragmaDslProjectToCurrent({ projectId: "studio", files });

    expect(result).toMatchObject({
      sourceApiVersion: "pragma/v3",
      targetApiVersion: "pragma/v4",
      migrated: true,
      resources: [
        expect.objectContaining({
          apiVersion: "pragma/v4",
          kind: "Expert",
          metadata: expect.objectContaining({ avatarId: DEFAULT_PRAGMA_EXPERT_AVATAR_ID }),
        }),
        expect.objectContaining({
          apiVersion: "pragma/v4",
          kind: "ExpertTeam",
          metadata: expect.objectContaining({ avatarId: DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID }),
        }),
      ],
    });
    expect(files).toEqual(original);
  });

  it("returns a validated no-op for a current project", () => {
    const resource = currentCapability();
    const files = new Map([
      [
        "pragma.yaml",
        formatPragmaYaml({
          apiVersion: "pragma/v4",
          kind: "Bundle",
          imports: ["./capabilities/repo.pragma.yaml"],
          resources: [],
        }),
      ],
      ["capabilities/repo.pragma.yaml", formatPragmaYaml(resource)],
      ["pragma.lock.yaml", "apiVersion: pragma/v4\nkind: Lock\n"],
      ["README.md", "hello\n"],
    ]);

    expect(inspectPragmaProjectApiVersion(files)).toBe("pragma/v4");
    expect(migratePragmaDslProjectToCurrent({ projectId: "studio", files })).toMatchObject({
      sourceApiVersion: "pragma/v4",
      targetApiVersion: "pragma/v4",
      migrated: false,
      resources: [resource],
      identityMigrations: [],
    });
  });

  it("fails closed for mixed and future DSL versions", () => {
    const mixed = v2ProjectFiles();
    mixed.set("capabilities/current.pragma.yaml", formatPragmaYaml(currentCapability()));
    expect(() => inspectPragmaProjectApiVersion(mixed)).toThrow(
      expect.objectContaining<Partial<PragmaDslMigrationError>>({
        code: "mixed_api_versions",
      }),
    );

    const future = new Map([
      ["pragma.yaml", "apiVersion: pragma/v5\nkind: Bundle\nimports: []\nresources: []\n"],
    ]);
    expect(() => migratePragmaDslProjectToCurrent({ projectId: "studio", files: future })).toThrow(
      expect.objectContaining<Partial<PragmaDslMigrationError>>({
        code: "unsupported_api_version",
      }),
    );

    const unsupportedOld = new Map([
      ["pragma.yaml", "apiVersion: pragma/v1\nkind: Bundle\nimports: []\nresources: []\n"],
    ]);
    expect(() =>
      migratePragmaDslProjectToCurrent({ projectId: "studio", files: unsupportedOld }),
    ).toThrow(
      expect.objectContaining<Partial<PragmaDslMigrationError>>({
        code: "missing_migration_step",
      }),
    );
  });

  it("rejects duplicate legacy versions, normalized names, and unresolved references", () => {
    const duplicate = v2ProjectFiles();
    duplicate.set("expert/writer-copy.pragma.yaml", duplicate.get("expert/writer.pragma.yaml")!);
    expect(() =>
      migratePragmaDslProjectToCurrent({ projectId: "studio", files: duplicate }),
    ).toThrow(
      expect.objectContaining<Partial<PragmaDslMigrationError>>({
        code: "identity_conflict",
      }),
    );

    const names = v2ProjectFiles();
    const reviewer = parseJsonClone(v2Resources().find((resource) => resource.kind === "Expert")!);
    reviewer.metadata.id = "another-writer";
    reviewer.metadata.name = "  WRITER  ";
    names.set("expert/name-conflict.pragma.yaml", formatPragmaYaml(reviewer));
    expect(() => migratePragmaDslProjectToCurrent({ projectId: "studio", files: names })).toThrow(
      expect.objectContaining<Partial<PragmaDslMigrationError>>({
        code: "name_conflict",
      }),
    );

    const unresolved = v2ProjectFiles();
    const writer = parseJsonClone(
      v2Resources().find(
        (resource) => resource.kind === "Expert" && resource.metadata.id === "writer",
      )!,
    );
    (
      writer.spec["runtime"] as {
        ref: string;
      }
    ).ref = "runtime-profile:missing@1.0.0";
    unresolved.set("expert/writer.pragma.yaml", formatPragmaYaml(writer));
    expect(() =>
      migratePragmaDslProjectToCurrent({ projectId: "studio", files: unresolved }),
    ).toThrow(
      expect.objectContaining<Partial<PragmaDslMigrationError>>({
        code: "unresolved_reference",
      }),
    );
  });
});

function v2ProjectFiles(): Map<string, string> {
  const resources = v2Resources();
  return new Map([
    [
      "pragma.yaml",
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "Bundle",
        imports: resources.map(
          (resource) => `./${resource.kind.toLowerCase()}/${resource.metadata.id}.pragma.yaml`,
        ),
        resources: [],
      }),
    ],
    ...resources.map(
      (resource) =>
        [
          `${resource.kind.toLowerCase()}/${resource.metadata.id}.pragma.yaml`,
          formatPragmaYaml(resource),
        ] as const,
    ),
    ["pragma.lock.yaml", "apiVersion: pragma/v2\nkind: Lock\n"],
    ["skills/release/SKILL.md", "# Release\n"],
  ]);
}

function v3ProjectFiles(): Map<string, string> {
  const expert = {
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      name: "Historical Expert",
      description: "Written by pragma/v3.",
      tags: [],
    },
    spec: {
      scope: "Coordinate delivery.",
      instructions: "Delegate deliberately.",
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
  const team = {
    apiVersion: "pragma/v3",
    kind: "ExpertTeam",
    metadata: {
      id: "vyv9pwwzaksth2dd",
      name: "Historical Team",
      description: "Written by pragma/v3.",
      tags: [],
    },
    spec: {
      coordinator: { ref: "expert:1xddvess309a6gme" },
      members: [{ ref: "expert:1xddvess309a6gme" }],
      contextStores: [],
      delegation: {
        maxConcurrency: 4,
        maxDepth: 3,
        context: "context-policy:pragma.fresh@v1",
        runtimes: {},
      },
    },
  };
  return new Map([
    [
      "pragma.yaml",
      formatPragmaYaml({
        apiVersion: "pragma/v3",
        kind: "Bundle",
        imports: [],
        resources: [expert, team],
      }),
    ],
    ["pragma.lock.yaml", "apiVersion: pragma/v3\nkind: Lock\n"],
  ]);
}

interface LegacyResourceFixture {
  apiVersion: string;
  kind: string;
  metadata: {
    id: string;
    version: string;
    name: string;
    description: string;
    tags: string[];
  };
  spec: Record<string, unknown>;
}

function v2Resources(): LegacyResourceFixture[] {
  const metadata = (id: string, name: string) => ({
    id,
    version: "1.0.0",
    name,
    description: `${name} description`,
    tags: [],
  });
  return [
    {
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: metadata("repo", "Repository"),
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: "binding:repository",
        config: { key: "repository" },
      },
    },
    {
      apiVersion: "pragma/v2",
      kind: "ContextStore",
      metadata: metadata("notes", "Notes"),
      spec: { adapter: "pragma.context.static@v1", config: { entries: [] } },
    },
    {
      apiVersion: "pragma/v2",
      kind: "RuntimeProfile",
      metadata: metadata("runtime", "Runtime"),
      spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
    },
    {
      apiVersion: "pragma/v2",
      kind: "Expert",
      metadata: metadata("writer", "Writer"),
      spec: {
        scope: "Write releases.",
        instructions: "Be concise.",
        runtime: { ref: "runtime-profile:runtime@1.0.0" },
        capabilities: [{ ref: "capability:repo@1.0.0", kind: "tools", tools: ["read_file"] }],
        toolApprovals: {},
        contextStores: [{ ref: "context-store:notes@1.0.0", namespace: "notes", required: false }],
        plugins: [],
        tools: [],
      },
    },
    {
      apiVersion: "pragma/v2",
      kind: "Expert",
      metadata: metadata("reviewer", "Reviewer"),
      spec: {
        scope: "Review releases.",
        instructions: "Check accuracy.",
        runtime: { ref: "runtime-profile:runtime@1.0.0" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    },
    {
      apiVersion: "pragma/v2",
      kind: "ExpertTeam",
      metadata: metadata("delivery", "Delivery"),
      spec: {
        coordinator: { ref: "expert:writer@1.0.0" },
        members: [{ ref: "expert:reviewer@1.0.0" }],
        delegation: {
          allow: { writer: ["reviewer"] },
          maxConcurrency: 2,
          maxDepth: 2,
          context: "context-policy:pragma.fresh@v1",
          runtimes: { reviewer: "runtime-profile:runtime@1.0.0" },
        },
      },
    },
    {
      apiVersion: "pragma/v2",
      kind: "Flow",
      metadata: metadata("release", "Release"),
      spec: {
        limits: { maxNodeVisits: 10 },
        graph: {
          start: "deliver",
          steps: {
            deliver: {
              team: { ref: "team:delivery@1.0.0" },
              prompt: { segments: [{ text: "Prepare a release." }] },
              runtimes: { writer: "runtime-profile:runtime@1.0.0" },
              version: "1.0.0",
            },
          },
          loops: {},
          transitions: { deliver: { end: true } },
        },
      },
    },
    {
      apiVersion: "pragma/v2",
      kind: "Automation",
      metadata: metadata("daily", "Daily release"),
      spec: {
        adapter: "pragma.automation.schedule@v1",
        binding: "binding:desktop-automation",
        config: {
          trigger: {
            kind: "calendar",
            frequency: "daily",
            time: "09:00",
            timezone: "UTC",
          },
        },
        enabled: true,
        route: {
          executor: { ref: "flow:release@1.0.0" },
          input: { kind: "flow", value: {} },
        },
        interaction: { mode: "new-mission" },
        delivery: { adapter: "pragma.automation.delivery.local@v1" },
      },
    },
  ];
}

function currentCapability() {
  return {
    apiVersion: "pragma/v4" as const,
    kind: "Capability" as const,
    metadata: {
      id: "1h2j3k4m5n6p7q8r",
      name: "Repository",
      description: "Repository tools.",
      tags: [],
    },
    spec: {
      adapter: "pragma.capability.host@v1" as const,
      binding: "binding:repository" as const,
      config: { key: "repository" },
    },
  };
}

function parseJsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
