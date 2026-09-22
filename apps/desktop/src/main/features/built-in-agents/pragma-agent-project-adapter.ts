import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type PragmaFlowRunDrySuiteResult } from "@pragma/evaluation/ast";
import {
  decodePragmaPathSegment,
  encodePragmaPathSegment,
  generatePragmaResourceId,
  withFileLock,
} from "@pragma/core";
import { formatPragmaYaml, parsePragmaYaml, runPragmaEvaluation } from "@pragma/interpreter";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaFlowRunDryEvaluationResourceSchema,
  PragmaForwardCompatibleResourceSchema,
  inspectPragmaUnknownFields,
  analyzePragmaFlowGraph,
  validatePragmaFlowDataContracts,
  PragmaFlowResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaDiagnostic,
  type PragmaFlowResource,
  type PragmaFlowRunDryEvaluationResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  PragmaAgentChangeSetSchema,
  PragmaAgentDslDraftInspectionSchema,
  PragmaAgentDslDraftReviewPageSchema,
  PragmaAgentDslDraftReviewSchema,
  PragmaAgentDslDraftSchema,
  PragmaAgentDslDraftSummarySchema,
  PragmaAgentEvaluationDraftRunResultSchema,
  PragmaAgentEvaluationDraftSchema,
  PragmaAgentEvaluationDraftSummarySchema,
  PragmaAgentExpertOptionCatalogSchema,
  PragmaAgentFlowDraftSchema,
  PragmaAgentPrepareResultSchema,
  PragmaAgentProjectCommitSchema,
  type PragmaAgentDslProjectPort,
  type PragmaAgentDslDraft,
  type PragmaAgentDslDraftReview,
  type PragmaAgentDslDraftReviewPage,
  type PragmaAgentDslDraftReviewSection,
  type PragmaAgentDslDraftTargetInput,
  type PragmaAgentEvaluationDraft,
  type PragmaAgentEvaluationDraftDiagnostic,
  type PragmaAgentEvaluationDraftOperation,
  type PragmaAgentExpertOptionCatalog,
  type PragmaAgentFlowDraft,
  type PragmaAgentFlowDraftDiagnostic,
  type PragmaAgentFlowDraftOperation,
  type PragmaAgentPrepareResult,
  type PragmaAgentProjectCommit,
} from "@pragma/built-in-agents";
import { BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES } from "@pragma/shared";
import { z } from "zod";

import type { Capability } from "../../../shared/contracts/index.ts";
import { parseDesktopCapabilityBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";
import {
  createDesktopCapabilityResource,
  createDesktopRuntimeOptionResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { listCapabilitiesWithBuiltIns } from "../capabilities/built-in-capabilities.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { getRuntimeAvailability } from "../runtimes/runtime-availability.ts";
import type { RuntimeEnvironmentService } from "../runtimes/runtime-environment-service.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { paginateManagementItems } from "./management-pagination.ts";
import { ensurePragmaWorkspaceGitExclude } from "../capabilities/skill-revision-workspace.ts";

const CandidateRecordSchema = z
  .object({
    changeSet: PragmaAgentChangeSetSchema,
    resources: z.array(PragmaForwardCompatibleResourceSchema),
    dslDraftId: z.string().uuid().optional(),
    dslDraftMissionId: z.string().uuid().optional(),
  })
  .refine(
    (value) => (value.dslDraftId === undefined) === (value.dslDraftMissionId === undefined),
    "A DSL draft candidate must carry both its draft and Mission identity.",
  );
type CandidateRecord = z.infer<typeof CandidateRecordSchema>;

const StoredDslDraftResourceSchema = PragmaAgentDslDraftSchema.shape.resources.element.extend({
  filePath: z.string().min(1).max(4_000),
  baseSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  initialSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  creationDescription: z.string().min(1).max(500).optional(),
});
const StoredDslDraftSchema = z
  .object({
    ...PragmaAgentDslDraftSchema.shape,
    workspacePath: z.string().min(1).max(4_000),
    resources: z.array(StoredDslDraftResourceSchema).min(1).max(50),
    submissionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict();
type StoredDslDraft = z.infer<typeof StoredDslDraftSchema>;

const DslDraftOwnerSchema = z
  .object({
    schemaVersion: z.literal("pragma.dsl-draft-owner/v1"),
    draftId: z.string().uuid(),
    missionId: z.string().uuid(),
    workspacePath: z.string().min(1).max(4_000),
    state: z.enum(["initializing", "ready"]),
  })
  .strict();
type DslDraftOwner = z.infer<typeof DslDraftOwnerSchema>;

const DslDraftRestartJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.dsl-draft-restart/v1"),
    sourceDraftId: z.string().uuid(),
    replacementDraftId: z.string().uuid(),
    missionId: z.string().uuid(),
    sourceSubmissionHash: z.string().regex(/^[a-f0-9]{64}$/u),
    state: z.enum(["initiated", "replacement_created", "completed"]),
    referencePath: z.string().min(1).max(4_000).optional(),
  })
  .strict()
  .refine(
    (value) => (value.state === "initiated") === (value.referencePath === undefined),
    "A created DSL draft restart replacement must include its reference path.",
  );
type DslDraftRestartJournal = z.infer<typeof DslDraftRestartJournalSchema>;

const DslDraftDiscardJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.dsl-draft-discard/v1"),
    draftId: z.string().uuid(),
    source: z.string().min(1).max(4_000),
    trash: z.string().min(1).max(4_000),
    submissionSource: z.string().min(1).max(4_000).optional(),
    submissionTrash: z.string().min(1).max(4_000).optional(),
    state: z.enum(["prepared", "completed"]),
  })
  .strict()
  .refine(
    (value) => (value.submissionSource === undefined) === (value.submissionTrash === undefined),
    "DSL draft discard journal submission paths must be paired.",
  );
type DslDraftDiscardJournal = z.infer<typeof DslDraftDiscardJournalSchema>;

const DslDraftCommitJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.dsl-draft-commit/v1"),
    draftId: z.string().uuid(),
    changeSetId: z.string().uuid(),
    operationId: z.string().min(1),
    state: z.enum(["initiated", "published", "cleanup_pending", "completed"]),
    result: PragmaAgentProjectCommitSchema.optional(),
  })
  .strict()
  .refine(
    (value) => (value.state === "initiated") === (value.result === undefined),
    "A published DSL draft commit journal must contain its Project result.",
  );
type DslDraftCommitJournal = z.infer<typeof DslDraftCommitJournalSchema>;

