import { createHash, randomUUID } from "node:crypto";
import {
  cp,
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
  analyzePragmaFlowGraph,
  validatePragmaFlowDataContracts,
  PragmaFlowResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaFlowResource,
  type PragmaFlowRunDryEvaluationResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  PragmaAgentChangeSetSchema,
  PragmaAgentDslDraftInspectionSchema,
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
  type PragmaAgentDslDraftTargetInput,
  type PragmaAgentEvaluationDraft,
  type PragmaAgentEvaluationDraftDiagnostic,
  type PragmaAgentEvaluationDraftOperation,
  type PragmaAgentExpertOptionCatalog,
  type PragmaAgentFlowDraft,
  type PragmaAgentFlowDraftDiagnostic,
  type PragmaAgentFlowDraftOperation,
  type PragmaAgentPrepareResult,
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

const CandidateRecordSchema = z.object({
  changeSet: PragmaAgentChangeSetSchema,
  resources: z.array(PragmaForwardCompatibleResourceSchema),
});

const StoredDslDraftResourceSchema = PragmaAgentDslDraftSchema.shape.resources.element.extend({
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

const DslDraftDiscardJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.dsl-draft-discard/v1"),
    draftId: z.string().uuid(),
    source: z.string().min(1).max(4_000),
    trash: z.string().min(1).max(4_000),
    state: z.enum(["prepared", "completed"]),
  })
  .strict();
type DslDraftDiscardJournal = z.infer<typeof DslDraftDiscardJournalSchema>;

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
  const dslDraftSubmissionsPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "submissions");
  const dslDraftDiscardJournalPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "discard.json");
  const dslDraftMutationLockPath = (id: string) =>
    join(dslDraftsRoot, encodePragmaPathSegment(id), "mutation.lock");

  const prepareResources = async (input: {
    readonly expectedProjectRevision: number;
    readonly authoredResources: readonly PragmaResource[];
  }): Promise<PragmaAgentPrepareResult> => {
    const snapshot = await options.project.get();
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
      const resources = [...authoredResources, ...dependencies];
      const refs = resources.map(canonicalPragmaResourceRef);
      if (new Set(refs).size !== refs.length) {
        return invalidPrepare("resource.duplicate", "A change-set cannot repeat a ref.");
      }
      assertExpertSelectionsAvailable(authoredResources, snapshot.resources, resources, catalog);
      const diagnostics = await options.project.validateChanges({
        baseRevision: input.expectedProjectRevision,
        upserts: resources,
      });
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return PragmaAgentPrepareResultSchema.parse({ status: "invalid", diagnostics });
      }
      const existing = new Set(snapshot.resources.map(canonicalPragmaResourceRef));
      const changeSet = PragmaAgentChangeSetSchema.parse({
        changeSetId: randomUUID(),
        projectRevision: input.expectedProjectRevision,
        diagnostics,
        changes: resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: existing.has(canonicalPragmaResourceRef(resource)) ? "updated" : "created",
          source: formatPragmaYaml(resource),
        })),
        createdAt: new Date().toISOString(),
      });
      await writeJson(candidatePath(changeSet.changeSetId), { changeSet, resources });
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

  const readDslDraftRecord = async (draftId: string): Promise<StoredDslDraft> =>
    StoredDslDraftSchema.parse(
      JSON.parse(await readFile(dslDraftRecordPath(draftId), "utf8")) as unknown,
    );

  const writeDslDraft = async (draft: StoredDslDraft): Promise<void> =>
    await writeJson(dslDraftRecordPath(draft.draftId), StoredDslDraftSchema.parse(draft));

  const moveDslDraftToTrash = async (journal: DslDraftDiscardJournal): Promise<void> => {
    await mkdir(dirname(journal.trash), { recursive: true, mode: 0o700 });
    try {
      await rename(journal.source, journal.trash);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EXDEV") {
        await cp(journal.source, journal.trash, { recursive: true, errorOnExist: true });
        await rm(journal.source, { recursive: true, force: true });
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
    const trashName = relative(resolve(dslDraftsTrashRoot), resolve(journal.trash));
    if (
      resolve(journal.source) !== resolve(expectedSource) ||
      isAbsolute(trashName) ||
      trashName.includes(sep) ||
      !trashName.startsWith(`${draftId}-`)
    ) {
      throw new Error("DSL draft discard journal contains an invalid path.");
    }
    if (journal.state === "prepared") {
      await moveDslDraftToTrash(journal);
      journal = DslDraftDiscardJournalSchema.parse({ ...journal, state: "completed" });
      await writeJson(journalPath, journal);
    }
    if (draft.state !== "discarded") {
      if (draft.state === "prepared") {
        throw new Error("A prepared DSL draft cannot be discarded.");
      }
      await writeDslDraft(
        StoredDslDraftSchema.parse({
          ...draft,
          state: "discarded",
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

  const readDslDraft = async (draftId: string): Promise<StoredDslDraft> => {
    await recoverDslDraftDiscard(draftId);
    return await readDslDraftRecord(draftId);
  };

  const requireDslDraftOwner = (draft: StoredDslDraft, missionId: string): void => {
    if (draft.missionId !== missionId) throw new Error("DSL draft is owned by another Mission.");
  };

  const toPublicDslDraft = (draft: StoredDslDraft): PragmaAgentDslDraft => {
    const visibleRoot =
      draft.submissionHash === undefined
        ? dslDraftWorktreePath(draft)
        : join(dslDraftSubmissionsPath(draft.draftId), draft.submissionHash);
    return PragmaAgentDslDraftSchema.parse({
      schemaVersion: draft.schemaVersion,
      draftId: draft.draftId,
      missionId: draft.missionId,
      baseProjectRevision: draft.baseProjectRevision,
      state: draft.state,
      ...(draft.state === "editing" ? { draftPath: dslDraftWorktreePath(draft) } : {}),
      ...(draft.submissionHash === undefined
        ? {}
        : {
            referencePath: join(dslDraftSubmissionsPath(draft.draftId), draft.submissionHash),
          }),
      resources: draft.resources.map((resource) => ({
        mode: resource.mode,
        ref: resource.ref,
        kind: resource.kind,
        name: resource.name,
        relativePath: resource.relativePath,
        filePath: join(visibleRoot, resource.relativePath),
        ...(resource.key === undefined ? {} : { key: resource.key }),
      })),
      ...(draft.preparedChangeSetId === undefined
        ? {}
        : { preparedChangeSetId: draft.preparedChangeSetId }),
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

  const inspectDslDraft = async (draft: StoredDslDraft) => {
    const snapshot = await scanDslDraftFiles(
      draft.submissionHash === undefined
        ? dslDraftWorktreePath(draft)
        : join(dslDraftSubmissionsPath(draft.draftId), draft.submissionHash),
      draft.resources,
    );
    const conflictingRefs = await staleDslDraftRefs(draft);
    return PragmaAgentDslDraftInspectionSchema.parse({
      ...toPublicDslDraft(draft),
      workingTreeHash: snapshot.hash,
      stale: conflictingRefs.length > 0,
      conflictingRefs,
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

  const startDslDraft = async (input: {
    readonly missionId: string;
    readonly workspacePath: string;
    readonly targets: readonly PragmaAgentDslDraftTargetInput[];
    readonly fixedCreates?: ReadonlyMap<
      string,
      { readonly ref: string; readonly id: string; readonly description: string }
    >;
  }): Promise<StoredDslDraft> => {
    const workspacePath = await resolveDslDraftWorkspace(input.workspacePath);
    const snapshot = await options.project.get();
    const draftId = randomUUID();
    const worktreePath = dslDraftWorktreePath({ draftId, workspacePath });
    const usedIds = new Set(snapshot.resources.map((resource) => resource.metadata.id));
    const usedRefs = new Set<string>();
    const usedKeys = new Set<string>();
    const prepared: Array<{
      readonly target: StoredDslDraft["resources"][number];
      readonly source: string;
    }> = [];
    try {
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
      return draft;
    } catch (error) {
      await rm(join(workspacePath, ".pragma", "dsl-drafts", draftId), {
        recursive: true,
        force: true,
      });
      await rm(dirname(dslDraftRecordPath(draftId)), { recursive: true, force: true });
      throw error;
    }
  };

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
      const drafts = (
        await Promise.all(
          names.map(async (name) => {
            try {
              const draftId = decodePragmaPathSegment(name);
              await recoverDslDraftDiscard(draftId);
              return await readDslDraftRecord(draftId);
            } catch {
              return undefined;
            }
          }),
        )
      )
        .filter((draft): draft is StoredDslDraft => draft?.missionId === input.missionId)
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
      return await inspectDslDraft(draft);
    },
    async prepareDslDraft(input) {
      return await withFileLock(dslDraftMutationLockPath(input.draftId), async () => {
        const draft = await readDslDraft(input.draftId);
        requireDslDraftOwner(draft, input.missionId);
        if (draft.state !== "editing") throw new Error("DSL draft is not editable.");
        const conflictingRefs = await staleDslDraftRefs(draft);
        if (conflictingRefs.length > 0) {
          const snapshot = await createStableDslDraftSubmission(
            draft,
            dslDraftSubmissionsPath(draft.draftId),
          );
          await writeDslDraft(
            StoredDslDraftSchema.parse({
              ...draft,
              state: "conflicted",
              submissionHash: snapshot.hash,
              updatedAt: new Date().toISOString(),
            }),
          );
          await rm(dslDraftWorktreePath(draft), { recursive: true, force: true });
          return invalidPrepare(
            "project.resource_conflict",
            `Draft targets changed after the draft started: ${conflictingRefs.join(", ")}.`,
          );
        }
        const snapshot = await createStableDslDraftSubmission(
          draft,
          dslDraftSubmissionsPath(draft.draftId),
        );
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
        });
        if (result.status !== "prepared") return result;
        const next = StoredDslDraftSchema.parse({
          ...draft,
          state: "prepared",
          submissionHash: snapshot.hash,
          preparedChangeSetId: result.changeSet.changeSetId,
          updatedAt: new Date().toISOString(),
        });
        await writeDslDraft(next);
        await rm(dslDraftWorktreePath(draft), { recursive: true, force: true });
        return result;
      });
    },
    async restartDslDraft(input) {
      return await withFileLock(dslDraftMutationLockPath(input.draftId), async () => {
        const current = await readDslDraft(input.draftId);
        requireDslDraftOwner(current, input.missionId);
        const canRestartPrepared =
          current.state === "prepared" && (await divergentPreparedDslDraftRefs(current)).length > 0;
        if (current.state !== "conflicted" && !canRestartPrepared) {
          throw new Error("Only a conflicted or stale prepared DSL draft can be restarted.");
        }
        if (current.submissionHash === undefined) {
          throw new Error("Restartable DSL draft is missing its immutable reference snapshot.");
        }
        const targets: PragmaAgentDslDraftTargetInput[] = current.resources.map((target) =>
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
          current.resources.flatMap((target) =>
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
          missionId: current.missionId,
          workspacePath: current.workspacePath,
          targets,
          fixedCreates,
        });
        const oldCandidate = join(dslDraftSubmissionsPath(current.draftId), current.submissionHash);
        await writeDslDraft(
          StoredDslDraftSchema.parse({
            ...current,
            state: "discarded",
            updatedAt: new Date().toISOString(),
          }),
        );
        return PragmaAgentDslDraftSchema.parse({
          ...toPublicDslDraft(replacement),
          referencePath: oldCandidate,
        });
      });
    },
    async discardDslDraft(input) {
      await withFileLock(dslDraftMutationLockPath(input.draftId), async () => {
        const draft = await readDslDraft(input.draftId);
        requireDslDraftOwner(draft, input.missionId);
        if (draft.state === "discarded") return;
        if (draft.state === "prepared")
          throw new Error("A prepared DSL draft cannot be discarded.");
        const source = join(draft.workspacePath, ".pragma", "dsl-drafts", draft.draftId);
        const trash = join(dslDraftsTrashRoot, `${draft.draftId}-${Date.now()}`);
        const journalPath = dslDraftDiscardJournalPath(draft.draftId);
        const journal = DslDraftDiscardJournalSchema.parse({
          schemaVersion: "pragma.dsl-draft-discard/v1",
          draftId: draft.draftId,
          source,
          trash,
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
    async getChangeSet(changeSetId) {
      return (await readCandidate(candidatePath(changeSetId))).changeSet;
    },
    async commit(input) {
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const completed = await readJson(path);
        if (completed !== undefined) return PragmaAgentProjectCommitSchema.parse(completed);
        const candidate = await readCandidate(candidatePath(input.changeSetId));
        if (candidate.changeSet.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          throw new Error("The prepared DSL change-set contains validation errors.");
        }
        const snapshot = await options.project.get();
        const catalog = await buildExpertCatalog(options);
        assertExpertSelectionsAvailable(
          candidate.resources,
          snapshot.resources,
          candidate.resources,
          catalog,
        );
        const published = await options.project.apply({
          baseRevision: candidate.changeSet.projectRevision,
          upserts: candidate.resources,
        });
        const result = PragmaAgentProjectCommitSchema.parse({
          projectId: published.projectId,
          projectRevision: published.revision,
          changedRefs: candidate.changeSet.changes.map((change) => change.ref),
        });
        await writeJson(path, result);
        return result;
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
  const [availability, capabilities] = await Promise.all([
    getRuntimeAvailability(options.runtimes),
    listCapabilitiesWithBuiltIns(options.capabilities),
  ]);
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
  const readyCapabilities = capabilities.filter(
    (capability) => capability.health.status === "ready",
  );
  const capabilityOptions = readyCapabilities.map((capability) => {
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
    readyCapabilityIds: new Set(readyCapabilities.map((capability) => capability.manifest.id)),
  };
}

function capabilityResource(capability: Capability): PragmaResource {
  return createDesktopCapabilityResource({
    owner: "default-agent-option",
    capabilityId: capability.manifest.id,
    revision: capability.manifest.latestRevision,
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
      if (binding !== undefined && !catalog.readyCapabilityIds.has(binding.id)) {
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
  return await scanDslDraftFiles(dslDraftWorktreePath(draft), draft.resources);
}

async function scanDslDraftFiles(
  root: string,
  resources: StoredDslDraft["resources"],
): Promise<DslDraftFileSnapshot> {
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

async function createStableDslDraftSubmission(
  draft: StoredDslDraft,
  submissionsRoot: string,
): Promise<DslDraftFileSnapshot> {
  const first = await scanDslDraftWorktree(draft);
  const second = await scanDslDraftWorktree(draft);
  if (first.hash !== second.hash) throw new Error("DSL draft changed while it was being prepared.");
  const destination = join(submissionsRoot, first.hash);
  try {
    return await scanDslDraftFiles(destination, draft.resources);
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
      return await scanDslDraftFiles(destination, draft.resources);
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
