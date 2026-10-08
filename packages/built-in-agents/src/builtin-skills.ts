import { createHash } from "node:crypto";
import { parsePragmaYaml } from "@pragma/interpreter";
import { PragmaCapabilityRefSchema, PragmaCapabilityResourceSchema } from "@pragma/interpreter/ast";
import { CapabilitySchema, SkillFilePathSchema } from "@pragma/shared";
import { BUILT_IN_AGENT_FILES } from "./builtin.generated.ts";

/** Single static authority used by Runtime materialization, the Agent index and Host read-only views. */
const BUILT_IN_SKILL_REFS = [
  PragmaCapabilityRefSchema.parse("capability:1h2j3k4m5n6p7q8r"),
  PragmaCapabilityRefSchema.parse("capability:000000000000f10w"),
] as const;

export const BUILT_IN_SKILLS = BUILT_IN_SKILL_REFS.map((ref) => {
  const id = ref.slice("capability:".length);
  const resource = PragmaCapabilityResourceSchema.parse(
    parsePragmaYaml(BUILT_IN_AGENT_FILES[`capabilities/${id}.pragma.yaml`]!),
  );
  const config = resource.spec.config as { source: { path: string } };
  const prefix = `${config.source.path}/`;
  const files = Object.fromEntries(
    Object.entries(BUILT_IN_AGENT_FILES)
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, source]) => [SkillFilePathSchema.parse(path.slice(prefix.length)), source]),
  );
  if (files["SKILL.md"] === undefined)
    throw new Error(`Built-in Skill ${resource.metadata.name} is missing SKILL.md.`);
  const contentHash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  return {
    id,
    ref,
    resource,
    name: resource.metadata.name,
    description: resource.metadata.description,
    version: 1,
    path: config.source.path,
    contentHash,
    files,
  };
});
export function builtInSkill(id: string) {
  return BUILT_IN_SKILLS.find((skill) => skill.id === id);
}

export function builtInSkillCapability(id: string) {
  const skill = builtInSkill(id);
  if (skill === undefined) return undefined;
  const timestamp = "1970-01-01T00:00:00.000Z";
  return CapabilitySchema.parse({
    managedBy: "system",
    manifest: {
      schemaVersion: "pragma.capability/v4",
      id: skill.id,
      runtimeKey: skill.path.split("/").at(-1)!.replaceAll("-", "_"),
      name: skill.name,
      kind: "skill",
      latestRevision: skill.version,
      activeRevision: skill.version,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    health: { revision: skill.version, status: "ready", checkedAt: timestamp },
    definition: {
      kind: "skill",
      name: skill.name,
      description: skill.description,
      entryPath: "SKILL.md",
      contentHash: skill.contentHash,
    },
  });
}