export function createDesktopPragmaAgentProjectPort(options: {
  readonly project: PragmaProjectStore;
  readonly stateRoot: string;
  readonly draftsRoot?: string | undefined;
  readonly draftsTrashRoot?: string | undefined;
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
  readonly systemExperts: Pick<DesktopSystemExpertRegistry, "list" | "get" | "getResource">;
}): PragmaAgentDslProjectPort {
  const candidatePath = (id: string) =>
    join(options.stateRoot, "change-sets", `${encodePragmaPathSegment(id)}.json`);
  const operationPath = (id: string) =>
    join(options.stateRoot, "operations", `${encodePragmaPathSegment(id)}.json`);
  const draftPath = (id: string) =>
    join(options.stateRoot, "dsl-drafts", `${encodePragmaPathSegment(id)}.json`);
  const evaluationDraftPath = (id: string) =>
    join(options.stateRoot, "evaluation-drafts", `${encodePragmaPathSegment(id)}.json`);
  const dslDraftsRoot = options.draftsRoot ?? join(options.stateRoot, "dsl-resource-drafts");
  const dslDraftsTrashRoot =
    options.draftsTrashRoot ?? join(options.stateRoot, "trash", "dsl-resource-drafts");
  const dslDraftRecordPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "draft.json");
  const dslDraftOwnerPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "owner.json");
  const dslDraftSubmissionsPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "submissions");
  const dslDraftDiscardJournalPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "discard.json");
  const dslDraftCommitJournalPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "commit.json");
  const dslDraftRestartJournalPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "restart.json");
  const dslDraftMutationLockPath = (id: string) =>
    join(dslDraftsRoot, ".locks", `${encodePragmaPathSegment(id)}.lock`);

  const planResources = async (input: {
    readonly expectedProjectRevision: number;
    readonly authoredResources: readonly PragmaResource[];
  }): Promise<{
    readonly snapshot: Awaited<ReturnType<PragmaProjectStore["get"]>>;
    readonly resources: readonly PragmaResource[];
    readonly dependencies: readonly PragmaResource[];
    readonly diagnostics: readonly PragmaDiagnostic[];
  }> => {
    const snapshot = await options.project.get();
    const authoredResources = [...input.authoredResources];
    const catalog = await buildExpertCatalog(options);
    const knownRefs = new Set([
      ...snapshot.resources.map(canonicalPragmaResourceRef),
      ...authoredResources.map(canonicalPragmaResourceRef),
    ]);
    const dependencies = authoredResources
      .filter((resource): resource is PragmaExpertResource => resource.kind === "Expert")
      .flatMap(expertDependencyRefs)
      .flatMap((ref) => {
        if (knownRefs.has(ref)) return [];
        const dependency = catalog.resources.get(ref);
        if (dependency === undefined) return [];
        knownRefs.add(ref);
        return [dependency];
      });
    const requestedResources = [...authoredResources, ...dependencies];
    const refs = requestedResources.map(canonicalPragmaResourceRef);
    if (new Set(refs).size !== refs.length) {
      throw new DslPreparationError("resource.duplicate", "A change-set cannot repeat a ref.");
    }
    assertExpertSelectionsAvailable(
      authoredResources,
      snapshot.resources,
      requestedResources,
      catalog,
    );
    const preview = await options.project.previewChanges({
      baseRevision: input.expectedProjectRevision,
      upserts: requestedResources,
    });
    return {
      snapshot,
      resources: preview.upserts,
      dependencies,
      diagnostics: preview.diagnostics,
    };
  };

  const prepareResources = async (input: {
    readonly expectedProjectRevision: number;
    readonly authoredResources: readonly PragmaResource[];
    readonly dslDraftId?: string | undefined;
    readonly dslDraftMissionId?: string | undefined;
    readonly draftReview?:
      | {
          readonly draft: StoredDslDraft;
          readonly rawResources: readonly unknown[];
        }
      | undefined;
  }): Promise<PragmaAgentPrepareResult> => {
    const authoredResources = [...input.authoredResources];
    const actionDiagnostics = authoredResources.flatMap((resource) =>
      resource.kind !== "Flow"
        ? []
        : Object.entries(resource.spec.graph.steps).flatMap(([stepId, step]) =>
            step.action === undefined
              ? []
              : [
                  {
                    severity: "error" as const,
                    code: "environment.flow_action_unavailable",
                    message: "Action steps are not executable in the current Desktop environment.",
                    path: ["spec", "graph", "steps", stepId, "action"],
                  },
                ],
          ),
    );
    if (actionDiagnostics.length > 0) {
      return PragmaAgentPrepareResultSchema.parse({
        status: "invalid",
        diagnostics: actionDiagnostics,
      });
    }
    try {
      const plan = await planResources(input);
      const { dependencies, diagnostics, resources, snapshot } = plan;
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return PragmaAgentPrepareResultSchema.parse({ status: "invalid", diagnostics });
      }
      const existing = new Set(snapshot.resources.map(canonicalPragmaResourceRef));
      const review =
        input.draftReview === undefined
          ? undefined
          : createDslDraftReview(
              analyzeDslDraftReview({
                draft: input.draftReview.draft,
                baseResources: (
                  await options.project.getRevision(input.draftReview.draft.baseProjectRevision)
                ).resources,
                rawResources: input.draftReview.rawResources,
                authoredResources,
                effectiveResources: resources.slice(0, authoredResources.length),
                diagnostics,
                dependencies,
                effectivePreviewAvailable: true,
              }),
            );
      const changeSet = PragmaAgentChangeSetSchema.parse({
        changeSetId: randomUUID(),
        projectRevision: input.expectedProjectRevision,
        diagnostics,
        changes: resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: existing.has(canonicalPragmaResourceRef(resource)) ? "updated" : "created",
          source: formatPragmaYaml(resource),
        })),
        ...(review === undefined ? {} : { review }),
        createdAt: new Date().toISOString(),
      });
      await writeJson(candidatePath(changeSet.changeSetId), {
        changeSet,
        resources,
        ...(input.dslDraftId === undefined ? {} : { dslDraftId: input.dslDraftId }),
        ...(input.dslDraftMissionId === undefined
          ? {}
          : { dslDraftMissionId: input.dslDraftMissionId }),
      });
      return PragmaAgentPrepareResultSchema.parse({ status: "prepared", changeSet });
    } catch (error) {
      return PragmaAgentPrepareResultSchema.parse({
        status: "invalid",
        diagnostics: diagnosticsFromError(error),
      });
    }
  };

  const prepareSources = async (input: {
    readonly expectedProjectRevision: number;
    readonly sources: readonly string[];
  }): Promise<PragmaAgentPrepareResult> => {
    const parsed = parsePragmaAgentSources(input.sources);
    if (parsed.diagnostics.length > 0) {
      return PragmaAgentPrepareResultSchema.parse({
        status: "invalid",
        diagnostics: parsed.diagnostics,
      });
    }
    if (parsed.resources.some((resource) => resource.kind === "Evaluation")) {
      return invalidPrepare(
        "evaluation.independent_prepare_required",
        "Evaluation resources must be authored with Evaluation draft tools and prepared through prepare_evaluation_draft.",
      );
    }
    return await prepareResources({
      expectedProjectRevision: input.expectedProjectRevision,
      authoredResources: parsed.resources,
    });
  };

  const validateCandidateForCommit = async (candidate: CandidateRecord): Promise<void> => {
    const snapshot = await options.project.get();
    const catalog = await buildExpertCatalog(options);
    assertExpertSelectionsAvailable(
      candidate.resources,
      snapshot.resources,
      candidate.resources,
      catalog,
    );
  };

  const publishCandidate = async (
    candidate: CandidateRecord,
  ): Promise<PragmaAgentProjectCommit> => {
    const change = {
      baseRevision: candidate.changeSet.projectRevision,
      upserts: candidate.resources,
    };
    const published =
      candidate.dslDraftId === undefined
        ? await options.project.apply(change)
        : await options.project.applyTransactional(change, candidate.changeSet.changeSetId);
    return PragmaAgentProjectCommitSchema.parse({
      projectId: published.projectId,
      projectRevision: published.revision,
      changedRefs: candidate.changeSet.changes.map((change) => change.ref),
    });
  };

  const readDslDraftRecord = async (draftId: string): Promise<StoredDslDraft> =>
    StoredDslDraftSchema.parse(
      JSON.parse(await readFile(dslDraftRecordPath(draftId), "utf8")) as unknown,
    );

  const writeDslDraft = async (draft: StoredDslDraft): Promise<void> =>
    await writeJson(dslDraftRecordPath(draft.draftId), StoredDslDraftSchema.parse(draft));

  const moveDslDraftPathToTrash = async (source: string, trash: string): Promise<void> => {
    await mkdir(dirname(trash), { recursive: true, mode: 0o700 });
    try {
      await rename(source, trash);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST" || code === "ENOTEMPTY") {
        // A cross-device copy may have completed before the process crashed and
        // removed the source. Treat that destination as an incomplete replay,
        // rebuild it from the still-authoritative source, then continue.
        await rm(trash, { recursive: true, force: true });
        await moveDslDraftPathToTrash(source, trash);
        return;
      }
      if (code === "EXDEV") {
        try {
          await cp(source, trash, { recursive: true, errorOnExist: true });
        } catch (copyError) {
          const copyCode = (copyError as NodeJS.ErrnoException).code;
          if (copyCode !== "EEXIST" && copyCode !== "ENOTEMPTY") throw copyError;
          await rm(trash, { recursive: true, force: true });
          await cp(source, trash, { recursive: true, errorOnExist: true });
        }
        await rm(source, { recursive: true, force: true });
      } else if (code !== "ENOENT") {
        throw error;
      }
    }
  };

  const replayDslDraftDiscard = async (draftId: string): Promise<void> => {
    const journalPath = dslDraftDiscardJournalPath(draftId);
    let journal: DslDraftDiscardJournal;
    try {
      journal = DslDraftDiscardJournalSchema.parse(
        JSON.parse(await readFile(journalPath, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (journal.draftId !== draftId)
      throw new Error("DSL draft discard journal identity mismatch.");
    const draft = await readDslDraftRecord(draftId);
    const expectedSource = join(draft.workspacePath, ".pragma", "dsl-drafts", draft.draftId);
    const expectedSubmissionSource = dslDraftSubmissionsPath(draft.draftId);
    const trashName = relative(resolve(dslDraftsTrashRoot), resolve(journal.trash));
    if (
      resolve(journal.source) !== resolve(expectedSource) ||
      isAbsolute(trashName) ||
      trashName.includes(sep) ||
      !trashName.startsWith(`${draftId}-`)
    ) {
      throw new Error("DSL draft discard journal contains an invalid path.");
    }
    if (
      journal.submissionSource !== undefined &&
      (resolve(journal.submissionSource) !== resolve(expectedSubmissionSource) ||
        resolve(journal.submissionTrash!) !==
          resolve(join(journal.trash, "authoritative-submissions")))
    ) {
      throw new Error("DSL draft discard journal contains an invalid submission path.");
    }
    if (journal.state === "prepared") {
      await makeTreeWritableForCleanup(journal.source);
      await moveDslDraftPathToTrash(journal.source, journal.trash);
      if (journal.submissionSource !== undefined) {
        await moveDslDraftPathToTrash(journal.submissionSource, journal.submissionTrash!);
      }
      journal = DslDraftDiscardJournalSchema.parse({ ...journal, state: "completed" });
      await writeJson(journalPath, journal);
    }
    if (draft.state !== "discarded") {
      if (draft.state === "committed") {
        throw new Error("A committed DSL draft cannot be discarded.");
      }
      await writeDslDraft(
        StoredDslDraftSchema.parse({
          ...draft,
          state: "discarded",
          submissionHash: undefined,
          updatedAt: new Date().toISOString(),
        }),
      );
    }
  };

  const recoverDslDraftDiscard = async (draftId: string): Promise<void> => {
    await withFileLock(`${dslDraftDiscardJournalPath(draftId)}.lock`, async () => {
      await replayDslDraftDiscard(draftId);
    });
  };

  const findPublishedCandidate = async (
    candidate: CandidateRecord,
  ): Promise<PragmaAgentProjectCommit | undefined> => {
    const snapshot = await options.project.findRevisionByPublicationId(
      candidate.changeSet.changeSetId,
    );
    return snapshot === undefined
      ? undefined
      : PragmaAgentProjectCommitSchema.parse({
          projectId: snapshot.projectId,
          projectRevision: snapshot.revision,
          changedRefs: candidate.changeSet.changes.map((change) => change.ref),
        });
  };

  const readDslDraftCommitJournal = async (
    draftId: string,
  ): Promise<DslDraftCommitJournal | undefined> => {
    try {
      return DslDraftCommitJournalSchema.parse(
        JSON.parse(await readFile(dslDraftCommitJournalPath(draftId), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const replayDslDraftCommit = async (
    draftId: string,
    publicationMode: "recover" | "publish" = "recover",
  ): Promise<DslDraftCommitJournal | undefined> => {
    let journal = await readDslDraftCommitJournal(draftId);
    if (journal === undefined) return undefined;
    if (journal.draftId !== draftId) throw new Error("DSL draft commit journal identity mismatch.");
    if (journal.state === "completed") return journal;
    const candidate = await readCandidate(candidatePath(journal.changeSetId));
    if (
      candidate.dslDraftId !== draftId ||
      candidate.changeSet.changeSetId !== journal.changeSetId
    ) {
      throw new Error("DSL draft commit journal does not match its prepared change-set.");
    }
    if (journal.state === "initiated") {
      let result =
        publicationMode === "recover" ? await findPublishedCandidate(candidate) : undefined;
      if (result === undefined) {
        try {
          result = await publishCandidate(candidate);
        } catch (error) {
          if ((error as { readonly code?: string }).code === "revision_conflict") {
            await rm(dslDraftCommitJournalPath(draftId), { force: true });
          }
          throw error;
        }
      }
      journal = DslDraftCommitJournalSchema.parse({
        ...journal,
        state: "published",
        result,
      });
      await writeJson(dslDraftCommitJournalPath(draftId), journal);
    }
    const result = journal.result!;
    const publishedSnapshot = await options.project.getRevision(result.projectRevision);
    const publishedResources = new Map(
      publishedSnapshot.resources.map((resource) => [
        canonicalPragmaResourceRef(resource),
        resource,
      ]),
    );
    const expectedChangedRefs = candidate.changeSet.changes.map((change) => change.ref);
    if (
      result.projectId !== publishedSnapshot.projectId ||
      result.projectRevision <= candidate.changeSet.projectRevision ||
      result.changedRefs.length !== expectedChangedRefs.length ||
      result.changedRefs.some((ref, index) => ref !== expectedChangedRefs[index]) ||
      candidate.resources.some((resource) => {
        const published = publishedResources.get(canonicalPragmaResourceRef(resource));
        return (
          published === undefined ||
          sha256(formatPragmaYaml(published)) !== sha256(formatPragmaYaml(resource))
        );
      })
    ) {
      throw new Error("DSL draft commit journal result does not match its Project revision.");
    }
    const draft = await readDslDraftRecord(draftId);
    if (
      draft.state === "prepared" &&
      draft.preparedChangeSetId === candidate.changeSet.changeSetId
    ) {
      await writeDslDraft(
        StoredDslDraftSchema.parse({
          ...draft,
          state: "committed",
          submissionHash: undefined,
          committedProjectRevision: result.projectRevision,
          updatedAt: new Date().toISOString(),
        }),
      );
    } else if (
      draft.state !== "committed" ||
      draft.preparedChangeSetId !== candidate.changeSet.changeSetId ||
      draft.committedProjectRevision !== result.projectRevision
    ) {
      throw new Error("DSL draft commit recovery found an incompatible draft state.");
    }
    await writeJson(operationPath(journal.operationId), result);
    try {
      journal = DslDraftCommitJournalSchema.parse({ ...journal, state: "cleanup_pending" });
      await writeJson(dslDraftCommitJournalPath(draftId), journal);
      await makeTreeWritableForCleanup(
        join(draft.workspacePath, ".pragma", "dsl-drafts", draft.draftId),
      );
      await Promise.all([
        rm(dslDraftSubmissionsPath(draftId), { recursive: true, force: true }),
        rm(join(draft.workspacePath, ".pragma", "dsl-drafts", draft.draftId), {
          recursive: true,
          force: true,
        }),
      ]);
      journal = DslDraftCommitJournalSchema.parse({ ...journal, state: "completed" });
      await writeJson(dslDraftCommitJournalPath(draftId), journal);
    } catch {
      // Publication, draft state, and the idempotency receipt are already durable.
      // Keep cleanup_pending for best-effort maintenance on a later read.
    }
    return journal;
  };

  const readDslDraftLocked = async (draftId: string): Promise<StoredDslDraft> => {
    await replayDslDraftCommit(draftId);
    await recoverDslDraftRestart(draftId);
    await recoverDslDraftDiscard(draftId);
    const draft = await readDslDraftRecord(draftId);
    if (draft.state === "editing") {
      await recoverInterruptedDslDraftPrepare(draft, dslDraftSubmissionsPath(draftId));
    }
    return draft;
  };

  const readDslDraft = async (draftId: string): Promise<StoredDslDraft> =>
    await withFileLock(
      dslDraftMutationLockPath(draftId),
      async () => await readDslDraftLocked(draftId),
    );

  const requireDslDraftOwner = (draft: StoredDslDraft, missionId: string | undefined): void => {
    if (missionId === undefined || draft.missionId !== missionId) {
      throw new Error("DSL draft is owned by another Mission.");
    }
  };

  const toPublicDslDraft = (draft: StoredDslDraft): PragmaAgentDslDraft => {
    const worktree = draft.state === "editing" ? dslDraftWorktreePath(draft) : undefined;
    return PragmaAgentDslDraftSchema.parse({
      schemaVersion: draft.schemaVersion,
      draftId: draft.draftId,
      missionId: draft.missionId,
      baseProjectRevision: draft.baseProjectRevision,
      state: draft.state,
      ...(worktree === undefined ? {} : { draftPath: worktree }),
      resources: draft.resources.map((resource) => ({
        mode: resource.mode,
        ref: resource.ref,
        kind: resource.kind,
        name: resource.name,
        relativePath: resource.relativePath,
        ...(worktree === undefined ? {} : { filePath: join(worktree, resource.relativePath) }),
        ...(resource.key === undefined ? {} : { key: resource.key }),
      })),
      ...(draft.preparedChangeSetId === undefined
        ? {}
        : { preparedChangeSetId: draft.preparedChangeSetId }),
      ...(draft.committedProjectRevision === undefined
        ? {}
        : { committedProjectRevision: draft.committedProjectRevision }),
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    });
  };

  const staleDslDraftRefs = async (draft: StoredDslDraft): Promise<string[]> => {
    const snapshot = await options.project.get();
    const current = new Map(
      snapshot.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
    );
    return draft.resources.flatMap((target) => {
      const resource = current.get(target.ref);
      if (target.mode === "create") return resource === undefined ? [] : [target.ref];
      if (resource === undefined) return [target.ref];
      return sha256(formatPragmaYaml(resource)) === target.baseSha256 ? [] : [target.ref];
    });
  };

  const divergentPreparedDslDraftRefs = async (draft: StoredDslDraft): Promise<string[]> => {
    if (draft.preparedChangeSetId === undefined) return [];
    const [base, current, candidate] = await Promise.all([
      options.project.getRevision(draft.baseProjectRevision),
      options.project.get(),
      readCandidate(candidatePath(draft.preparedChangeSetId)),
    ]);
    const baseHashes = new Map(
      base.resources.map((resource) => [
        canonicalPragmaResourceRef(resource),
        sha256(formatPragmaYaml(resource)),
      ]),
    );
    const currentHashes = new Map(
      current.resources.map((resource) => [
        canonicalPragmaResourceRef(resource),
        sha256(formatPragmaYaml(resource)),
      ]),
    );
    return candidate.resources.flatMap((resource) => {
      const ref = canonicalPragmaResourceRef(resource);
      const candidateHash = sha256(formatPragmaYaml(resource));
      const currentHash = currentHashes.get(ref);
      return currentHash === candidateHash || currentHash === baseHashes.get(ref) ? [] : [ref];
    });
  };

  const analyzeDslDraftSnapshot = async (
    draft: StoredDslDraft,
    snapshot: DslDraftFileSnapshot,
    conflictingRefs: readonly string[],
  ): Promise<DslDraftReviewAnalysis> => {
    const sources = draft.resources.map(
      (target) => snapshot.files.get(target.relativePath)!.source,
    );
    const rawResources = sources.map((source) => {
      try {
        return parsePragmaYaml(source);
      } catch {
        return undefined;
      }
    });
    const parsed = parsePragmaAgentSources(sources);
    const diagnostics: PragmaDiagnostic[] = [...parsed.diagnostics];
    if (conflictingRefs.length > 0) {
      diagnostics.push({
        severity: "error",
        code: "project.resource_conflict",
        message: `Draft targets changed after the draft started: ${conflictingRefs.join(", ")}.`,
        path: [],
      });
    }
    if (parsed.diagnostics.length === 0) {
      for (const [index, resource] of parsed.resources.entries()) {
        const target = draft.resources[index]!;
        if (canonicalPragmaResourceRef(resource) !== target.ref || resource.kind !== target.kind) {
          diagnostics.push({
            severity: "error",
            code: "resource.identity_changed",
            message: `Draft file identity must remain ${target.kind} ${target.ref}: ${target.relativePath}.`,
            resourceRef: target.ref,
            source: `source:${index}`,
            path: [],
          });
        }
      }
    }

    let effectiveResources: readonly PragmaResource[] =
      parsed.diagnostics.length === 0 ? parsed.resources : [];
    let dependencies: readonly PragmaResource[] = [];
    let effectivePreviewAvailable = false;
    if (diagnostics.every((diagnostic) => diagnostic.severity !== "error")) {
      try {
        const plan = await planResources({
          expectedProjectRevision: draft.baseProjectRevision,
          authoredResources: parsed.resources,
        });
        effectiveResources = plan.resources.slice(0, parsed.resources.length);
        dependencies = plan.dependencies;
        effectivePreviewAvailable = true;
        diagnostics.push(...plan.diagnostics);
      } catch (error) {
        diagnostics.push(...diagnosticsFromError(error));
      }
    }

    return analyzeDslDraftReview({
      draft,
      baseResources: (await options.project.getRevision(draft.baseProjectRevision)).resources,
      rawResources,
      authoredResources: parsed.diagnostics.length === 0 ? parsed.resources : [],
      effectiveResources,
      diagnostics,
      dependencies,
      effectivePreviewAvailable,
    });
  };

  const readDslDraftFileSnapshot = async (draft: StoredDslDraft) =>
    draft.submissionHash === undefined
      ? await scanDslDraftWorktree(draft)
      : await scanDslDraftSubmission(draft, dslDraftSubmissionsPath(draft.draftId));

  const inspectDslDraft = async (draft: StoredDslDraft) => {
    const snapshot = await readDslDraftFileSnapshot(draft);
    const conflictingRefs = await staleDslDraftRefs(draft);
    const analysis = await analyzeDslDraftSnapshot(draft, snapshot, conflictingRefs);
    return PragmaAgentDslDraftInspectionSchema.parse({
      ...toPublicDslDraft(draft),
      workingTreeHash: snapshot.hash,
      stale: conflictingRefs.length > 0,
      conflictingRefs,
      review: createDslDraftReview(analysis),
      changes: draft.resources.map((target) => {
        const file = snapshot.files.get(target.relativePath)!;
        return {
          ref: target.ref,
          relativePath: target.relativePath,
          changed: file.sha256 !== target.initialSha256,
          sizeBytes: Buffer.byteLength(file.source, "utf8"),
          sha256: file.sha256,
        };
      }),
    });
  };

  const readDslDraftReview = async (input: {
    readonly draft: StoredDslDraft;
    readonly section: PragmaAgentDslDraftReviewSection;
    readonly ref?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<PragmaAgentDslDraftReviewPage> => {
    const snapshot = await readDslDraftFileSnapshot(input.draft);
    const conflictingRefs = await staleDslDraftRefs(input.draft);
    const analysis = await analyzeDslDraftSnapshot(input.draft, snapshot, conflictingRefs);
    const items = dslDraftReviewSectionItems(analysis, input.section).filter((item) =>
      input.ref === undefined ? true : dslDraftReviewItemRef(item) === input.ref,
    );
    return paginateDslDraftReviewItems({
      draftId: input.draft.draftId,
      workingTreeHash: snapshot.hash,
      effectivePreviewAvailable: analysis.effectivePreviewAvailable,
      section: input.section,
      ref: input.ref,
      items,
      cursor: input.cursor,
      limit: input.limit,
    });
  };

  const startDslDraft = async (input: {
    readonly missionId: string;
    readonly workspacePath: string;
    readonly targets: readonly PragmaAgentDslDraftTargetInput[];
    readonly fixedCreates?: ReadonlyMap<
      string,
      { readonly ref: string; readonly id: string; readonly description: string }
    >;
    readonly draftId?: string | undefined;
  }): Promise<StoredDslDraft> => {
    const workspacePath = await resolveDslDraftWorkspace(input.workspacePath);
    const snapshot = await options.project.get();
    const draftId = input.draftId ?? randomUUID();
    return await withFileLock(dslDraftMutationLockPath(draftId), async () => {
      const worktreePath = dslDraftWorktreePath({ draftId, workspacePath });
      const usedIds = new Set(snapshot.resources.map((resource) => resource.metadata.id));
      const usedRefs = new Set<string>();
      const usedKeys = new Set<string>();
      const prepared: Array<{
        readonly target: StoredDslDraft["resources"][number];
        readonly source: string;
      }> = [];
      try {
        if (input.draftId !== undefined) {
          try {
            const existingOwner = DslDraftOwnerSchema.parse(
              JSON.parse(await readFile(dslDraftOwnerPath(draftId), "utf8")) as unknown,
            );
            if (
              existingOwner.draftId !== draftId ||
              existingOwner.missionId !== input.missionId ||
              existingOwner.workspacePath !== workspacePath
            ) {
              throw new Error("DSL draft restart replacement identity mismatch.");
            }
            if (existingOwner.state === "ready") return await readDslDraftRecord(draftId);
            await rm(join(workspacePath, ".pragma", "dsl-drafts", draftId), {
              recursive: true,
              force: true,
            });
            await rm(dirname(dslDraftRecordPath(draftId)), { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await writeJson(
          dslDraftOwnerPath(draftId),
          DslDraftOwnerSchema.parse({
            schemaVersion: "pragma.dsl-draft-owner/v1",
            draftId,
            missionId: input.missionId,
            workspacePath,
            state: "initializing",
          }),
        );
        await prepareDslDraftWorkspace(workspacePath, draftId);
        for (const target of input.targets) {
          if (target.mode === "edit") {
            if (usedRefs.has(target.ref))
              throw new Error(`Duplicate DSL draft target: ${target.ref}`);
            const resource = snapshot.resources.find(
              (candidate) => canonicalPragmaResourceRef(candidate) === target.ref,
            );
            if (resource === undefined) throw new Error(`Pragma resource not found: ${target.ref}`);
            if (resource.kind !== "Expert" && resource.kind !== "ExpertTeam") {
              throw new Error(`DSL file drafts support only Expert and ExpertTeam: ${target.ref}`);
            }
            const source = formatPragmaYaml(resource);
            const relativePath = dslDraftRelativePath(resource.kind, resource.metadata.id);
            usedRefs.add(target.ref);
            prepared.push({
              source,
              target: {
                mode: "edit",
                ref: target.ref,
                kind: resource.kind,
                name: resource.metadata.name,
                relativePath,
                filePath: join(worktreePath, relativePath),
                baseSha256: sha256(source),
                initialSha256: sha256(source),
              },
            });
            continue;
          }
          if (usedKeys.has(target.key)) throw new Error(`Duplicate DSL draft key: ${target.key}`);
          usedKeys.add(target.key);
          const fixed = input.fixedCreates?.get(target.key);
          let id = fixed?.id ?? generatePragmaResourceId();
          while (fixed === undefined && usedIds.has(id)) id = generatePragmaResourceId();
          if (fixed !== undefined && usedIds.has(id)) {
            throw new Error(`Allocated DSL resource ID is no longer available: ${id}`);
          }
          usedIds.add(id);
          const ref = fixed?.ref ?? `${target.kind === "Expert" ? "expert" : "team"}:${id}`;
          if (usedRefs.has(ref)) throw new Error(`Duplicate DSL draft target: ${ref}`);
          usedRefs.add(ref);
          const source = newDslDraftSkeleton({ ...target, id });
          const relativePath = dslDraftRelativePath(target.kind, id);
          prepared.push({
            source,
            target: {
              mode: "create",
              key: target.key,
              ref,
              kind: target.kind,
              name: target.name,
              relativePath,
              filePath: join(worktreePath, relativePath),
              initialSha256: sha256(source),
              creationDescription: fixed?.description ?? target.description,
            },
          });
        }
        for (const item of prepared) {
          await mkdir(dirname(item.target.filePath), { recursive: true, mode: 0o700 });
          await writeFile(item.target.filePath, item.source, { encoding: "utf8", mode: 0o600 });
        }
        const now = new Date().toISOString();
        const draft = StoredDslDraftSchema.parse({
          schemaVersion: "pragma.dsl-draft/v1",
          draftId,
          missionId: input.missionId,
          baseProjectRevision: snapshot.revision,
          state: "editing",
          workspacePath,
          resources: prepared.map((item) => item.target),
          createdAt: now,
          updatedAt: now,
        });
        await writeDslDraft(draft);
        await writeJson(
          dslDraftOwnerPath(draftId),
          DslDraftOwnerSchema.parse({
            schemaVersion: "pragma.dsl-draft-owner/v1",
            draftId,
            missionId: input.missionId,
            workspacePath,
            state: "ready",
          }),
        );
        return draft;
      } catch (error) {
        await rm(join(workspacePath, ".pragma", "dsl-drafts", draftId), {
          recursive: true,
          force: true,
        });
        await rm(dirname(dslDraftRecordPath(draftId)), { recursive: true, force: true });
        throw error;
      }
    });
  };

  async function recoverDslDraftRestart(draftId: string): Promise<void> {
    let journal: DslDraftRestartJournal;
    try {
      journal = DslDraftRestartJournalSchema.parse(
        JSON.parse(await readFile(dslDraftRestartJournalPath(draftId), "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (journal.sourceDraftId !== draftId) {
      throw new Error("DSL draft restart journal identity mismatch.");
    }
    if (journal.state === "completed") return;
    let source = await readDslDraftRecord(draftId);
    if (source.missionId !== journal.missionId) {
      throw new Error("DSL draft restart journal does not match its source draft.");
    }
    const targets: PragmaAgentDslDraftTargetInput[] = source.resources.map((target) =>
      target.mode === "edit"
        ? { mode: "edit", ref: target.ref }
        : {
            mode: "create",
            key: target.key!,
            kind: target.kind,
            name: target.name,
            description: target.creationDescription!,
          },
    );
    const currentRefs = new Set(
      (await options.project.get()).resources.map(canonicalPragmaResourceRef),
    );
    const fixedCreates = new Map(
      source.resources.flatMap((target) =>
        target.mode !== "create" || currentRefs.has(target.ref)
          ? []
          : [
              [
                target.key!,
                {
                  ref: target.ref,
                  id: target.ref.slice(target.ref.indexOf(":") + 1),
                  description: target.creationDescription!,
                },
              ] as const,
            ],
      ),
    );
    const replacement = await startDslDraft({
      missionId: source.missionId,
      workspacePath: source.workspacePath,
      targets,
      fixedCreates,
      draftId: journal.replacementDraftId,
    });
    const referencePath =
      journal.state === "initiated"
        ? await materializeDslDraftReference({
            draft: replacement,
            source: join(dslDraftSubmissionsPath(source.draftId), journal.sourceSubmissionHash),
          })
        : journal.referencePath!;
    if (journal.state === "initiated") {
      journal = DslDraftRestartJournalSchema.parse({
        ...journal,
        state: "replacement_created",
        referencePath,
      });
      await writeJson(dslDraftRestartJournalPath(draftId), journal);
    }
    source = await readDslDraftRecord(draftId);
    if (source.state !== "discarded") {
      await writeDslDraft(
        StoredDslDraftSchema.parse({
          ...source,
          state: "discarded",
          submissionHash: undefined,
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    try {
      await makeTreeWritableForCleanup(
        join(source.workspacePath, ".pragma", "dsl-drafts", source.draftId),
      );
      await Promise.all([
        rm(dslDraftSubmissionsPath(source.draftId), { recursive: true, force: true }),
        rm(join(source.workspacePath, ".pragma", "dsl-drafts", source.draftId), {
          recursive: true,
          force: true,
        }),
      ]);
    } catch {
      // The source is already terminal; cleanup can be retried by replaying this journal.
      return;
    }
    await writeJson(
      dslDraftRestartJournalPath(draftId),
      DslDraftRestartJournalSchema.parse({ ...journal, state: "completed", referencePath }),
    );
  }

  const withCurrentEvaluationDraftDiagnostics = async (
    draft: PragmaAgentEvaluationDraft,
  ): Promise<PragmaAgentEvaluationDraft> => {
    const snapshot = await options.project.get();
    const diagnostics: PragmaAgentEvaluationDraftDiagnostic[] = [];
    if (draft.resource.spec.method.cases.length === 0) {
      diagnostics.push({
        severity: "incomplete",
        code: "evaluation.draft.cases_empty",
        message: "Add at least one Run Dry case before preparing the Evaluation.",
        path: ["resource", "spec", "method", "cases"],
      });
    }
    if (snapshot.revision !== draft.baseProjectRevision) {
      diagnostics.push({
        severity: "error",
        code: "evaluation.draft.project_revision_conflict",
        message: `Project revision changed from ${draft.baseProjectRevision} to ${snapshot.revision}.`,
        path: ["baseProjectRevision"],
      });
    }
    const target = snapshot.resources.find(
      (resource) =>
        resource.kind === "Flow" &&
        canonicalPragmaResourceRef(resource) === draft.resource.spec.target.ref,
    );
    if (target === undefined) {
      diagnostics.push({
        severity: "error",
        code: "evaluation.draft.target_missing",
        message: `Evaluation target committed Flow not found: ${draft.resource.spec.target.ref}.`,
        path: ["resource", "spec", "target", "ref"],
      });
    }
    return PragmaAgentEvaluationDraftSchema.parse({ ...draft, diagnostics });
  };

  const resolveEvaluationFlow = async (
    draft: PragmaAgentEvaluationDraft,
  ): Promise<PragmaFlowResource> => {
    const flow = (await options.project.get()).resources.find(
      (resource): resource is PragmaFlowResource =>
        resource.kind === "Flow" &&
        canonicalPragmaResourceRef(resource) === draft.resource.spec.target.ref,
    );
    if (flow === undefined) {
      throw new Error(
        `Evaluation target committed Flow not found: ${draft.resource.spec.target.ref}.`,
      );
    }
    return flow;
  };

  const runEvaluationDraftSuite = async (draft: PragmaAgentEvaluationDraft) => {
    const evaluation = materializeEvaluationDraft(draft);
    return runPragmaEvaluation(await resolveEvaluationFlow(draft), evaluation);
  };

  return {
    async startDslDraft(input) {
      return toPublicDslDraft(await startDslDraft(input));
    },
    async listDslDrafts(input) {
      let names: string[] = [];
      try {
        names = (await readdir(dslDraftsRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const draftIds = names.flatMap((name) => {
        try {
          return [decodePragmaPathSegment(name)];
        } catch {
          return [];
        }
      });
      const ownedDraftIds: string[] = [];
      for (const draftId of draftIds) {
        let owner: DslDraftOwner;
        try {
          owner = DslDraftOwnerSchema.parse(
            JSON.parse(await readFile(dslDraftOwnerPath(draftId), "utf8")) as unknown,
          );
        } catch {
          continue;
        }
        if (owner.draftId !== draftId || owner.missionId !== input.missionId) continue;
        if (owner.state === "initializing") {
          const initializationOutcome = await withFileLock(
            dslDraftMutationLockPath(draftId),
            async () => {
              let currentOwner: DslDraftOwner;
              try {
                currentOwner = DslDraftOwnerSchema.parse(
                  JSON.parse(await readFile(dslDraftOwnerPath(draftId), "utf8")) as unknown,
                );
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing" as const;
                throw error;
              }
              if (
                currentOwner.draftId !== draftId ||
                currentOwner.missionId !== input.missionId ||
                currentOwner.state === "ready"
              ) {
                if (
                  currentOwner.draftId === draftId &&
                  currentOwner.missionId === input.missionId &&
                  currentOwner.state === "ready"
                ) {
                  return "ready" as const;
                }
                return "missing" as const;
              }
              await rm(join(currentOwner.workspacePath, ".pragma", "dsl-drafts", draftId), {
                recursive: true,
                force: true,
              });
              await rm(dirname(dslDraftRecordPath(draftId)), { recursive: true, force: true });
              return "recovered" as const;
            },
          );
          if (initializationOutcome === "ready") ownedDraftIds.push(draftId);
          continue;
        }
        ownedDraftIds.push(draftId);
      }
      const drafts = (
        await Promise.all(ownedDraftIds.map(async (draftId) => await readDslDraft(draftId)))
      )
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((draft) =>
          PragmaAgentDslDraftSummarySchema.parse({
            schemaVersion: draft.schemaVersion,
            draftId: draft.draftId,
            missionId: draft.missionId,
            baseProjectRevision: draft.baseProjectRevision,
            state: draft.state,
            ...(draft.preparedChangeSetId === undefined
              ? {}
              : { preparedChangeSetId: draft.preparedChangeSetId }),
            ...(draft.committedProjectRevision === undefined
              ? {}
              : { committedProjectRevision: draft.committedProjectRevision }),
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
            resourceCount: draft.resources.length,
            refs: draft.resources.map((resource) => resource.ref),
          }),
        );
      return paginateManagementItems({
        items: drafts,
        scope: `list_dsl_drafts:${input.missionId}`,
        fingerprintValue: drafts.map((draft) => [draft.draftId, draft.updatedAt]),
        filters: {},
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async inspectDslDraft(input) {
      const draft = await readDslDraft(input.draftId);
      requireDslDraftOwner(draft, input.missionId);
      if (draft.state === "committed" || draft.state === "discarded") {
        throw new Error(`DSL draft is already ${draft.state}.`);
      }
      return await inspectDslDraft(draft);
    },
    async readDslDraftReview(input) {
      const draft = await readDslDraft(input.draftId);
      requireDslDraftOwner(draft, input.missionId);
      if (draft.state === "committed" || draft.state === "discarded") {
        throw new Error(`DSL draft is already ${draft.state}.`);
      }
      return await readDslDraftReview({
        draft,
        section: input.section,
        ref: input.ref,
        cursor: input.cursor,
        limit: input.limit,
      });
    },
    async prepareDslDraft(input) {
      return await withFileLock(dslDraftMutationLockPath(input.draftId), async () => {
        const draft = await readDslDraftLocked(input.draftId);
        requireDslDraftOwner(draft, input.missionId);
        if (draft.state !== "editing") throw new Error("DSL draft is not editable.");
        const frozenWorktree = await detachDslDraftWorktree(draft);
        let finalized = false;
        let detachedFromWorkspace = false;
        let submission: DslDraftFileSnapshot | undefined;
        try {
          const conflictingRefs = await staleDslDraftRefs(draft);
          if (conflictingRefs.length > 0) {
            const snapshot = await createStableDslDraftSubmission(
              draft,
              frozenWorktree,
              dslDraftSubmissionsPath(draft.draftId),
            );
            submission = snapshot;
            const finalWorktree = await scanDslDraftFrozenWorktree(draft, frozenWorktree);
            if (finalWorktree.hash !== snapshot.hash) {
              await removeDslDraftSubmission(
                draft,
                dslDraftSubmissionsPath(draft.draftId),
                snapshot.hash,
              );
              return invalidPrepare(
                "dsl.draft_changed",
                "DSL draft files changed while the candidate was being frozen. Review and prepare again.",
              );
            }
            await rm(frozenWorktree, { recursive: true, force: true });
            detachedFromWorkspace = true;
            await writeDslDraft(
              StoredDslDraftSchema.parse({
                ...draft,
                state: "conflicted",
                submissionHash: snapshot.hash,
                updatedAt: new Date().toISOString(),
              }),
            );
            finalized = true;
            return invalidPrepare(
              "project.resource_conflict",
              `Draft targets changed after the draft started: ${conflictingRefs.join(", ")}.`,
            );
          }
          const snapshot = await createStableDslDraftSubmission(
            draft,
            frozenWorktree,
            dslDraftSubmissionsPath(draft.draftId),
          );
          submission = snapshot;
          const finalWorktree = await scanDslDraftFrozenWorktree(draft, frozenWorktree);
          if (finalWorktree.hash !== snapshot.hash) {
            return invalidPrepare(
              "dsl.draft_changed",
              "DSL draft files changed while the candidate was being frozen. Review and prepare again.",
            );
          }
          await rm(frozenWorktree, { recursive: true, force: true });
          detachedFromWorkspace = true;
          const sources = draft.resources.map(
            (target) => snapshot.files.get(target.relativePath)!.source,
          );
          const parsed = parsePragmaAgentSources(sources);
          if (parsed.diagnostics.length > 0) {
            return PragmaAgentPrepareResultSchema.parse({
              status: "invalid",
              diagnostics: parsed.diagnostics,
            });
          }
          for (const [index, resource] of parsed.resources.entries()) {
            const target = draft.resources[index]!;
            if (
              canonicalPragmaResourceRef(resource) !== target.ref ||
              resource.kind !== target.kind
            ) {
              return invalidPrepare(
                "resource.identity_changed",
                `Draft file identity must remain ${target.kind} ${target.ref}: ${target.relativePath}.`,
              );
            }
          }
          const result = await prepareResources({
            expectedProjectRevision: draft.baseProjectRevision,
            authoredResources: parsed.resources,
            dslDraftId: draft.draftId,
            dslDraftMissionId: draft.missionId,
            draftReview: {
              draft,
              rawResources: sources.map((source) => parsePragmaYaml(source)),
            },
          });
          if (result.status !== "prepared") {
            return result;
          }
          const next = StoredDslDraftSchema.parse({
            ...draft,
            state: "prepared",
            submissionHash: snapshot.hash,
            preparedChangeSetId: result.changeSet.changeSetId,
            updatedAt: new Date().toISOString(),
          });
          await writeDslDraft(next);
          finalized = true;
          return result;
        } finally {
          if (!finalized) {
            if (detachedFromWorkspace && submission !== undefined) {
              await restoreDslDraftWorktreeFromSubmission(
                draft,
                join(dslDraftSubmissionsPath(draft.draftId), submission.hash),
              );
              await removeDslDraftSubmission(
                draft,
                dslDraftSubmissionsPath(draft.draftId),
                submission.hash,
              );
            } else {
              await restoreDslDraftWorktree(draft, frozenWorktree);
            }
          }
        }
      });
    },
    async restartDslDraft(input) {
      return await withFileLock(dslDraftMutationLockPath(input.draftId), async () => {
        let existingJournal: DslDraftRestartJournal | undefined;
        try {
          existingJournal = DslDraftRestartJournalSchema.parse(
            JSON.parse(
              await readFile(dslDraftRestartJournalPath(input.draftId), "utf8"),
            ) as unknown,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (existingJournal !== undefined) {
          if (existingJournal.missionId !== input.missionId) {
            throw new Error("DSL draft is owned by another Mission.");
          }
          await recoverDslDraftRestart(input.draftId);
          const completed = DslDraftRestartJournalSchema.parse(
            JSON.parse(
              await readFile(dslDraftRestartJournalPath(input.draftId), "utf8"),
            ) as unknown,
          );
          const replacement = await readDslDraftRecord(completed.replacementDraftId);
          return PragmaAgentDslDraftSchema.parse({
            ...toPublicDslDraft(replacement),
            referencePath: completed.referencePath,
          });
        }
        const current = await readDslDraftLocked(input.draftId);
        requireDslDraftOwner(current, input.missionId);
        const canRestartPrepared =
          current.state === "prepared" && (await divergentPreparedDslDraftRefs(current)).length > 0;
        if (current.state !== "conflicted" && !canRestartPrepared) {
          throw new Error("Only a conflicted or stale prepared DSL draft can be restarted.");
        }
        if (current.submissionHash === undefined) {
          throw new Error("Restartable DSL draft is missing its immutable reference snapshot.");
        }
        await scanDslDraftSubmission(current, dslDraftSubmissionsPath(current.draftId));
        const journal = DslDraftRestartJournalSchema.parse({
          schemaVersion: "pragma.dsl-draft-restart/v1",
          sourceDraftId: current.draftId,
          replacementDraftId: randomUUID(),
          missionId: current.missionId,
          sourceSubmissionHash: current.submissionHash,
          state: "initiated",
        });
        await writeJson(dslDraftRestartJournalPath(current.draftId), journal);
        await recoverDslDraftRestart(current.draftId);
        const completed = DslDraftRestartJournalSchema.parse(
          JSON.parse(
            await readFile(dslDraftRestartJournalPath(current.draftId), "utf8"),
          ) as unknown,
        );
        const replacement = await readDslDraftRecord(completed.replacementDraftId);
        return PragmaAgentDslDraftSchema.parse({
          ...toPublicDslDraft(replacement),
          referencePath: completed.referencePath,
        });
      });
    },
    async discardDslDraft(input) {
      await withFileLock(dslDraftMutationLockPath(input.draftId), async () => {
        const draft = await readDslDraftLocked(input.draftId);
        requireDslDraftOwner(draft, input.missionId);
        if (draft.state === "discarded") return;
        if (draft.state === "committed")
          throw new Error("A committed DSL draft cannot be discarded.");
        const source = join(draft.workspacePath, ".pragma", "dsl-drafts", draft.draftId);
        const trash = join(dslDraftsTrashRoot, `${draft.draftId}-${Date.now()}`);
        const journalPath = dslDraftDiscardJournalPath(draft.draftId);
        const journal = DslDraftDiscardJournalSchema.parse({
          schemaVersion: "pragma.dsl-draft-discard/v1",
          draftId: draft.draftId,
          source,
          trash,
          ...(draft.submissionHash === undefined
            ? {}
            : {
                submissionSource: dslDraftSubmissionsPath(draft.draftId),
                submissionTrash: join(trash, "authoritative-submissions"),
              }),
          state: "prepared",
        });
        await withFileLock(`${journalPath}.lock`, async () => {
          await writeJson(journalPath, journal);
          await replayDslDraftDiscard(draft.draftId);
        });
      });
    },
    async allocateResourceIds(requests) {
      const snapshot = await options.project.get();
      const used = new Set(snapshot.resources.map((resource) => resource.metadata.id));
      const allocated = new Set<string>();
      return requests.map((request) => {
        let id = generatePragmaResourceId();
        while (used.has(id) || allocated.has(id)) id = generatePragmaResourceId();
        allocated.add(id);
        return { key: request.key, id, ref: `${request.kind}:${id}` };
      });
    },
    async list(input) {
      const snapshot = await options.project.get();
      const query = input.query?.trim().toLocaleLowerCase();
      const kinds = input.kinds === undefined ? undefined : new Set(input.kinds);
      const resources = snapshot.resources
        .map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: resource.kind,
          name: resource.metadata.name,
          description: resource.metadata.description,
        }))
        .filter(
          (resource) =>
            (kinds === undefined || kinds.has(resource.kind)) &&
            (query === undefined ||
              [resource.ref, resource.name, resource.description].some((value) =>
                value.toLocaleLowerCase().includes(query),
              )),
        )
        .toSorted(
          (left, right) =>
            left.kind.localeCompare(right.kind) ||
            left.name.localeCompare(right.name) ||
            left.ref.localeCompare(right.ref),
        );
      const page = paginateManagementItems({
        items: resources,
        scope: "list_dsl_resources",
        fingerprintValue: snapshot.revision,
        filters: { kinds: input.kinds, query },
        cursor: input.cursor,
        limit: input.limit,
      });
      return {
        projectRevision: snapshot.revision,
        ...page,
      };
    },
    async read(ref) {
      const snapshot = await options.project.get();
      const resource = snapshot.resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === ref,
      );
      const systemResource =
        resource === undefined ? options.systemExperts.getResource(ref) : undefined;
      const resolved = resource ?? systemResource;
      if (resolved === undefined) throw new Error(`Pragma resource not found: ${ref}`);
      return {
        ref: canonicalPragmaResourceRef(resolved),
        kind: resolved.kind,
        name: resolved.metadata.name,
        description: resolved.metadata.description,
        projectRevision: snapshot.revision,
        origin: systemResource === undefined ? "project" : "system",
        readOnly: systemResource !== undefined,
        source: formatPragmaYaml(resolved),
      };
    },
    async listExpertOptions(input) {
      const catalog = (await buildExpertCatalog(options)).options;
      const query = input.query?.trim().toLocaleLowerCase();
      const allItems = expertCatalogItems(catalog, input.category).filter((item) => {
        if (
          input.category === "capabilities" &&
          input.capabilityKind !== undefined &&
          "kind" in item &&
          item.kind !== input.capabilityKind
        ) {
          return false;
        }
        return query === undefined || JSON.stringify(item).toLocaleLowerCase().includes(query);
      });
      const items = allItems.toSorted((left, right) =>
        expertOptionSortKey(left).localeCompare(expertOptionSortKey(right)),
      );
      return {
        category: input.category,
        ...paginateManagementItems({
          items,
          scope: `list_expert_options:${input.category}`,
          fingerprintValue: items,
          filters: { query, capabilityKind: input.capabilityKind },
          cursor: input.cursor,
          limit: input.limit,
        }),
      };
    },
    async prepare(input) {
      return await prepareSources(input);
    },
    async createFlowDraft(input) {
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.expectedProjectRevision) {
        throw new Error(
          `Project revision changed from ${input.expectedProjectRevision} to ${snapshot.revision}.`,
        );
      }
      const now = new Date().toISOString();
      const draftId = randomUUID();
      const draft = withDraftDiagnostics(
        {
          draftId,
          baseProjectRevision: snapshot.revision,
          draftRevision: 0,
          resource: {
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "Flow",
            metadata: input.metadata,
            spec: {
              ...(input.input === undefined ? {} : { input: input.input }),
              ...(input.output === undefined ? {} : { output: input.output }),
              limits: input.limits ?? { maxNodeVisits: 1_000 },
              graph: { steps: {}, transitions: {}, loops: {} },
            },
          },
          diagnostics: [],
          createdAt: now,
          updatedAt: now,
        },
        snapshot.resources,
      );
      await writeJson(draftPath(draftId), draft);
      return draft;
    },
    async getFlowDraft(draftId) {
      return await withProjectDraftDiagnostics(
        options.project,
        await readFlowDraft(draftPath(draftId)),
      );
    },
    async updateFlowDraft(input) {
      const path = draftPath(input.draftId);
      return await withFileLock(`${path}.lock`, async () => {
        const current = await readFlowDraft(path);
        if (current.draftRevision !== input.expectedDraftRevision) {
          throw new Error(
            `Flow draft revision changed from ${input.expectedDraftRevision} to ${current.draftRevision}.`,
          );
        }
        const resource = structuredClone(current.resource);
        let baseProjectRevision = current.baseProjectRevision;
        for (const operation of input.operations) {
          baseProjectRevision = applyDraftOperation(resource, operation, baseProjectRevision);
        }
        if (baseProjectRevision !== current.baseProjectRevision) {
          const snapshot = await options.project.get();
          if (snapshot.revision !== baseProjectRevision) {
            throw new Error(
              `Cannot rebase Flow draft to unavailable revision ${baseProjectRevision}.`,
            );
          }
        }
        const updated = await withProjectDraftDiagnostics(options.project, {
          ...current,
          baseProjectRevision,
          draftRevision: current.draftRevision + 1,
          resource,
          updatedAt: new Date().toISOString(),
        });
        await writeJson(path, updated);
        return updated;
      });
    },
    async validateFlowDraft(draftId) {
      return await withProjectDraftDiagnostics(
        options.project,
        await readFlowDraft(draftPath(draftId)),
      );
    },
    async createEvaluationDraft(input) {
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.expectedProjectRevision) {
        throw new Error(
          `Project revision changed from ${input.expectedProjectRevision} to ${snapshot.revision}.`,
        );
      }
      const now = new Date().toISOString();
      const draftId = randomUUID();
      let resource: PragmaAgentEvaluationDraft["resource"];
      let sourceEvaluationRef: string | undefined;
      if (input.mode === "create") {
        resource = {
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Evaluation",
          metadata: input.metadata,
          spec: {
            target: { ref: input.targetRef },
            method: { type: "flow-run-dry", cases: [] },
          },
        };
      } else {
        const source = snapshot.resources.find(
          (candidate) => canonicalPragmaResourceRef(candidate) === input.evaluationRef,
        );
        if (
          source?.kind !== "Evaluation" ||
          !("target" in source.spec) ||
          source.spec.method.type !== "flow-run-dry"
        ) {
          throw new Error(`Evaluation not found: ${input.evaluationRef}`);
        }
        resource = structuredClone(PragmaFlowRunDryEvaluationResourceSchema.parse(source));
        sourceEvaluationRef = input.evaluationRef;
      }
      const draft = await withCurrentEvaluationDraftDiagnostics({
        draftId,
        baseProjectRevision: snapshot.revision,
        draftRevision: 0,
        resource,
        ...(sourceEvaluationRef === undefined ? {} : { sourceEvaluationRef }),
        diagnostics: [],
        createdAt: now,
        updatedAt: now,
      });
      await writeJson(evaluationDraftPath(draftId), draft);
      return draft;
    },
    async getEvaluationDraft(draftId) {
      return await withCurrentEvaluationDraftDiagnostics(
        await readEvaluationDraft(evaluationDraftPath(draftId)),
      );
    },
    async updateEvaluationDraft(input) {
      if (input.operations.length === 0 || input.operations.length > 10) {
        throw new Error("Evaluation draft updates require 1 to 10 operations.");
      }
      const path = evaluationDraftPath(input.draftId);
      return await withFileLock(`${path}.lock`, async () => {
        const current = await readEvaluationDraft(path);
        if (current.draftRevision !== input.expectedDraftRevision) {
          throw new Error(
            `Evaluation draft revision changed from ${input.expectedDraftRevision} to ${current.draftRevision}.`,
          );
        }
        const resource = structuredClone(current.resource);
        let baseProjectRevision = current.baseProjectRevision;
        for (const operation of input.operations) {
          baseProjectRevision = applyEvaluationDraftOperation(
            resource,
            operation,
            baseProjectRevision,
          );
        }
        if (baseProjectRevision !== current.baseProjectRevision) {
          const snapshot = await options.project.get();
          if (snapshot.revision !== baseProjectRevision) {
            throw new Error(
              `Cannot rebase Evaluation draft to unavailable revision ${baseProjectRevision}.`,
            );
          }
        }
        const updated = await withCurrentEvaluationDraftDiagnostics({
          ...current,
          baseProjectRevision,
          draftRevision: current.draftRevision + 1,
          resource,
          updatedAt: new Date().toISOString(),
        });
        await writeJson(path, updated);
        return updated;
      });
    },
    async runEvaluationDraft(input) {
      if (
        input.caseIds.length === 0 ||
        input.caseIds.length > 10 ||
        new Set(input.caseIds).size !== input.caseIds.length
      ) {
        throw new Error("Evaluation draft runs require 1 to 10 unique case IDs.");
      }
      const draft = await withCurrentEvaluationDraftDiagnostics(
        await readEvaluationDraft(evaluationDraftPath(input.draftId)),
      );
      const blocking = draft.diagnostics.find((diagnostic) => diagnostic.severity !== "warning");
      if (blocking !== undefined) throw new Error(blocking.message);
      const requested = new Set(input.caseIds);
      const missing = input.caseIds.filter(
        (caseId) => !draft.resource.spec.method.cases.some((testCase) => testCase.id === caseId),
      );
      if (missing.length > 0) {
        throw new Error(`Evaluation draft cases not found: ${missing.join(", ")}`);
      }
      const suite = await runEvaluationDraftSuite(draft);
      const requestedCases = suite.cases.filter((testCase) => requested.has(testCase.id));
      return PragmaAgentEvaluationDraftRunResultSchema.parse({
        draft: summarizeEvaluationDraft(draft),
        requestedCases,
        suite: {
          passed: suite.passed,
          total: suite.summary.total,
          passedCount: suite.summary.passed,
          failedCount: suite.summary.failed,
          failedCaseIds: suite.cases
            .filter((testCase) => !testCase.passed)
            .map((testCase) => testCase.id),
        },
        coverage: suite.coverage,
      });
    },
    async prepareEvaluationDraft(input) {
      const draft = await withCurrentEvaluationDraftDiagnostics(
        await readEvaluationDraft(evaluationDraftPath(input.draftId)),
      );
      if (draft.draftRevision !== input.expectedDraftRevision) {
        return invalidPrepare(
          "evaluation.draft.revision_conflict",
          `Evaluation draft revision changed from ${input.expectedDraftRevision} to ${draft.draftRevision}.`,
        );
      }
      const diagnostics = evaluationDraftDiagnostics(draft);
      if (diagnostics !== undefined) return diagnostics;
      const suite = await runEvaluationDraftSuite(draft);
      if (!suite.passed) return invalidEvaluationRun(suite);
      return await prepareResources({
        expectedProjectRevision: draft.baseProjectRevision,
        authoredResources: [materializeEvaluationDraft(draft)],
      });
    },
    async discardEvaluationDraft(draftId) {
      const path = evaluationDraftPath(draftId);
      await withFileLock(`${path}.lock`, async () => await rm(path, { force: true }));
    },
    async prepareFlowDraft(input) {
      const draft = await withProjectDraftDiagnostics(
        options.project,
        await readFlowDraft(draftPath(input.draftId)),
      );
      if (draft.draftRevision !== input.expectedDraftRevision) {
        return invalidPrepare(
          "flow.draft.revision_conflict",
          `Flow draft revision changed from ${input.expectedDraftRevision} to ${draft.draftRevision}.`,
        );
      }
      if (draft.diagnostics.some((diagnostic) => diagnostic.severity !== "warning")) {
        return PragmaAgentPrepareResultSchema.parse({
          status: "invalid",
          diagnostics: draft.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity === "warning" ? "warning" : "error",
            code: diagnostic.code,
            message: diagnostic.message,
            path: diagnostic.path,
          })),
        });
      }
      const additional = parsePragmaAgentSources(input.additionalSources ?? [], 1);
      if (additional.diagnostics.length > 0) {
        return PragmaAgentPrepareResultSchema.parse({
          status: "invalid",
          diagnostics: additional.diagnostics,
        });
      }
      if (
        additional.resources.some(
          (resource) => resource.kind === "Expert" || resource.kind === "ExpertTeam",
        )
      ) {
        return invalidPrepare(
          "dsl.file_draft_required",
          "Expert and ExpertTeam resources must use start_dsl_draft and prepare_dsl_draft.",
        );
      }
      if (additional.resources.some((resource) => resource.kind === "Evaluation")) {
        return invalidPrepare(
          "evaluation.independent_prepare_required",
          "Evaluation resources cannot be prepared with a Flow. Use prepare_evaluation_draft, then commit_dsl_changes separately.",
        );
      }
      const flowResource = PragmaFlowResourceSchema.parse(materializeDraft(draft));
      return await prepareResources({
        expectedProjectRevision: draft.baseProjectRevision,
        authoredResources: [flowResource, ...additional.resources],
      });
    },
    async discardFlowDraft(draftId) {
      const path = draftPath(draftId);
      await withFileLock(`${path}.lock`, async () => await rm(path, { force: true }));
    },
    async getChangeSet(changeSetId, missionId) {
      const candidate = await readCandidate(candidatePath(changeSetId));
      if (candidate.dslDraftId !== undefined) {
        if (candidate.dslDraftMissionId !== missionId) {
          throw new Error("DSL draft is owned by another Mission.");
        }
        requireDslDraftOwner(await readDslDraftRecord(candidate.dslDraftId), missionId);
      }
      return candidate.changeSet;
    },
    async commit(input) {
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const candidate = await readCandidate(candidatePath(input.changeSetId));
        if (candidate.changeSet.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          throw new Error("The prepared DSL change-set contains validation errors.");
        }
        if (candidate.dslDraftId === undefined) {
          const completed = await readJson(path);
          if (completed !== undefined) return PragmaAgentProjectCommitSchema.parse(completed);
          await validateCandidateForCommit(candidate);
          const result = await publishCandidate(candidate);
          await writeJson(path, result);
          return result;
        }
        return await withFileLock(dslDraftMutationLockPath(candidate.dslDraftId), async () => {
          if (candidate.dslDraftMissionId !== input.missionId) {
            throw new Error("DSL draft is owned by another Mission.");
          }
          const ownedDraft = await readDslDraftRecord(candidate.dslDraftId!);
          requireDslDraftOwner(ownedDraft, input.missionId);
          const recovered = await replayDslDraftCommit(candidate.dslDraftId!);
          if (recovered !== undefined) {
            if (
              recovered.changeSetId !== candidate.changeSet.changeSetId ||
              recovered.result === undefined
            ) {
              throw new Error("DSL draft already has a different commit transaction.");
            }
            await writeJson(path, recovered.result);
            return recovered.result;
          }
          const completed = await readJson(path);
          if (completed !== undefined) return PragmaAgentProjectCommitSchema.parse(completed);
          const draft = await readDslDraftLocked(candidate.dslDraftId!);
          if (
            draft.state !== "prepared" ||
            draft.preparedChangeSetId !== candidate.changeSet.changeSetId
          ) {
            throw new Error("Prepared DSL draft no longer matches its change-set.");
          }
          await validateCandidateForCommit(candidate);
          await writeJson(
            dslDraftCommitJournalPath(candidate.dslDraftId!),
            DslDraftCommitJournalSchema.parse({
              schemaVersion: "pragma.dsl-draft-commit/v1",
              draftId: candidate.dslDraftId,
              changeSetId: candidate.changeSet.changeSetId,
              operationId: input.operationId,
              state: "initiated",
            }),
          );
          const committed = await replayDslDraftCommit(candidate.dslDraftId!, "publish");
          const result = committed?.result;
          if (result === undefined)
            throw new Error("DSL draft commit recovery produced no result.");
          await writeJson(path, result);
          return result;
        });
      });
    },
  };
}

interface DesktopExpertCatalog {
  readonly options: PragmaAgentExpertOptionCatalog;
  readonly resources: ReadonlyMap<string, PragmaResource>;
  readonly availableModels: ReadonlySet<string>;
  readonly readyCapabilityIds: ReadonlySet<string>;
}

type ExpertCatalogItem =
  | PragmaAgentExpertOptionCatalog["runtimeModels"][number]
  | PragmaAgentExpertOptionCatalog["capabilities"][number]
  | PragmaAgentExpertOptionCatalog["avatars"][number]
  | PragmaAgentExpertOptionCatalog["builtinExperts"][number];

function expertCatalogItems(
  catalog: PragmaAgentExpertOptionCatalog,
  category: "runtime-models" | "capabilities" | "avatars" | "builtin-experts",
): ExpertCatalogItem[] {
  switch (category) {
    case "runtime-models":
      return [...catalog.runtimeModels];
    case "capabilities":
      return [...catalog.capabilities];
    case "avatars":
      return [...catalog.avatars];
    case "builtin-experts":
      return [...catalog.builtinExperts];
  }
}

function expertOptionSortKey(item: ExpertCatalogItem): string {
  if ("runtimeProfileRef" in item)
    return `${item.runtimeName}/${item.providerName}/${item.modelName}`;
  if ("avatarId" in item) return `${item.name}/${item.avatarId}`;
  if ("ref" in item) return `${item.name}/${item.ref}`;
  return JSON.stringify(item);
}

async function buildExpertCatalog(options: {
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
  readonly systemExperts: Pick<DesktopSystemExpertRegistry, "list" | "get">;
}): Promise<DesktopExpertCatalog> {
  const [availability, latestCapabilities] = await Promise.all([
    getRuntimeAvailability(options.runtimes),
    listCapabilitiesWithBuiltIns(options.capabilities),
  ]);
  const capabilities = (
    await Promise.all(
      latestCapabilities.map(async (capability) => {
        if (capability.managedBy === "system") return capability;
        return await options.capabilities
          .resolveActive(capability.manifest.id)
          .catch(() => undefined);
      }),
    )
  ).filter((capability): capability is Capability => capability !== undefined);
  const resources = new Map<string, PragmaResource>();
  const runtimeModels = availability
    .filter((runtime) => runtime.status === "available")
    .flatMap((runtime) =>
      (runtime.models ?? []).map((model) => {
        const resource = createDesktopRuntimeOptionResource({
          runtimeId: runtime.id,
          providerId: model.provider.id,
          modelId: model.id,
          name: `${runtime.displayName} / ${model.displayName}`,
          description: `Host-provided Runtime model ${model.provider.displayName} / ${model.displayName}.`,
        });
        const ref = canonicalPragmaResourceRef(resource);
        resources.set(ref, resource);
        return {
          key: ref,
          runtimeProfileRef: ref,
          runtimeName: runtime.displayName,
          providerName: model.provider.displayName,
          modelName: model.displayName,
          isDefault: runtime.isDefault && model.default === true,
        };
      }),
    );
  const capabilityOptions = capabilities.map((capability) => {
    const resource = capabilityResource(capability);
    const ref = canonicalPragmaResourceRef(resource);
    resources.set(ref, resource);
    const toolNames = capabilityToolNames(capability);
    return {
      key: ref,
      ref,
      name: capability.definition.name,
      description: capabilityDescription(capability),
      kind: capability.definition.kind === "skill" ? ("skill" as const) : ("tools" as const),
      toolNames,
    };
  });
  return {
    options: PragmaAgentExpertOptionCatalogSchema.parse({
      runtimeModels,
      capabilities: capabilityOptions,
      avatars: BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES,
      builtinExperts: options.systemExperts.list().map((summary) => {
        const definition = options.systemExperts.get(summary.ref);
        if (definition === undefined) {
          throw new Error(`Built-in Expert definition not found: ${summary.ref}`);
        }
        return {
          ref: summary.ref,
          name: summary.name,
          description: summary.description,
          model:
            definition.executionProfile.mode === "system-default"
              ? { mode: "system-default" as const }
              : { mode: "pinned" as const, ...definition.executionProfile.model },
          assignableAs: ["team-member", "coordinator"] as const,
          origin: "system" as const,
          readOnly: true as const,
        };
      }),
    }),
    resources,
    availableModels: new Set(
      availability
        .filter((runtime) => runtime.status === "available")
        .flatMap((runtime) =>
          (runtime.models ?? []).map((model) =>
            runtimeModelIdentity(runtime.id, model.provider.id, model.id),
          ),
        ),
    ),
    readyCapabilityIds: new Set(capabilities.map((capability) => capability.manifest.id)),
  };
}

function capabilityResource(capability: Capability): PragmaResource {
  return createDesktopCapabilityResource({
    owner: "default-agent-option",
    capabilityId: capability.manifest.id,
    name: capability.definition.name,
    description: capabilityDescription(capability),
  });
}

function capabilityDescription(capability: Capability): string {
  const description = capability.definition.description.trim();
  return description === ""
    ? `Host-provided Desktop capability ${capability.definition.name}.`
    : description;
}

function capabilityToolNames(capability: Capability): string[] {
  switch (capability.definition.kind) {
    case "skill":
      return [];
    case "code_service":
      return [capability.definition.tool.name];
    case "mcp_server":
    case "http_service":
      return capability.definition.tools.map((tool) => tool.name);
  }
}

function expertDependencyRefs(resource: PragmaExpertResource): string[] {
  return [
    ...(resource.spec.runtime === undefined ? [] : [resource.spec.runtime.ref]),
    ...resource.spec.capabilities.map((capability) => capability.ref),
  ];
}

const DSL_DRAFT_REVIEW_MAX_BYTES = 8 * 1_024;
const DSL_DRAFT_REVIEW_MAX_FIELD_CHANGES = 30;
const DSL_DRAFT_REVIEW_MAX_FIELD_CHANGES_PER_RESOURCE = 8;
const DSL_DRAFT_REVIEW_MAX_OMITTED_FIELDS = 30;
const DSL_DRAFT_REVIEW_MAX_DIAGNOSTICS = 30;
const DSL_DRAFT_REVIEW_MAX_HOST_DEPENDENCIES = 50;
const DSL_DRAFT_REVIEW_VALUE_PREVIEW_CHARS = 80;

type DslReviewPath = readonly (string | number)[];
type DslReviewFieldChange = PragmaAgentDslDraftReview["fieldChanges"][number];
type DslReviewOmittedField = PragmaAgentDslDraftReview["omittedFields"][number];
type DslReviewHostDependency = PragmaAgentDslDraftReview["hostDependencies"][number];
type DslReviewValueSummary = NonNullable<DslReviewFieldChange["before"]>;
type DslReviewItem = PragmaAgentDslDraftReviewPage["items"][number];

interface DslDraftReviewAnalysis {
  readonly effectivePreviewAvailable: boolean;
  readonly summary: PragmaAgentDslDraftReview["summary"];
  readonly diagnostics: readonly PragmaDiagnostic[];
  readonly fieldChanges: readonly DslReviewFieldChange[];
  readonly omittedFields: readonly DslReviewOmittedField[];
  readonly hostDependencies: readonly DslReviewHostDependency[];
}

function analyzeDslDraftReview(input: {
  readonly draft: StoredDslDraft;
  readonly baseResources: readonly PragmaResource[];
  readonly rawResources: readonly unknown[];
  readonly authoredResources: readonly PragmaResource[];
  readonly effectiveResources: readonly PragmaResource[];
  readonly diagnostics: readonly PragmaDiagnostic[];
  readonly dependencies: readonly PragmaResource[];
  readonly effectivePreviewAvailable: boolean;
}): DslDraftReviewAnalysis {
  const baseByRef = new Map(
    input.baseResources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const effectiveByRef = new Map(
    input.effectiveResources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const authoredByRef = new Map(
    input.authoredResources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const rawByRef = new Map(
    input.draft.resources.flatMap((target, index) => {
      const raw = input.rawResources[index];
      return raw === undefined ? [] : [[target.ref, raw] as const];
    }),
  );
  const fieldChanges: DslReviewFieldChange[] = [];
  const omittedFields: DslReviewOmittedField[] = [];

  for (const target of input.draft.resources) {
    if (target.mode === "create") continue;
    const base = baseByRef.get(target.ref);
    const authored = authoredByRef.get(target.ref);
    const effective = effectiveByRef.get(target.ref);
    if (base === undefined || authored === undefined || effective === undefined) continue;
    collectDslFieldChanges(target.ref, base, effective, [], fieldChanges);
    const unknownPaths = new Set(
      inspectPragmaUnknownFields(base, "resource").map((issue) => dslReviewPathKey(issue.path)),
    );
    collectDslOmittedFields(
      target.ref,
      base,
      rawByRef.get(target.ref),
      effective,
      [],
      unknownPaths,
      omittedFields,
    );
  }

  fieldChanges.sort(compareDslReviewFieldChanges);
  omittedFields.sort(
    (left, right) =>
      dslOmittedFieldPriority(left.effect) - dslOmittedFieldPriority(right.effect) ||
      left.ref.localeCompare(right.ref) ||
      dslReviewPathKey(left.path).localeCompare(dslReviewPathKey(right.path)),
  );
  const hostDependencies = input.dependencies
    .filter(
      (resource): resource is Extract<PragmaResource, { kind: "Capability" | "RuntimeProfile" }> =>
        resource.kind === "Capability" || resource.kind === "RuntimeProfile",
    )
    .map((resource): DslReviewHostDependency => ({
      ref: canonicalPragmaResourceRef(resource),
      kind: resource.kind,
      action: "create",
    }))
    .toSorted((left, right) => left.ref.localeCompare(right.ref));
  const diagnostics = input.diagnostics
    .map(compactDslReviewDiagnostic)
    .toSorted(
      (left, right) =>
        dslDiagnosticPriority(left) - dslDiagnosticPriority(right) ||
        left.code.localeCompare(right.code) ||
        dslReviewPathKey(left.path).localeCompare(dslReviewPathKey(right.path)),
    );
  const changedRefs = new Set([
    ...input.draft.resources
      .filter((target) => target.mode === "create")
      .map((target) => target.ref),
    ...fieldChanges.map((change) => change.ref),
  ]);
  const summary: PragmaAgentDslDraftReview["summary"] = {
    resourceCount: input.draft.resources.length,
    changedResourceCount: changedRefs.size,
    fieldsAdded: fieldChanges.filter((change) => change.change === "added").length,
    fieldsChanged: fieldChanges.filter((change) => change.change === "changed").length,
    fieldsRemoved: fieldChanges.filter((change) => change.change === "removed").length,
    omittedFieldCount: omittedFields.length,
    diagnosticCount: diagnostics.length,
    errorCount: diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warningCount: diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    hostDependencyCount: hostDependencies.length,
  };

  return {
    effectivePreviewAvailable: input.effectivePreviewAvailable,
    summary,
    diagnostics,
    fieldChanges,
    omittedFields,
    hostDependencies,
  };
}

function createDslDraftReview(input: DslDraftReviewAnalysis): PragmaAgentDslDraftReview {
  const { diagnostics, fieldChanges, hostDependencies, omittedFields, summary } = input;
  const selectedDiagnostics: PragmaDiagnostic[] = [];
  const selectedFieldChanges: DslReviewFieldChange[] = [];
  const selectedOmittedFields: DslReviewOmittedField[] = [];
  const selectedHostDependencies: DslReviewHostDependency[] = [];
  const build = (): PragmaAgentDslDraftReview =>
    PragmaAgentDslDraftReviewSchema.parse({
      unknownFieldPolicy: "preserve-additive",
      effectivePreviewAvailable: input.effectivePreviewAvailable,
      summary,
      diagnostics: selectedDiagnostics,
      fieldChanges: selectedFieldChanges,
      omittedFields: selectedOmittedFields,
      hostDependencies: selectedHostDependencies,
      truncation: {
        diagnostics: dslReviewTruncation(diagnostics.length, selectedDiagnostics.length),
        fieldChanges: dslReviewTruncation(fieldChanges.length, selectedFieldChanges.length),
        omittedFields: dslReviewTruncation(omittedFields.length, selectedOmittedFields.length),
        hostDependencies: dslReviewTruncation(
          hostDependencies.length,
          selectedHostDependencies.length,
        ),
      },
    });
  const tryAdd = <T>(items: T[], item: T, maximum: number): void => {
    if (items.length >= maximum) return;
    items.push(item);
    if (Buffer.byteLength(JSON.stringify(build()), "utf8") > DSL_DRAFT_REVIEW_MAX_BYTES) {
      items.pop();
    }
  };

  for (const diagnostic of diagnostics.filter((item) => item.severity === "error")) {
    tryAdd(selectedDiagnostics, diagnostic, DSL_DRAFT_REVIEW_MAX_DIAGNOSTICS);
  }
  for (const omitted of omittedFields) {
    tryAdd(selectedOmittedFields, omitted, DSL_DRAFT_REVIEW_MAX_OMITTED_FIELDS);
  }
  const fieldChangesPerResource = new Map<string, number>();
  const tryAddFieldChange = (change: DslReviewFieldChange): void => {
    const count = fieldChangesPerResource.get(change.ref) ?? 0;
    if (count >= DSL_DRAFT_REVIEW_MAX_FIELD_CHANGES_PER_RESOURCE) return;
    const before = selectedFieldChanges.length;
    tryAdd(selectedFieldChanges, change, DSL_DRAFT_REVIEW_MAX_FIELD_CHANGES);
    if (selectedFieldChanges.length > before) {
      fieldChangesPerResource.set(change.ref, count + 1);
    }
  };
  for (const change of fieldChanges.filter((item) => item.change === "removed")) {
    tryAddFieldChange(change);
  }
  for (const dependency of hostDependencies) {
    tryAdd(selectedHostDependencies, dependency, DSL_DRAFT_REVIEW_MAX_HOST_DEPENDENCIES);
  }
  for (const change of fieldChanges.filter((item) => item.change !== "removed")) {
    tryAddFieldChange(change);
  }
  for (const diagnostic of diagnostics.filter((item) => item.severity === "warning")) {
    tryAdd(selectedDiagnostics, diagnostic, DSL_DRAFT_REVIEW_MAX_DIAGNOSTICS);
  }
  return build();
}

function dslDraftReviewSectionItems(
  analysis: DslDraftReviewAnalysis,
  section: PragmaAgentDslDraftReviewSection,
): readonly DslReviewItem[] {
  switch (section) {
    case "diagnostics":
      return analysis.diagnostics;
    case "fieldChanges":
      return analysis.fieldChanges;
    case "omittedFields":
      return analysis.omittedFields;
    case "hostDependencies":
      return analysis.hostDependencies;
  }
}

function dslDraftReviewItemRef(item: DslReviewItem): string | undefined {
  if ("ref" in item) return item.ref;
  return "resourceRef" in item ? item.resourceRef : undefined;
}

function paginateDslDraftReviewItems(input: {
  readonly draftId: string;
  readonly workingTreeHash: string;
  readonly effectivePreviewAvailable: boolean;
  readonly section: PragmaAgentDslDraftReviewSection;
  readonly ref?: string | undefined;
  readonly items: readonly DslReviewItem[];
  readonly cursor?: string | undefined;
  readonly limit: number;
}): PragmaAgentDslDraftReviewPage {
  for (let limit = Math.min(input.limit, 30); limit >= 1; limit -= 1) {
    const page = paginateManagementItems({
      items: input.items,
      scope: `read_dsl_draft_review:${input.draftId}:${input.section}`,
      fingerprintValue: {
        workingTreeHash: input.workingTreeHash,
        effectivePreviewAvailable: input.effectivePreviewAvailable,
        items: input.items,
      },
      filters: { ref: input.ref ?? null },
      cursor: input.cursor,
      limit,
    });
    const candidate = PragmaAgentDslDraftReviewPageSchema.parse({
      draftId: input.draftId,
      workingTreeHash: input.workingTreeHash,
      effectivePreviewAvailable: input.effectivePreviewAvailable,
      section: input.section,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      total: input.items.length,
      items: page.items,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= DSL_DRAFT_REVIEW_MAX_BYTES) {
      return candidate;
    }
  }
  throw new Error("A DSL draft review detail exceeds the bounded response budget.");
}

function collectDslFieldChanges(
  ref: string,
  before: unknown,
  after: unknown,
  path: DslReviewPath,
  output: DslReviewFieldChange[],
  beforeExists = true,
  afterExists = true,
): void {
  if (beforeExists && afterExists && isDeepStrictEqual(before, after)) return;
  if (beforeExists && afterExists && isDslReviewRecord(before) && isDslReviewRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].toSorted();
    for (const key of keys) {
      collectDslFieldChanges(
        ref,
        before[key],
        after[key],
        [...path, key],
        output,
        Object.hasOwn(before, key),
        Object.hasOwn(after, key),
      );
    }
    return;
  }
  output.push({
    ref,
    path: compactDslReviewPath(path),
    change: !beforeExists ? "added" : !afterExists ? "removed" : "changed",
    ...(beforeExists ? { before: summarizeDslReviewValue(before) } : {}),
    ...(afterExists ? { after: summarizeDslReviewValue(after) } : {}),
  });
}

function collectDslOmittedFields(
  ref: string,
  base: unknown,
  raw: unknown,
  effective: unknown,
  path: DslReviewPath,
  unknownPaths: ReadonlySet<string>,
  output: DslReviewOmittedField[],
): void {
  if (Array.isArray(base) && Array.isArray(raw)) {
    const availableRawIndexes = new Set(raw.keys());
    const availableEffectiveIndexes = new Set(Array.isArray(effective) ? effective.keys() : []);
    for (const [index, entry] of base.entries()) {
      const rawIndex = findDslReviewArrayEntry(raw, entry, availableRawIndexes, index);
      if (rawIndex === undefined) continue;
      availableRawIndexes.delete(rawIndex);
      const effectiveIndex = Array.isArray(effective)
        ? findDslReviewArrayEntry(effective, entry, availableEffectiveIndexes, index)
        : undefined;
      if (effectiveIndex !== undefined) availableEffectiveIndexes.delete(effectiveIndex);
      collectDslOmittedFields(
        ref,
        entry,
        raw[rawIndex],
        effectiveIndex === undefined || !Array.isArray(effective)
          ? undefined
          : effective[effectiveIndex],
        [...path, index],
        unknownPaths,
        output,
      );
    }
    return;
  }
  if (!isDslReviewRecord(base)) return;
  for (const key of Object.keys(base).toSorted()) {
    const nextPath = [...path, key];
    if (!isDslReviewRecord(raw) || !Object.hasOwn(raw, key)) {
      output.push({
        ref,
        path: compactDslReviewPath(nextPath),
        effect: unknownPaths.has(dslReviewPathKey(nextPath))
          ? "preserved_unknown"
          : isDslReviewRecord(effective) && Object.hasOwn(effective, key)
            ? "defaulted"
            : "removed",
      });
      continue;
    }
    collectDslOmittedFields(
      ref,
      base[key],
      raw[key],
      isDslReviewRecord(effective) ? effective[key] : undefined,
      nextPath,
      unknownPaths,
      output,
    );
  }
}

function findDslReviewArrayEntry(
  entries: readonly unknown[],
  original: unknown,
  availableIndexes: ReadonlySet<number>,
  fallbackIndex: number,
): number | undefined {
  if (isDslReviewRecord(original)) {
    for (const key of ["id", "ref", "name", "key"] as const) {
      const identity = original[key];
      if (typeof identity !== "string" && typeof identity !== "number") continue;
      const match = [...availableIndexes].find(
        (index) => isDslReviewRecord(entries[index]) && entries[index][key] === identity,
      );
      if (match !== undefined) return match;
    }
  }
  return availableIndexes.has(fallbackIndex) ? fallbackIndex : undefined;
}

function summarizeDslReviewValue(value: unknown): DslReviewValueSummary {
  if (value === null) return { type: "null", preview: "null" };
  if (typeof value === "string") {
    const characters = [...value];
    return {
      type: "string",
      preview:
        characters.length <= DSL_DRAFT_REVIEW_VALUE_PREVIEW_CHARS
          ? value
          : `${characters.slice(0, 40).join("")}…${characters.slice(-39).join("")}`,
      size: characters.length,
    };
  }
  if (typeof value === "number") return { type: "number", preview: String(value) };
  if (typeof value === "boolean") return { type: "boolean", preview: String(value) };
  if (Array.isArray(value)) {
    const identities = value.slice(0, 3).map(dslReviewValueIdentity);
    return {
      type: "array",
      preview: truncateDslReviewPreview(
        `[${identities.join(", ")}${value.length > 3 ? ", …" : ""}]`,
      ),
      size: value.length,
    };
  }
  if (isDslReviewRecord(value)) {
    const keys = Object.keys(value).toSorted();
    return {
      type: "object",
      preview: truncateDslReviewPreview(
        `{${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", …" : ""}}`,
      ),
      size: keys.length,
    };
  }
  return { type: "string", preview: truncateDslReviewPreview(String(value)) };
}

function dslReviewValueIdentity(value: unknown): string {
  if (isDslReviewRecord(value)) {
    for (const key of ["ref", "id", "name", "key"] as const) {
      if (typeof value[key] === "string" || typeof value[key] === "number") {
        return `${key}:${String(value[key])}`;
      }
    }
    return `{${Object.keys(value).slice(0, 2).join(",")}}`;
  }
  return String(value);
}

function truncateDslReviewPreview(value: string): string {
  return truncateDslReviewText(value, DSL_DRAFT_REVIEW_VALUE_PREVIEW_CHARS);
}

function truncateDslReviewText(value: string, maximum: number): string {
  const characters = [...value];
  return characters.length <= maximum ? value : `${characters.slice(0, maximum - 1).join("")}…`;
}

function compactDslReviewPath(path: DslReviewPath): (string | number)[] {
  const segments = path.length <= 20 ? [...path] : [...path.slice(0, 10), "…", ...path.slice(-9)];
  return segments.map((segment) =>
    typeof segment === "string" ? truncateDslReviewText(segment, 80) : segment,
  );
}

function isDslReviewRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareDslReviewFieldChanges(
  left: DslReviewFieldChange,
  right: DslReviewFieldChange,
): number {
  return (
    dslFieldChangePriority(left) - dslFieldChangePriority(right) ||
    left.ref.localeCompare(right.ref) ||
    dslReviewPathKey(left.path).localeCompare(dslReviewPathKey(right.path))
  );
}

function dslFieldChangePriority(change: DslReviewFieldChange): number {
  if (change.change === "removed") return 0;
  const first = change.path[0];
  const second = change.path[1];
  if (first === "apiVersion" || first === "kind" || first === "metadata") return 1;
  if (
    first === "spec" &&
    (second === "runtime" || second === "capabilities" || second === "contextStores")
  ) {
    return 1;
  }
  return 2;
}

function dslOmittedFieldPriority(effect: DslReviewOmittedField["effect"]): number {
  return effect === "removed" ? 0 : effect === "defaulted" ? 1 : 2;
}

function dslDiagnosticPriority(diagnostic: PragmaDiagnostic): number {
  return diagnostic.severity === "error" ? 0 : 1;
}

function compactDslReviewDiagnostic(diagnostic: PragmaDiagnostic): PragmaDiagnostic {
  return {
    severity: diagnostic.severity,
    code: diagnostic.code,
    message: truncateDslReviewText(diagnostic.message, 500),
    ...(diagnostic.resourceRef === undefined ? {} : { resourceRef: diagnostic.resourceRef }),
    ...(diagnostic.source === undefined || isAbsolute(diagnostic.source)
      ? {}
      : { source: truncateDslReviewText(diagnostic.source, 200) }),
    path: compactDslReviewPath(diagnostic.path),
  };
}

function dslReviewPathKey(path: DslReviewPath): string {
  return JSON.stringify(path);
}

function dslReviewTruncation(total: number, returned: number) {
  return { total, returned, omitted: total - returned };
}

function assertExpertSelectionsAvailable(
  authored: readonly PragmaResource[],
  current: readonly PragmaResource[],
  dependencies: readonly PragmaResource[],
  catalog: DesktopExpertCatalog,
): void {
  const byRef = new Map(
    [...current, ...dependencies].map((resource) => [
      canonicalPragmaResourceRef(resource),
      resource,
    ]),
  );
  for (const expert of authored.filter(
    (resource): resource is PragmaExpertResource => resource.kind === "Expert",
  )) {
    if (expert.spec.runtime === undefined) {
      throw new Error(`Expert ${expert.metadata.id} must select a Runtime model.`);
    }
    const runtime = byRef.get(expert.spec.runtime.ref);
    if (runtime?.kind !== "RuntimeProfile") {
      throw new Error(`Expert Runtime profile is unavailable: ${expert.spec.runtime.ref}.`);
    }
    const config = runtime.spec.config as {
      runtimeId?: unknown;
      providerId?: unknown;
      model?: unknown;
    };
    if (
      typeof config.runtimeId !== "string" ||
      typeof config.providerId !== "string" ||
      typeof config.model !== "string" ||
      !catalog.availableModels.has(
        runtimeModelIdentity(config.runtimeId, config.providerId, config.model),
      )
    ) {
      throw new Error(`Expert Runtime model is unavailable: ${expert.spec.runtime.ref}.`);
    }
    for (const reference of expert.spec.capabilities) {
      const capability = byRef.get(reference.ref);
      if (capability?.kind !== "Capability") continue;
      const binding = parseDesktopCapabilityBindingRef(capability.spec.binding ?? "");
      if (binding !== undefined && !catalog.readyCapabilityIds.has(binding)) {
        throw new Error(`Expert capability is unavailable: ${reference.ref}.`);
      }
    }
  }
}

function runtimeModelIdentity(runtimeId: string, providerId: string, modelId: string): string {
  return JSON.stringify([runtimeId, providerId, modelId]);
}

function parsePragmaAgentResource(source: string): PragmaResource {
  const resource = PragmaForwardCompatibleResourceSchema.parse(parsePragmaYaml(source));
  if (
    resource.kind !== "Expert" &&
    resource.kind !== "ExpertTeam" &&
    resource.kind !== "Flow" &&
    resource.kind !== "Automation" &&
    resource.kind !== "Evaluation"
  ) {
    throw new Error(
      "default Agent can only create or update Expert, ExpertTeam, Flow, Evaluation, and Automation resources.",
    );
  }
  return resource;
}

function parsePragmaAgentSources(
  sources: readonly string[],
  sourceIndexOffset = 0,
): {
  readonly resources: readonly PragmaResource[];
  readonly diagnostics: ReturnType<typeof diagnosticsFromError>;
} {
  const resources: PragmaResource[] = [];
  const diagnostics: ReturnType<typeof diagnosticsFromError> = [];
  sources.forEach((source, index) => {
    try {
      resources.push(parsePragmaAgentResource(source));
    } catch (error) {
      diagnostics.push(...diagnosticsFromError(error, `source:${sourceIndexOffset + index}`));
    }
  });
  return { resources, diagnostics };
}

function invalidPrepare(code: string, message: string): PragmaAgentPrepareResult {
  return PragmaAgentPrepareResultSchema.parse({
    status: "invalid",
    diagnostics: [{ severity: "error", code, message, path: [] }],
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dslDraftWorktreePath(draft: Pick<StoredDslDraft, "draftId" | "workspacePath">): string {
  return join(draft.workspacePath, ".pragma", "dsl-drafts", draft.draftId, "worktree");
}

function dslDraftRelativePath(kind: "Expert" | "ExpertTeam", id: string): string {
  return `${kind === "Expert" ? "experts" : "teams"}/${id}.pragma.yaml`;
}

async function resolveDslDraftWorkspace(requested: string): Promise<string> {
  if (!isAbsolute(requested)) throw new Error("DSL draft workspace must be absolute.");
  return await realpath(requested).catch(() => {
    throw new Error("DSL draft workspace is unavailable.");
  });
}

async function prepareDslDraftWorkspace(workspacePath: string, draftId: string): Promise<void> {
  let current = workspacePath;
  for (const component of [".pragma", "dsl-drafts", draftId]) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("DSL draft path escapes workspace.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const worktree = join(current, "worktree");
  await mkdir(worktree, { recursive: true, mode: 0o700 });
  const canonical = await realpath(worktree);
  if (!isWithinPath(workspacePath, canonical)) throw new Error("DSL draft path escapes workspace.");
  await ensurePragmaWorkspaceGitExclude(workspacePath).catch(() => undefined);
}

interface DslDraftFileSnapshot {
  readonly hash: string;
  readonly files: ReadonlyMap<string, { readonly source: string; readonly sha256: string }>;
}

async function scanDslDraftWorktree(draft: StoredDslDraft): Promise<DslDraftFileSnapshot> {
  const worktree = dslDraftWorktreePath(draft);
  return await scanDslDraftWorkspaceTree(draft, worktree, "worktree");
}

async function scanDslDraftFrozenWorktree(
  draft: StoredDslDraft,
  frozenWorktree: string,
): Promise<DslDraftFileSnapshot> {
  return await scanDslDraftWorkspaceTree(draft, frozenWorktree, "frozen worktree");
}

async function scanDslDraftWorkspaceTree(
  draft: StoredDslDraft,
  root: string,
  label: string,
): Promise<DslDraftFileSnapshot> {
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`DSL draft ${label} must be a real directory.`);
  }
  const canonical = await realpath(root);
  if (!isWithinPath(draft.workspacePath, canonical)) {
    throw new Error(`DSL draft ${label} escapes its Mission workspace.`);
  }
  return await scanDslDraftFiles(root, draft.resources);
}

async function detachDslDraftWorktree(draft: StoredDslDraft): Promise<string> {
  const worktree = dslDraftWorktreePath(draft);
  const frozenWorktree = join(dirname(worktree), "frozen-worktree");
  try {
    await lstat(frozenWorktree);
    try {
      await lstat(worktree);
      throw new Error("DSL draft has both editable and frozen worktrees.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await scanDslDraftFrozenWorktree(draft, frozenWorktree);
    return frozenWorktree;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await scanDslDraftWorktree(draft);
  await rename(worktree, frozenWorktree);
  try {
    await scanDslDraftFrozenWorktree(draft, frozenWorktree);
    return frozenWorktree;
  } catch (error) {
    await restoreDslDraftWorktree(draft, frozenWorktree);
    throw error;
  }
}

async function restoreDslDraftWorktree(
  draft: StoredDslDraft,
  frozenWorktree: string,
): Promise<void> {
  try {
    await rename(frozenWorktree, dslDraftWorktreePath(draft));
  } catch (error) {
    throw new Error("DSL draft worktree could not be restored after an unsuccessful prepare.", {
      cause: error,
    });
  }
}

async function restoreDslDraftWorktreeFromSubmission(
  draft: StoredDslDraft,
  source: string,
): Promise<void> {
  const worktree = dslDraftWorktreePath(draft);
  const temporary = `${worktree}.${randomUUID()}.tmp`;
  await rm(temporary, { recursive: true, force: true });
  try {
    await cp(source, temporary, { recursive: true, errorOnExist: true });
    await scanDslDraftWorkspaceTree(draft, temporary, "restored worktree");
    await rename(temporary, worktree);
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function recoverInterruptedDslDraftPrepare(
  draft: StoredDslDraft,
  submissionsRoot: string,
): Promise<void> {
  try {
    await scanDslDraftWorktree(draft);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const frozen = join(dirname(dslDraftWorktreePath(draft)), "frozen-worktree");
  try {
    await scanDslDraftFrozenWorktree(draft, frozen);
    await restoreDslDraftWorktree(draft, frozen);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let submissions: string[] = [];
  try {
    submissions = (await readdir(submissionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/u.test(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (submissions.length !== 1) {
    throw new Error("Interrupted DSL draft prepare has no unambiguous recovery snapshot.");
  }
  const source = join(submissionsRoot, submissions[0]!);
  const snapshot = await scanDslDraftFiles(source, draft.resources);
  if (snapshot.hash !== submissions[0]) {
    throw new Error("Interrupted DSL draft prepare snapshot identity mismatch.");
  }
  await restoreDslDraftWorktreeFromSubmission(draft, source);
  await rm(source, { recursive: true, force: true });
}

async function scanDslDraftFiles(
  root: string,
  resources: StoredDslDraft["resources"],
): Promise<DslDraftFileSnapshot> {
  const rootStatus = await lstat(root);
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error("DSL draft snapshot root must be a real directory.");
  }
  const canonicalRoot = await realpath(root);
  const expected = new Set(resources.map((resource) => resource.relativePath));
  const allowedDirectories = new Set(
    resources.map((resource) => resource.relativePath.split("/")[0]!),
  );
  const actual = new Set<string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !allowedDirectories.has(entry.name)) {
      throw new Error(`Unexpected DSL draft entry: ${entry.name}`);
    }
    const directory = join(root, entry.name);
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const relativePath = `${entry.name}/${child.name}`;
      if (!child.isFile() || child.isSymbolicLink() || !expected.has(relativePath)) {
        throw new Error(`Unexpected DSL draft entry: ${relativePath}`);
      }
      const canonicalFile = await realpath(join(directory, child.name));
      if (!isWithinPath(canonicalRoot, canonicalFile)) {
        throw new Error(`DSL draft file escapes workspace: ${relativePath}`);
      }
      actual.add(relativePath);
    }
  }
  if (actual.size !== expected.size || [...expected].some((path) => !actual.has(path))) {
    throw new Error("DSL draft files were deleted or renamed.");
  }
  const files = new Map<string, { source: string; sha256: string }>();
  for (const path of [...expected].toSorted()) {
    const source = await readFile(join(root, path), "utf8");
    if (Buffer.byteLength(source, "utf8") > 2_000_000) {
      throw new Error(`DSL draft file exceeds 2000000 bytes: ${path}`);
    }
    files.set(path, { source, sha256: sha256(source) });
  }
  const hash = sha256(
    [...files]
      .map(([path, file]) => `${path}\0${file.sha256}\0${Buffer.byteLength(file.source, "utf8")}`)
      .join("\n"),
  );
  return { hash, files };
}

async function scanDslDraftSubmission(
  draft: StoredDslDraft,
  submissionsRoot: string,
): Promise<DslDraftFileSnapshot> {
  if (draft.submissionHash === undefined) {
    throw new Error("DSL draft has no immutable submission.");
  }
  const snapshot = await scanDslDraftFiles(
    join(submissionsRoot, draft.submissionHash),
    draft.resources,
  );
  if (snapshot.hash !== draft.submissionHash) {
    throw new Error("DSL draft submission content hash does not match its identity.");
  }
  return snapshot;
}

async function removeDslDraftSubmission(
  draft: StoredDslDraft,
  submissionsRoot: string,
  hash: string,
): Promise<void> {
  if (draft.submissionHash === hash) return;
  await rm(join(submissionsRoot, hash), { recursive: true, force: true });
}

async function materializeDslDraftReference(input: {
  readonly draft: StoredDslDraft;
  readonly source: string;
}): Promise<string> {
  const destination = join(
    input.draft.workspacePath,
    ".pragma",
    "dsl-drafts",
    input.draft.draftId,
    "reference",
  );
  try {
    await cp(input.source, destination, { recursive: true, errorOnExist: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    const [source, existing] = await Promise.all([
      scanDslDraftFiles(input.source, input.draft.resources),
      scanDslDraftFiles(destination, input.draft.resources),
    ]);
    if (source.hash !== existing.hash) {
      throw new Error("Existing DSL draft reference does not match its source snapshot.", {
        cause: error,
      });
    }
  }
  await makeTreeReadonly(destination);
  return destination;
}

async function makeTreeReadonly(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeTreeReadonly(path);
      await chmod(path, 0o500);
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("DSL draft reference contains an unsupported filesystem entry.");
    }
    await chmod(path, 0o400);
  }
  await chmod(root, 0o500);
}

async function makeTreeWritableForCleanup(root: string): Promise<void> {
  try {
    await chmod(root, 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await makeTreeWritableForCleanup(path);
      } else if (entry.isFile() && !entry.isSymbolicLink()) {
        await chmod(path, 0o600);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function createStableDslDraftSubmission(
  draft: StoredDslDraft,
  frozenWorktree: string,
  submissionsRoot: string,
): Promise<DslDraftFileSnapshot> {
  const first = await scanDslDraftFrozenWorktree(draft, frozenWorktree);
  const second = await scanDslDraftFrozenWorktree(draft, frozenWorktree);
  if (first.hash !== second.hash) throw new Error("DSL draft changed while it was being prepared.");
  const destination = join(submissionsRoot, first.hash);
  try {
    const existing = await scanDslDraftFiles(destination, draft.resources);
    if (existing.hash !== first.hash) {
      throw new Error("DSL draft submission content hash does not match its directory identity.");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ENOENT")) throw error;
    }
  }
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    for (const [path, file] of first.files) {
      const output = join(temporary, path);
      await mkdir(dirname(output), { recursive: true, mode: 0o700 });
      await writeFile(output, file.source, { encoding: "utf8", mode: 0o600 });
    }
    const copied = await scanDslDraftFiles(temporary, draft.resources);
    if (copied.hash !== first.hash) throw new Error("DSL draft snapshot verification failed.");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await rename(temporary, destination);
    return copied;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = await scanDslDraftFiles(destination, draft.resources);
      if (existing.hash !== first.hash) {
        throw new Error(
          "DSL draft submission content hash does not match its directory identity.",
          {
            cause: error,
          },
        );
      }
      return existing;
    }
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

function newDslDraftSkeleton(input: {
  readonly kind: "Expert" | "ExpertTeam";
  readonly id: string;
  readonly name: string;
  readonly description: string;
}): string {
  const metadata = [
    `apiVersion: ${PRAGMA_DSL_WRITE_API_VERSION}`,
    `kind: ${input.kind}`,
    "metadata:",
    `  id: ${input.id}`,
    `  name: ${JSON.stringify(input.name)}`,
    `  description: ${JSON.stringify(input.description)}`,
    "  tags: []",
  ];
  if (input.kind === "Expert") {
    return [
      ...metadata,
      "spec:",
      '  scope: "" # REQUIRED: describe the Expert boundary.',
      '  instructions: "" # REQUIRED: describe the Expert behavior.',
      "  capabilities: []",
      "  toolApprovals: {}",
      "  contextStores: []",
      "  plugins: []",
      "  tools: []",
      "",
    ].join("\n");
  }
  return [
    ...metadata,
    "spec:",
    "  coordinator:",
    '    ref: "" # REQUIRED: use an exact Expert ref.',
    "  members: [] # REQUIRED: add at least one Expert ref.",
    "  instructions: |-",
    "    # Optional shared collaboration instructions.",
    "  contextStores: []",
    "  delegation:",
    "    permissions:",
    "      interact: {}",
    "    maxConcurrency: 4",
    "    maxDepth: 3",
    "    runtimes: {}",
    "",
  ].join("\n");
}

function isWithinPath(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function diagnosticsFromError(error: unknown, source?: string) {
  if (error instanceof DslPreparationError) {
    return [
      {
        severity: "error" as const,
        code: error.code,
        message: error.message,
        ...(source === undefined ? {} : { source }),
        path: [],
      },
    ];
  }
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      severity: "error" as const,
      code: "schema.invalid",
      message: issue.message,
      ...(source === undefined ? {} : { source }),
      path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
    }));
  }
  return [
    {
      severity: "error" as const,
      code: "source.parse",
      message: error instanceof Error ? error.message : String(error),
      ...(source === undefined ? {} : { source }),
      path: [],
    },
  ];
}

class DslPreparationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DslPreparationError";
  }
}

function materializeDraft(draft: PragmaAgentFlowDraft) {
  return {
    ...draft.resource,
    spec: {
      ...draft.resource.spec,
      graph: {
        ...draft.resource.spec.graph,
        start: draft.resource.spec.graph.start ?? "",
      },
    },
  };
}

function materializeEvaluationDraft(
  draft: PragmaAgentEvaluationDraft,
): PragmaFlowRunDryEvaluationResource {
  return PragmaFlowRunDryEvaluationResourceSchema.parse(draft.resource);
}

function summarizeEvaluationDraft(draft: PragmaAgentEvaluationDraft) {
  return PragmaAgentEvaluationDraftSummarySchema.parse({
    draftId: draft.draftId,
    baseProjectRevision: draft.baseProjectRevision,
    draftRevision: draft.draftRevision,
    metadata: draft.resource.metadata,
    targetRef: draft.resource.spec.target.ref,
    ...(draft.sourceEvaluationRef === undefined
      ? {}
      : { sourceEvaluationRef: draft.sourceEvaluationRef }),
    caseCount: draft.resource.spec.method.cases.length,
    diagnostics: draft.diagnostics,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  });
}

function evaluationDraftDiagnostics(
  draft: PragmaAgentEvaluationDraft,
): PragmaAgentPrepareResult | undefined {
  if (draft.diagnostics.every((diagnostic) => diagnostic.severity === "warning")) return undefined;
  return PragmaAgentPrepareResultSchema.parse({
    status: "invalid",
    diagnostics: draft.diagnostics.map((diagnostic) => ({
      severity: diagnostic.severity === "warning" ? "warning" : "error",
      code: diagnostic.code,
      message: diagnostic.message,
      path: diagnostic.path,
    })),
  });
}

function invalidEvaluationRun(suite: PragmaFlowRunDrySuiteResult): PragmaAgentPrepareResult {
  const diagnostics = [
    ...suite.cases
      .filter((testCase) => !testCase.passed)
      .flatMap((testCase) =>
        testCase.assertions
          .filter((assertion) => !assertion.passed)
          .map((assertion) => ({
            severity: "error" as const,
            code: `evaluation.case.${assertion.kind}`,
            message: `${testCase.id}: ${assertion.message}`,
            path: ["spec", "method", "cases", testCase.id],
          })),
      ),
    ...(suite.coverage.missing.length === 0
      ? []
      : [
          {
            severity: "error" as const,
            code: "evaluation.coverage.missing",
            message: `Missing Run Dry coverage: ${suite.coverage.missing.join(", ")}`,
            path: ["spec", "method", "cases"],
          },
        ]),
  ];
  return PragmaAgentPrepareResultSchema.parse({ status: "invalid", diagnostics });
}

async function withProjectDraftDiagnostics(
  project: PragmaProjectStore,
  draft: PragmaAgentFlowDraft,
): Promise<PragmaAgentFlowDraft> {
  const resources =
    draft.baseProjectRevision === 0
      ? []
      : (await project.openRevision(draft.baseProjectRevision)).listResources();
  return withDraftDiagnostics(draft, resources);
}

function withDraftDiagnostics(
  draft: PragmaAgentFlowDraft,
  resources: readonly PragmaResource[] = [],
): PragmaAgentFlowDraft {
  const parsed = PragmaAgentFlowDraftSchema.parse(draft);
  const resource = materializeDraft(parsed);
  const diagnostics: PragmaAgentFlowDraftDiagnostic[] = [];
  const stepCount = Object.keys(resource.spec.graph.steps).length;
  if (stepCount === 0) {
    diagnostics.push({
      severity: "incomplete",
      code: "flow.draft.steps_missing",
      message: "Add at least one Flow step.",
      path: ["spec", "graph", "steps"],
    });
  }
  if (resource.spec.graph.start === "") {
    diagnostics.push({
      severity: "incomplete",
      code: "flow.draft.start_missing",
      message: "Choose a Flow start step.",
      path: ["spec", "graph", "start"],
    });
  }
  const schema = PragmaFlowResourceSchema.safeParse(resource);
  if (!schema.success) {
    for (const issue of schema.error.issues) {
      const path = issue.path.filter(
        (segment): segment is string | number => typeof segment !== "symbol",
      );
      if (path.join(".") === "spec.graph.start" && resource.spec.graph.start === "") continue;
      diagnostics.push({
        severity: "error",
        code: "schema.invalid",
        message: issue.message,
        path,
      });
    }
  }
  if (stepCount > 0) {
    const graph = analyzePragmaFlowGraph(resource);
    const missingTransition = graph.issues.some((issue) =>
      issue.code.endsWith("transition.missing"),
    );
    for (const issue of graph.issues) {
      if (issue.code.endsWith("start.unknown") && resource.spec.graph.start === "") continue;
      const incomplete =
        issue.code.endsWith("transition.missing") ||
        (missingTransition &&
          (issue.code.endsWith("step.unreachable") || issue.code.endsWith("loop.not_cyclic")));
      diagnostics.push({
        severity: incomplete ? "incomplete" : "error",
        code: issue.code,
        message: issue.message,
        path: [...issue.path],
      });
    }
  }
  if (schema.success) {
    const resourcesByRef = new Map(
      resources.map((candidate) => [canonicalPragmaResourceRef(candidate), candidate]),
    );
    diagnostics.push(
      ...validatePragmaFlowDataContracts(resource, {
        resolveResource: (ref) => resourcesByRef.get(ref),
      }).map((issue) => ({
        severity: "error" as const,
        code: issue.code,
        message: issue.message,
        path: [...issue.path],
      })),
    );
  }
  const unique = diagnostics.filter(
    (diagnostic, index) =>
      diagnostics.findIndex(
        (candidate) =>
          candidate.code === diagnostic.code &&
          JSON.stringify(candidate.path) === JSON.stringify(diagnostic.path),
      ) === index,
  );
  return PragmaAgentFlowDraftSchema.parse({ ...parsed, diagnostics: unique });
}

function applyDraftOperation(
  resource: PragmaAgentFlowDraft["resource"],
  operation: PragmaAgentFlowDraftOperation,
  baseProjectRevision: number,
): number {
  const graph = resource.spec.graph;
  switch (operation.type) {
    case "set_start":
      graph.start = operation.stepId;
      break;
    case "upsert_step":
      graph.steps[operation.stepId] = operation.step;
      break;
    case "remove_step":
      delete graph.steps[operation.stepId];
      delete graph.transitions[operation.stepId];
      if (graph.start === operation.stepId) delete graph.start;
      break;
    case "set_transition":
      graph.transitions[operation.stepId] = operation.transition;
      break;
    case "remove_transition":
      delete graph.transitions[operation.stepId];
      break;
    case "upsert_loop":
      graph.loops[operation.loopId] = operation.loop;
      break;
    case "remove_loop":
      delete graph.loops[operation.loopId];
      break;
    case "set_contracts":
      if (operation.input === null) delete resource.spec.input;
      else if (operation.input !== undefined) resource.spec.input = operation.input;
      if (operation.output === null) delete resource.spec.output;
      else if (operation.output !== undefined) resource.spec.output = operation.output;
      if (operation.limits !== undefined) resource.spec.limits = operation.limits;
      break;
    case "rebase":
      return operation.projectRevision;
  }
  return baseProjectRevision;
}

function applyEvaluationDraftOperation(
  resource: PragmaAgentEvaluationDraft["resource"],
  operation: PragmaAgentEvaluationDraftOperation,
  baseProjectRevision: number,
): number {
  switch (operation.type) {
    case "upsert_case": {
      const index = resource.spec.method.cases.findIndex(
        (testCase) => testCase.id === operation.case.id,
      );
      if (index === -1) resource.spec.method.cases.push(operation.case);
      else resource.spec.method.cases[index] = operation.case;
      break;
    }
    case "remove_case":
      resource.spec.method.cases = resource.spec.method.cases.filter(
        (testCase) => testCase.id !== operation.caseId,
      );
      break;
    case "rebase":
      return operation.projectRevision;
  }
  return baseProjectRevision;
}

async function readFlowDraft(path: string): Promise<PragmaAgentFlowDraft> {
  const value = await readJson(path);
  if (value === undefined) throw new Error("Flow draft not found.");
  return PragmaAgentFlowDraftSchema.parse(value);
}

async function readEvaluationDraft(path: string): Promise<PragmaAgentEvaluationDraft> {
  const value = await readJson(path);
  if (value === undefined) throw new Error("Evaluation draft not found.");
  return PragmaAgentEvaluationDraftSchema.parse(value);
}

async function readCandidate(path: string): Promise<z.infer<typeof CandidateRecordSchema>> {
  const value = await readJson(path);
  if (value === undefined) throw new Error("Prepared DSL change-set not found.");
  return CandidateRecordSchema.parse(value);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
