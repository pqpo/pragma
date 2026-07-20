import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  Expert,
  ExpertAgentManagedTool,
  ExpertAgentToolCallResult,
  RuntimeResolver,
  RuntimeModelSelection,
} from "@pragma/core";
import {
  loadPragmaProject,
  parsePragmaYaml,
  type CompiledResource,
  type PragmaAdapterHost,
  type PragmaBindingRecord,
} from "@pragma/interpreter";
import { PragmaExpertResourceSchema, type PragmaExpertResource } from "@pragma/interpreter/ast";

import { BUILT_IN_STEWARD_FILES } from "./builtin.generated.ts";

export const BUILT_IN_STEWARD_REF = "expert:steward@1.0.0" as const;

export function builtInStewardResource(): PragmaExpertResource {
  return PragmaExpertResourceSchema.parse(
    parsePragmaYaml(BUILT_IN_STEWARD_FILES["experts/steward@1.0.0.pragma.yaml"]!),
  );
}

export function builtInStewardFingerprint(): string {
  const hash = createHash("sha256");
  for (const [path, source] of Object.entries(BUILT_IN_STEWARD_FILES).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(path);
    hash.update("\0");
    hash.update(source);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function materializeBuiltInSteward(root: string): Promise<string> {
  const targetRoot = join(root, builtInStewardFingerprint());
  for (const [relativePath, source] of Object.entries(BUILT_IN_STEWARD_FILES)) {
    const target = join(targetRoot, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, source, { mode: 0o600 });
  }
  return join(targetRoot, "pragma.yaml");
}

export async function compileBuiltInSteward(options: {
  readonly definitionStateRoot: string;
  readonly workspace: string;
  readonly pragmaHome: string;
  readonly runtimes: RuntimeResolver;
  readonly defaultModelSelection?: RuntimeModelSelection | undefined;
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[];
}): Promise<CompiledResource<Expert>> {
  const entry = await materializeBuiltInSteward(options.definitionStateRoot);
  const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });
  return await project.compile<Expert>(BUILT_IN_STEWARD_REF, {
    workspace: options.workspace,
    pragmaHome: options.pragmaHome,
    environmentId: "desktop-system-expert",
    runtimes: options.runtimes,
    ...(options.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: options.defaultModelSelection }),
    adapterHost: stewardAdapterHost(dirname(entry), options.tools),
  });
}

function stewardAdapterHost(
  projectRoot: string,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
): PragmaAdapterHost {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          approval: tool.approval?.mode,
        })),
      ),
    )
    .digest("hex");
  return {
    environmentId: "desktop-system-expert",
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      return ref === "binding:pragma.steward-host"
        ? { ref, revision: "1", fingerprint, value: { contribution: { tools } } }
        : undefined;
    },
    async resolveArtifact(source) {
      throw new Error(`Unexpected external Steward artifact: ${JSON.stringify(source)}`);
    },
    async resolveSecret() {
      return undefined;
    },
  };
}
