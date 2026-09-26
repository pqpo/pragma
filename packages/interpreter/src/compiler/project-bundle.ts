import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  PragmaForwardCompatibleResourceSchema,
  type PragmaResource,
  type PragmaSemanticResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import {
  createDefaultPragmaResourceAdapterRegistry,
  type PragmaResourceAdapterRegistry,
} from "../runtime/resource-adapters.ts";
import { sha256, stableStringify } from "./compiler-hash.ts";
import { type PragmaBundleRequirement } from "../ast/pragma-bundle.schema.ts";
import { type IndexedResource, PragmaDslError } from "./project-contracts.ts";
import { canonicalRef, isDeclarativeResource } from "./project-dependencies.ts";
import { hashArtifactPath } from "./project-environment.ts";

const PRAGMA_BUNDLE_BINDING_PREFIX = "binding:pragma.bundle." as const;

interface PortableBundleRequirementDraft {
  readonly requirement: PragmaBundleRequirement;
  readonly originalBindingRef?: string | undefined;
}

export function portableizeBundleResources(
  resources: ReadonlyMap<string, IndexedResource>,
  configuredAdapters: PragmaResourceAdapterRegistry | undefined,
): {
  readonly resources: readonly PragmaResource[];
  readonly requirements: readonly PortableBundleRequirementDraft[];
} {
  const adapters = configuredAdapters ?? createDefaultPragmaResourceAdapterRegistry();
  const requirements: PortableBundleRequirementDraft[] = [];
  const output = [...resources.values()]
    .toSorted((left, right) =>
      canonicalRef(left.resource).localeCompare(canonicalRef(right.resource)),
    )
    .map((indexed) => {
      const resource = structuredClone(indexed.resource);
      const ownerRef = canonicalRef(resource);
      const spec = resource.spec as unknown as Record<string, unknown>;
      if (isDeclarativeResource(resource)) {
        const binding = typeof spec["binding"] === "string" ? spec["binding"] : undefined;
        if (binding !== undefined) {
          const path = ["spec", "binding"] as const;
          const requirement = createBundleRequirement({
            kind: "binding",
            ownerRef,
            path,
            contract: resource.spec.adapter,
            name: `${resource.metadata.name} binding`,
            hints: { adapter: resource.spec.adapter },
          });
          spec["binding"] = bundleBindingSlot(requirement.id);
          requirements.push({ requirement, originalBindingRef: binding });
        }
        for (const source of adapters.artifactSources(resource)) {
          if (source.type === "project") continue;
          requirements.push({
            requirement: createBundleRequirement({
              kind: "external-artifact",
              ownerRef,
              path: ["spec", "config"],
              contract: source.integrity,
              name: `${resource.metadata.name} external artifact`,
              hints: { uri: source.uri, integrity: source.integrity },
            }),
          });
        }
        if (resource.kind === "RuntimeProfile") {
          const config = spec["config"] as Record<string, unknown>;
          requirements.push({
            requirement: createBundleRequirement({
              kind: "runtime",
              ownerRef,
              path: ["spec", "config", "runtimeId"],
              contract: "pragma.runtime@v1",
              name: `${resource.metadata.name} runtime`,
              hints: { runtimeId: config["runtimeId"] },
            }),
          });
        }
      }
      if (resource.kind === "Expert") {
        const plugins = spec["plugins"] as Record<string, unknown>[];
        for (const [pluginIndex, plugin] of plugins.entries()) {
          const pluginRef = plugin["ref"] as string;
          requirements.push({
            requirement: createBundleRequirement({
              kind: "plugin",
              ownerRef,
              path: ["spec", "plugins", pluginIndex],
              contract: pluginRef,
              name: `${resource.metadata.name} plugin ${pluginRef}`,
              hints: { ref: pluginRef },
            }),
          });
          const secretBindings = plugin["secretBindings"] as Record<string, string> | undefined;
          if (secretBindings === undefined) continue;
          for (const [secretName, originalBindingRef] of Object.entries(secretBindings)) {
            const requirement = createBundleRequirement({
              kind: "secret",
              ownerRef,
              path: ["spec", "plugins", pluginIndex, "secretBindings", secretName],
              contract: `${pluginRef}:secret:${secretName}`,
              name: `${resource.metadata.name} secret ${secretName}`,
              hints: { plugin: pluginRef, secretName },
            });
            secretBindings[secretName] = bundleBindingSlot(requirement.id);
            requirements.push({ requirement, originalBindingRef });
          }
        }
      }
      return PragmaForwardCompatibleResourceSchema.parse(resource);
    });
  return { resources: output, requirements };
}

