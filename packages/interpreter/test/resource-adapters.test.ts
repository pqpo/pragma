import { PRAGMA_DSL_WRITE_API_VERSION } from "../src/ast/index.ts";
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
import type {
  PragmaArtifactSource,
  PragmaCapabilityResource,
  PragmaRuntimeProfileResource,
} from "../src/ast/index.ts";

describe("Pragma resource adapters", () => {
  it("rejects a mutable project artifact that changes after project loading", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-mutable-project-artifact-"));
    const artifact = join(root, "tool.js");
    await writeFile(artifact, "export default 'original';");
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml(codeResource({ type: "project", path: "tool.js" })),
    );
    const project = await loadPragmaProject(join(root, "pragma.yaml"));
    await writeFile(artifact, "export default 'changed';");

    const inspection = await project.inspectEnvironment({ workspace: root });

    expect(inspection.resources).toEqual([
      expect.objectContaining({
        status: "needs_attention",
        issues: [
          expect.objectContaining({
            message: expect.stringContaining("does not match its contentHash"),
          }),
        ],
      }),
    ]);
  });

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
    const outside = join(root, "outside");
    await mkdir(artifact);
    await mkdir(outside);
    await writeFile(join(outside, "entry.md"), "outside");
    await symlink(outside, join(artifact, "linked"), "junction");
    const resource: PragmaCapabilityResource = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Capability",
      metadata: {
        id: "j35188zs37g69g0n",
        name: "Unsafe Skill",
        description: "Tests entry containment.",
        tags: [],
      },
      spec: {
        adapter: "pragma.capability.skill@v1",
        config: { source: { type: "project", path: "artifact" }, entry: "linked/entry.md" },
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
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "qvt4k49db1vzrtfc",
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

  it("keeps Runtime model identity separate from provider credentials", async () => {
    const registry = createDefaultPragmaResourceAdapterRegistry();
    const resource = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "qvt4k49db1vzrtfc",
        name: "Runtime",
        description: "Bound runtime.",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "codex", providerId: "openai", model: "model" },
      },
    } satisfies PragmaRuntimeProfileResource;
    const inspection = await registry.inspect(resource, {
      ...host(async () => {
        throw new Error("unused");
      }),
    });
    expect(inspection.health).toMatchObject({
      status: "ready",
    });
    expect(inspection.contribution).toEqual({
      runtimeId: "codex",
      models: { default: { model: { providerId: "openai", modelId: "model" } } },
    });
  });

  it("hashes project artifacts as raw bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-binary-artifact-"));
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x61]);
    await writeFile(join(root, "artifact.bin"), bytes);
    await writeFile(
      join(root, "pragma.yaml"),
      formatPragmaYaml({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "ContextStore",
        metadata: {
          id: "w01fppfxrn31gf7v",
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
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Capability",
      metadata: {
        id: "jqys6d6fybxga4wb",
        name: "Opaque",
        description: "Opaque adapter config",
        tags: [],
      },
      spec: {
        adapter: "test.opaque@v1",
        config: { payload: { type: "project", path: "not-an-artifact.txt" } },
      },
    };
    expect(registry.validate(resource)).toEqual([]);
    expect(registry.artifactSources(resource)).toEqual([]);
  });

  it("rejects adapter reads of undeclared artifact dependencies", async () => {
    const source = { type: "project" as const, path: "hidden.txt" };
    let verifyCalled = false;
    const registry = new PragmaResourceAdapterRegistry().register({
      id: "test.undeclared",
      version: "v1",
      kind: "Capability",
      configSchema: z.object({}).strict(),
      async verify({ host: adapterHost }) {
        verifyCalled = true;
        await adapterHost.resolveArtifact(source);
        return { fingerprint: "a".repeat(64), contribution: {} };
      },
    });
    const resource: PragmaCapabilityResource = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Capability",
      metadata: {
        id: "sccvsbpxdrsxh7px",
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
    expect(verifyCalled).toBe(true);
    expect(inspection.health).toMatchObject({
      status: "needs_attention",
      issues: [expect.objectContaining({ message: expect.stringContaining("undeclared") })],
    });
  });
});

function codeResource(source: PragmaArtifactSource): PragmaCapabilityResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Capability",
    metadata: {
      id: "ygypdtr7bfev740a",
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
