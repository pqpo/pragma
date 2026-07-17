import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createDefaultPragmaResourceAdapterRegistry,
  formatPragmaYaml,
  loadPragmaProject,
  PragmaResourceAdapterRegistry,
  type PragmaAdapterHost,
} from "../src/index.ts";
import type { PragmaCapabilityResource, PragmaRuntimeProfileResource } from "../src/ast/index.ts";

describe("Pragma resource adapters", () => {
  it("reports mismatched external artifact bytes as needs_attention", async () => {
    const expected = sha256("expected");
    const source = {
      type: "registry" as const,
      uri: "registry://tools/example",
      integrity: `sha256:${expected}` as const,
    };
    const resource = codeResource(source);
    const inspection = await createDefaultPragmaResourceAdapterRegistry().inspect(
      resource,
      host(async () => ({ source, contentHash: expected, text: "tampered" })),
    );

    expect(inspection.contribution).toBeUndefined();
    expect(inspection.health).toMatchObject({
      status: "needs_attention",
      issues: [expect.objectContaining({ code: "environment.resource_unavailable" })],
    });
  });

  it("rejects an entry outside a Skill artifact even when reached through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-skill-entry-"));
    const artifact = join(root, "artifact");
    await mkdir(artifact);
    await writeFile(join(root, "outside.md"), "outside");
    await symlink(join(root, "outside.md"), join(artifact, "entry.md"));
    const resource: PragmaCapabilityResource = {
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: {
        id: "unsafe-skill",
        version: "1.0.0",
        name: "Unsafe Skill",
        description: "Tests entry containment.",
        tags: [],
      },
      spec: {
        adapter: "pragma.capability.skill@v1",
        config: { source: { type: "project", path: "artifact" }, entry: "entry.md" },
      },
    };
    const inspection = await createDefaultPragmaResourceAdapterRegistry().inspect(
      resource,
      host(async (source) => ({ source, contentHash: sha256("[]"), path: artifact })),
    );

    expect(inspection.health.status).toBe("needs_attention");
    expect(inspection.contribution).toBeUndefined();
  });

  it("requires a binding resolver to return the requested binding ref", async () => {
    const registry = createDefaultPragmaResourceAdapterRegistry();
    const resource = {
      apiVersion: "pragma/v2",
      kind: "RuntimeProfile",
      metadata: {
        id: "runtime",
        version: "1.0.0",
        name: "Runtime",
        description: "Bound runtime.",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        binding: "binding:model.provider",
        config: { runtimeId: "codex" },
      },
    } satisfies PragmaRuntimeProfileResource;
    const inspection = await registry.inspect(resource, {
      ...host(async () => {
        throw new Error("unused");
      }),
      async resolveBinding() {
        return {
          ref: "binding:different",
          revision: "1",
          fingerprint: "a".repeat(64),
          value: {},
        };
      },
    });
    expect(inspection.health.status).toBe("needs_attention");
  });

  it("reports a configured default model that the bound provider does not install", async () => {
    const registry = createDefaultPragmaResourceAdapterRegistry();
    const resource = {
      apiVersion: "pragma/v2",
      kind: "RuntimeProfile",
      metadata: {
        id: "runtime",
        version: "1.0.0",
        name: "Runtime",
        description: "Bound runtime.",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        binding: "binding:model.provider",
        config: { runtimeId: "codex", model: "missing-model" },
      },
    } satisfies PragmaRuntimeProfileResource;
    const inspection = await registry.inspect(resource, {
      ...host(async () => {
        throw new Error("unused");
      }),
      async resolveBinding(ref) {
        return {
          ref,
          revision: "1",
          fingerprint: "a".repeat(64),
          value: {
            provider: "provider",
            baseApi: "https://models.example.com/v1",
            modelNames: ["installed-model"],
            secretRef: "secret:model",
          },
        };
      },
    });
    expect(inspection.health).toMatchObject({
      status: "needs_attention",
      issues: [expect.objectContaining({ message: expect.stringContaining("missing-model") })],
    });
  });

  it("hashes project artifacts as raw bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-binary-artifact-"));
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]);
    await writeFile(join(root, "artifact.bin"), bytes);
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: "pragma/v2",
        kind: "ContextStore",
        metadata: {
          id: "binary",
          version: "1.0.0",
          name: "Binary",
          description: "Binary artifact hashing",
          tags: [],
        },
        spec: {
          adapter: "pragma.context.file@v1",
          config: { source: { type: "project", path: "artifact.bin" } },
        },
      }),
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"));
    expect(project.createLock().artifacts).toEqual([
      { source: "artifact.bin", contentHash: sha256(bytes) },
    ]);
  });

  it("only records artifact dependencies explicitly declared by an adapter", () => {
    const registry = new PragmaResourceAdapterRegistry().register({
      id: "test.opaque",
      version: "v1",
      kind: "Capability",
      configSchema: z.object({ payload: z.unknown() }).strict(),
      async verify() {
        return { fingerprint: "a".repeat(64), contribution: {} };
      },
    });
    const resource: PragmaCapabilityResource = {
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: {
        id: "opaque",
        version: "1.0.0",
        name: "Opaque",
        description: "Opaque adapter config",
        tags: [],
      },
      spec: {
        adapter: "test.opaque@v1",
        config: { payload: { type: "project", path: "not-an-artifact.txt" } },
      },
    };
    expect(registry.artifactSources(resource)).toEqual([]);
  });

  it("rejects adapter reads of undeclared artifact dependencies", async () => {
    const source = { type: "project" as const, path: "hidden.txt" };
    const registry = new PragmaResourceAdapterRegistry().register({
      id: "test.undeclared",
      version: "v1",
      kind: "Capability",
      configSchema: z.object({}).strict(),
      async verify({ host: adapterHost }) {
        await adapterHost.resolveArtifact(source);
        return { fingerprint: "a".repeat(64), contribution: {} };
      },
    });
    const resource: PragmaCapabilityResource = {
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: {
        id: "undeclared",
        version: "1.0.0",
        name: "Undeclared",
        description: "Undeclared artifact read",
        tags: [],
      },
      spec: { adapter: "test.undeclared@v1", config: {} },
    };
    const inspection = await registry.inspect(
      resource,
      host(async () => ({ source, contentHash: sha256("hidden"), text: "hidden" })),
    );
    expect(inspection.health).toMatchObject({
      status: "needs_attention",
      issues: [expect.objectContaining({ message: expect.stringContaining("undeclared") })],
    });
  });
});

function codeResource(source: {
  readonly type: "registry";
  readonly uri: string;
  readonly integrity: `sha256:${string}`;
}): PragmaCapabilityResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Capability",
    metadata: {
      id: "code",
      version: "1.0.0",
      name: "Code",
      description: "Code tool.",
      tags: [],
    },
    spec: {
      adapter: "pragma.capability.code@v1",
      config: {
        source,
        tool: {
          name: "run",
          description: "Run code.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          outputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    },
  };
}

function host(resolveArtifact: PragmaAdapterHost["resolveArtifact"]): PragmaAdapterHost {
  return {
    environmentId: "test",
    projectRoot: process.cwd(),
    resolveArtifact,
    async resolveBinding() {
      return undefined;
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