function createBundleRequirement(input: {
  readonly kind: PragmaBundleRequirement["kind"];
  readonly ownerRef: PragmaSemanticResourceRef;
  readonly path: readonly (string | number)[];
  readonly contract: string;
  readonly name: string;
  readonly hints: Readonly<Record<string, unknown>>;
}): PragmaBundleRequirement {
  const id = `req-${sha256(stableStringify(input)).slice(0, 24)}`;
  return {
    id,
    kind: input.kind,
    ownerRef: input.ownerRef,
    path: [...input.path],
    contract: input.contract,
    required: true,
    name: input.name,
    hints: { ...input.hints },
  };
}

export function bundleBindingSlot(requirementId: string): `binding:${string}` {
  return `${PRAGMA_BUNDLE_BINDING_PREFIX}${requirementId}`;
}

export function requirementLocationKey(
  kind: PragmaBundleRequirement["kind"],
  ownerRef: string,
  path: readonly (string | number)[],
): string {
  return stableStringify([kind, ownerRef, path]);
}

export function valueAtPath(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current;
}

export function findBundleBindingSlots(value: unknown): readonly {
  readonly value: string;
  readonly requirementId: string;
  readonly path: readonly (string | number)[];
}[] {
  const slots: {
    value: string;
    requirementId: string;
    path: (string | number)[];
  }[] = [];
  const visit = (current: unknown, path: (string | number)[]): void => {
    if (typeof current === "string" && current.startsWith(`${PRAGMA_BUNDLE_BINDING_PREFIX}req-`)) {
      slots.push({
        value: current,
        requirementId: current.slice(PRAGMA_BUNDLE_BINDING_PREFIX.length),
        path,
      });
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (typeof current !== "object" || current === null) return;
    for (const [key, entry] of Object.entries(current)) visit(entry, [...path, key]);
  };
  visit(value, []);
  return slots;
}

export async function collectResourceArtifacts(
  resources: ReadonlyMap<string, IndexedResource>,
  projectRoot: string,
  adapters: PragmaResourceAdapterRegistry,
): Promise<ReadonlyMap<string, string>> {
  const artifacts = new Map<string, string>();
  for (const indexed of resources.values()) {
    if (!isDeclarativeResource(indexed.resource)) continue;
    for (const source of adapters.artifactSources(indexed.resource)) {
      if (source.type === "project") {
        const absolute = await assertPathInsideRoot(projectRoot, resolve(projectRoot, source.path));
        artifacts.set(source.path, await hashArtifactPath(absolute));
      } else {
        artifacts.set(source.uri, source.integrity.slice("sha256:".length));
      }
    }
  }
  return artifacts;
}

export async function collectSelectedBundleArtifacts(
  resources: readonly PragmaResource[],
  projectRoot: string,
  adapters: PragmaResourceAdapterRegistry,
  files: Map<string, Uint8Array>,
  reservedPaths: ReadonlySet<string>,
): Promise<readonly { readonly source: string; readonly contentHash: string }[]> {
  const artifacts = new Map<string, string>();
  for (const resource of resources) {
    if (!isDeclarativeResource(resource)) continue;
    for (const source of adapters.artifactSources(resource)) {
      if (source.type === "project") {
        const absolute = await assertPathInsideRoot(projectRoot, resolve(projectRoot, source.path));
        artifacts.set(source.path, await hashArtifactPath(absolute));
        await collectArtifactFiles(absolute, source.path, projectRoot, files, reservedPaths);
      } else {
        artifacts.set(source.uri, source.integrity.slice("sha256:".length));
      }
    }
  }
  return [...artifacts]
    .map(([source, contentHash]) => ({ source, contentHash }))
    .toSorted((left, right) => left.source.localeCompare(right.source));
}

async function collectArtifactFiles(
  absolute: string,
  logicalPath: string,
  projectRoot: string,
  files: Map<string, Uint8Array>,
  reservedPaths: ReadonlySet<string>,
): Promise<void> {
  const safePath = await assertPathInsideRoot(projectRoot, absolute);
  const info = await lstat(safePath);
  if (info.isFile()) {
    const bundlePath = `project/${logicalPath.replaceAll("\\", "/")}`;
    if (reservedPaths.has(bundlePath)) {
      throw new PragmaDslError(
        `Project artifact collides with a generated bundle file: ${logicalPath}.`,
      );
    }
    files.set(bundlePath, new Uint8Array(await readFile(safePath)));
    return;
  }
  if (!info.isDirectory()) throw new Error(`Unsupported project artifact: ${logicalPath}`);
  for (const child of (await readdir(safePath)).toSorted()) {
    await collectArtifactFiles(
      resolve(safePath, child),
      `${logicalPath.replace(/\/$/, "")}/${child}`,
      projectRoot,
      files,
      reservedPaths,
    );
  }
}

async function assertPathInsideRoot(root: string, path: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  const child = relative(canonicalRoot, canonicalPath);
  if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return canonicalPath;
  throw new Error(`Project artifact escapes the project root: ${path}`);
}
