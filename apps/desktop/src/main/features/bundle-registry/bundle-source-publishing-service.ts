import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { BundleSourceKind } from "@pragma/shared";

import {
  BundleSourcePublicationPreparationSchema,
  BundleSourcePublicationResultSchema,
  bundleSourcePublicationSummary,
  type BundleSourcePublicationPreparation,
  type BundleSourcePublicationResult,
  type PrepareBundleSourcePublication,
  type PublishBundleSource,
} from "../../../shared/contracts/index.ts";
import type { PragmaBundleService } from "../bundles/pragma-bundle-service.ts";
import {
  readSystemGitIdentity,
  type DesktopBundleRegistrySourceService,
} from "./bundle-registry-source-service.ts";

export interface BundleSourcePublishingService {
  prepare(input: PrepareBundleSourcePublication): Promise<BundleSourcePublicationPreparation>;
  publish(input: PublishBundleSource): Promise<BundleSourcePublicationResult>;
}

export function createBundleSourcePublishingService(options: {
  readonly bundles: PragmaBundleService;
  readonly sources: DesktopBundleRegistrySourceService;
  readonly cacheRoot: string;
  readonly readGitIdentity?:
    (() => Promise<{ readonly name: string; readonly email: string }>) | undefined;
}): BundleSourcePublishingService {
  return {
    async prepare(input) {
      const [preview, identity] = await Promise.all([
        options.bundles.prepareExport(input),
        (options.readGitIdentity ?? readSystemGitIdentity)(),
      ]);
      const kind = bundleSourceKind(preview.root.kind);
      const sources = await options.sources.preparePublicationSources(kind, preview.root.ref);
      const existing = sources.find((source) => source.existingItem !== undefined)?.existingItem;
      return BundleSourcePublicationPreparationSchema.parse({
        root: {
          ref: preview.root.ref,
          kind,
          name: preview.root.name,
          description: preview.root.description,
        },
        projectRevision: preview.projectRevision,
        modules: preview.defaults,
        moduleCounts: {
          capabilities: preview.capabilityCount,
          plugins: preview.pluginCount,
          knowledgeBases: preview.knowledgeBaseCount,
          flowLayouts: preview.hasFlowLayouts ? 1 : 0,
        },
        metadata: {
          itemId: sourceSlug(preview.root.name, preview.root.ref),
          name: existing?.name.default ?? preview.root.name,
          summary: bundleSourcePublicationSummary(preview.root.description),
          description: preview.root.description,
          authorName: existing?.author.name ?? identity.name,
          ...(existing?.author.url === undefined ? {} : { authorUrl: existing.author.url }),
          license: existing?.license ?? "UNLICENSED",
          ...(existing?.homepage === undefined ? {} : { homepage: existing.homepage }),
          tags: existing?.tags ?? [],
        },
        sources,
      });
    },
    async publish(input) {
      const temporaryRoot = join(options.cacheRoot, "generated");
      await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
      const publication = await mkdtemp(join(temporaryRoot, "publication-"));
      const bundlePath = join(publication, "bundle.pragma");
      try {
        const exported = await options.bundles.exportTo(
          {
            rootRef: input.rootRef,
            projectRevision: input.projectRevision,
            modules: input.modules,
          },
          bundlePath,
        );
        const kind = bundleSourceKind((await options.bundles.prepareExport(input)).root.kind);
        const results = await mapWithConcurrency(
          input.targets,
          3,
          async (target) =>
            await options.sources.publishBundleToSource({
              bundlePath,
              bundleFingerprint: exported.bundleFingerprint,
              rootRef: input.rootRef,
              kind,
              metadata: {
                ...input.metadata,
                summary: bundleSourcePublicationSummary(input.metadata.description),
              },
              target,
            }),
        );
        return BundleSourcePublicationResultSchema.parse({
          bundleFingerprint: exported.bundleFingerprint,
          results,
        });
      } finally {
        await rm(publication, { recursive: true, force: true });
      }
    },
  };
}

function bundleSourceKind(
  kind: "Expert" | "ExpertTeam" | "Flow" | "ContextStore",
): BundleSourceKind {
  return kind === "Expert"
    ? "expert"
    : kind === "ExpertTeam"
      ? "expert-team"
      : kind === "Flow"
        ? "flow"
        : "knowledge-base";
}

function sourceSlug(name: string, rootRef: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return slug === "" ? rootRef.split(":").at(-1)! : slug;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const run = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run));
  return results;
}
