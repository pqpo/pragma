import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { formatPragmaYaml, loadPragmaProject } from "@pragma/interpreter";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import {
  serializeSkillBundleFileManifest,
  serializeSkillBundleWorkingTree,
  type SkillBundleFile,
} from "@pragma/shared";

export async function createExpertBundle(
  root: string,
  outputPath = join(root, "reviewer.pragma"),
): Promise<string> {
  const projectPath = join(root, "project.yaml");
  await writeFile(
    projectPath,
    formatPragmaYaml({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Bundle",
      resources: [
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "RuntimeProfile",
          metadata: {
            id: "knr7p5b7qc55wv92",
            name: "Runtime",
            description: "Runtime",
            tags: [],
          },
          spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
        },
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Expert",
          metadata: {
            id: "1xddvess309a6gme",
            name: "Reviewer",
            description: "Reviews code",
            tags: ["review"],
          },
          spec: {
            scope: "review",
            instructions: "Review code.",
            runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
            capabilities: [],
            toolApprovals: {},
            contextStores: [],
            plugins: [],
            tools: [],
          },
        },
      ],
    }),
  );
  const project = await loadPragmaProject(projectPath);
  try {
    const exported = await project.exportBundle({ roots: ["expert:1xddvess309a6gme"] });
    await writeFile(outputPath, exported.bytes);
    return outputPath;
  } finally {
    await project.dispose();
  }
}

export async function createSkillBundle(
  root: string,
  options: {
    readonly includeUndeclaredFile?: boolean;
    readonly rootKind?: "expert" | "skill";
  } = {},
): Promise<string> {
  const capabilityId = "0123456789abcdef";
  const projectPath = join(root, "skill-project.yaml");
  const resource = {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Capability" as const,
    metadata: {
      id: capabilityId,
      name: "Review Skill",
      description: "Reviews code carefully.",
      tags: ["review"],
    },
    spec: {
      adapter: "pragma.capability.host@v1" as const,
      binding: "binding:portable-skill",
      config: { key: capabilityId },
    },
  };
  await writeFile(
    projectPath,
    formatPragmaYaml({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Bundle",
      resources: [
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "RuntimeProfile",
          metadata: {
            id: "knr7p5b7qc55wv92",
            name: "Runtime",
            description: "Runtime",
            tags: [],
          },
          spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
        },
        {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Expert",
          metadata: {
            id: "1xddvess309a6gme",
            name: "Reviewer",
            description: "Reviews code",
            tags: ["review"],
          },
          spec: {
            scope: "review",
            instructions: "Review code.",
            runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
            capabilities: [{ ref: `capability:${capabilityId}`, kind: "tools" }],
            toolApprovals: {},
            contextStores: [],
            plugins: [],
            tools: [],
          },
        },
        resource,
      ],
    }),
  );
  const skillDocument = new TextEncoder().encode(
    "---\nname: Review Skill\ndescription: Reviews code carefully.\n---\n\nReview code.\n",
  );
  const skillFile: SkillBundleFile = {
    path: "SKILL.md",
    sizeBytes: skillDocument.byteLength,
    sha256: sha256(skillDocument),
    executable: false,
  };
  const definition = {
    kind: "skill" as const,
    name: resource.metadata.name,
    description: resource.metadata.description,
    entryPath: "SKILL.md" as const,
    contentHash: sha256(serializeSkillBundleWorkingTree([skillFile])),
  };
  const skillFiles = new Map<string, Uint8Array>([["files/SKILL.md", skillDocument]]);
  const payloadFiles = new Map<string, Uint8Array>(skillFiles);
  if (options.includeUndeclaredFile === true) {
    payloadFiles.set("undeclared.json", new TextEncoder().encode("{}\n"));
  }
  payloadFiles.set(
    "descriptor.json",
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "pragma.skill-bundle-payload/v1",
        assetKey: capabilityId,
        name: definition.name,
        description: definition.description,
        entryPath: definition.entryPath,
        contentHash: definition.contentHash,
        filesFingerprint: sha256(serializeSkillBundleFileManifest([skillFile])),
        fingerprint: sha256(stableStringify(definition)),
        files: [skillFile],
      }),
    ),
  );
  const project = await loadPragmaProject(projectPath);
  const outputPath = join(root, "review-skill.pragma");
  try {
    const exported = await project.exportBundle({
      roots: [
        options.rootKind === "expert" ? "expert:1xddvess309a6gme" : `capability:${capabilityId}`,
      ],
      host: {
        exportPayload: async ({ requirement }) =>
          requirement.ownerRef === `capability:${capabilityId}`
            ? { codec: "pragma.skill@v1", files: payloadFiles }
            : undefined,
      },
    });
    await writeFile(outputPath, exported.bytes);
    return outputPath;
  } finally {
    await project.dispose();
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
