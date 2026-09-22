import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaFlowRunDryCaseSchema } from "@pragma/evaluation/ast";
import { encodePragmaPathSegment } from "@pragma/core";
import { PRAGMA_TEXT_LIMITS } from "@pragma/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  PragmaFlowResourceSchema,
  PragmaRuntimeProfileResourceSchema,
} from "@pragma/interpreter/ast";

import type { Capability } from "../../../shared/contracts/index.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createDesktopPragmaAgentProjectPort } from "./pragma-agent-project-adapter.ts";
import { createExpertDefinitionStore } from "../experts/expert-definition-store.ts";
import { createDesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { RuntimeEnvironmentService } from "../runtimes/runtime-environment-service.ts";

const temporaryRoots: string[] = [];

const removeTemporaryRoot = async (root: string): Promise<void> => {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(removeTemporaryRoot));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

describe("Desktop PragmaAgent DSL project adapter", { timeout: 30_000 }, () => {
  it("edits one prompt fragment through a Mission-owned file draft", async () => {
    const root = await temporaryRoot("pragma-dsl-file-draft-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const initial = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Original", runtimeRef)],
      }),
    );
    await adapter.commit({ changeSetId: initial.changeSetId, operationId: "initial" });

    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [{ mode: "edit", ref: "expert:1xddvess309a6gme" }],
    });
    const file = draft.resources[0]!.filePath!;
    const before = await readFile(file, "utf8");
    await expect(adapter.listDslDrafts({ missionId, limit: 25 })).resolves.toMatchObject({
      items: [expect.objectContaining({ draftId: draft.draftId, state: "editing" })],
    });
    await expect(
      adapter.inspectDslDraft({
        missionId: "4fc96ef9-1825-447d-a17f-d820f6fd4855",
        draftId: draft.draftId,
      }),
    ).rejects.toThrow("owned by another Mission");
    await writeFile(file, before.replace("1xddvess309a6gme", "2h3j4k5m6n7p8q9r"));
    await expect(
      adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "resource.identity_changed" })],
    });
    await expect(
      readdir(
        join(
          root,
          "state",
          "dsl-resource-drafts",
          encodePragmaPathSegment(draft.draftId),
          "submissions",
        ),
      ),
    ).resolves.toEqual([]);
    await writeFile(file, before.replace("Write concise text.", "Write concise copy."));

    await expect(
      adapter.inspectDslDraft({ missionId, draftId: draft.draftId }),
    ).resolves.toMatchObject({
      stale: false,
      changes: [{ ref: "expert:1xddvess309a6gme", changed: true }],
    });
    const concurrentPrepare = await Promise.allSettled([
      adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
      adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
    ]);
    const prepared = requirePrepared(
      concurrentPrepare.find(
        (
          result,
        ): result is PromiseFulfilledResult<Awaited<ReturnType<typeof adapter.prepareDslDraft>>> =>
          result.status === "fulfilled",
      )!.value,
    );
    expect(concurrentPrepare.filter((result) => result.status === "rejected")).toHaveLength(1);
    await adapter.commit({ changeSetId: prepared.changeSetId, operationId: "draft-edit" });
    const saved = await adapter.read("expert:1xddvess309a6gme");
    expect(saved.source).toContain("Write concise copy.");
    expect(saved.source).toContain("description: Original");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.listDslDrafts({ missionId, limit: 25 })).resolves.toMatchObject({
      items: [
        expect.objectContaining({
          draftId: draft.draftId,
          state: "committed",
          committedProjectRevision: 2,
        }),
      ],
    });
    await expect(adapter.inspectDslDraft({ missionId, draftId: draft.draftId })).rejects.toThrow(
      "already committed",
    );
  });

  it("invalidates a prepared change-set before discard can leave the Project mutated", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-stale-change-set-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const initial = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Original", runtimeRef)],
      }),
    );
    await adapter.commit({ changeSetId: initial.changeSetId, operationId: "discard-base" });
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";

    const prepareDraft = async () => {
      const draft = await adapter.startDslDraft({
        missionId,
        workspacePath: root,
        targets: [{ mode: "edit" as const, ref: "expert:1xddvess309a6gme" }],
      });
      const file = draft.resources[0]!.filePath!;
      await writeFile(
        file,
        (await readFile(file, "utf8")).replace("Write concise text.", "Write safely."),
      );
      return {
        draft,
        changeSet: requirePrepared(
          await adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
        ),
      };
    };

    const discarded = await prepareDraft();
    const beforeDiscardedCommit = await project.get();
    await adapter.discardDslDraft({ missionId, draftId: discarded.draft.draftId });
    await expect(
      adapter.commit({
        changeSetId: discarded.changeSet.changeSetId,
        operationId: "discarded-change-set",
      }),
    ).rejects.toThrow("no longer matches");
    await expect(project.get()).resolves.toEqual(beforeDiscardedCommit);

    const racing = await prepareDraft();
    const outcomes = await Promise.allSettled([
      adapter.commit({ changeSetId: racing.changeSet.changeSetId, operationId: "racing-commit" }),
      adapter.discardDslDraft({ missionId, draftId: racing.draft.draftId }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const finalProject = await project.get();
    const finalDraft = (await adapter.listDslDrafts({ missionId, limit: 25 })).items.find(
      (item) => item.draftId === racing.draft.draftId,
    )!;
    if (outcomes[0]!.status === "fulfilled") {
      expect(finalProject.revision).toBe(2);
      expect(finalDraft.state).toBe("committed");
    } else {
      expect(finalProject).toEqual(beforeDiscardedCommit);
      expect(finalDraft.state).toBe("discarded");
    }
  });

  it("atomically detaches the editable worktree before project validation", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-atomic-freeze-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const initial = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Original", runtimeRef)],
      }),
    );
    await adapter.commit({ changeSetId: initial.changeSetId, operationId: "freeze-base" });
    const originalValidate = project.validateChanges.bind(project);
    let announceValidation!: () => void;
    let releaseValidation!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
      announceValidation = resolve;
    });
    const validationRelease = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    Object.defineProperty(project, "validateChanges", {
      configurable: true,
      value: async (input: Parameters<typeof project.validateChanges>[0]) => {
        announceValidation();
        await validationRelease;
        return await originalValidate(input);
      },
    });
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [{ mode: "edit", ref: "expert:1xddvess309a6gme" }],
    });
    const file = draft.resources[0]!.filePath!;
    await writeFile(file, (await readFile(file, "utf8")).replace("Write concise text.", "Write."));

    const preparing = adapter.prepareDslDraft({ missionId, draftId: draft.draftId });
    await validationStarted;
    await expect(writeFile(file, "late edit\n")).rejects.toMatchObject({ code: "ENOENT" });
    releaseValidation();
    await expect(preparing).resolves.toMatchObject({ status: "prepared" });
  });

  it("rebases a draft across unrelated project revisions but rejects a changed target", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-conflict-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const initial = requirePrepared(
      await adapter.prepare({ expectedProjectRevision: 0, sources: [expert("First", runtimeRef)] }),
    );
    await adapter.commit({ changeSetId: initial.changeSetId, operationId: "base" });
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const unrelatedDraft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [{ mode: "edit", ref: "expert:1xddvess309a6gme" }],
    });
    const unrelatedDraftFile = unrelatedDraft.resources[0]!.filePath!;
    await writeFile(
      unrelatedDraftFile,
      (await readFile(unrelatedDraftFile, "utf8")).replace(
        "Write concise text.",
        "Write concise copy.",
      ),
    );
    const unrelated = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 1,
        sources: [
          expert("Other", runtimeRef, "2h3j4k5m6n7p8q9r").replace(
            "name: Writer",
            "name: Other Writer",
          ),
        ],
      }),
    );
    await adapter.commit({ changeSetId: unrelated.changeSetId, operationId: "unrelated" });
    const rebased = requirePrepared(
      await adapter.prepareDslDraft({ missionId, draftId: unrelatedDraft.draftId }),
    );
    await expect(
      adapter.commit({ changeSetId: rebased.changeSetId, operationId: "draft-unrelated" }),
    ).resolves.toMatchObject({ projectRevision: 3 });
    await expect(
      adapter.restartDslDraft({ missionId, draftId: unrelatedDraft.draftId }),
    ).rejects.toThrow("Only a conflicted or stale prepared DSL draft can be restarted");

    const conflictingDraft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [{ mode: "edit", ref: "expert:1xddvess309a6gme" }],
    });
    const changed = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 3,
        sources: [expert("Changed elsewhere", runtimeRef)],
      }),
    );
    await adapter.commit({ changeSetId: changed.changeSetId, operationId: "conflict" });
    await expect(
      adapter.prepareDslDraft({ missionId, draftId: conflictingDraft.draftId }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "project.resource_conflict" })],
    });
    const conflictedInspection = await adapter.inspectDslDraft({
      missionId,
      draftId: conflictingDraft.draftId,
    });
    expect(conflictedInspection).toMatchObject({ state: "conflicted", stale: true });
    expect(conflictedInspection).not.toHaveProperty("referencePath");
    await expect(readFile(conflictingDraft.resources[0]!.filePath!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const replacement = await adapter.restartDslDraft({
      missionId,
      draftId: conflictingDraft.draftId,
    });
    expect(replacement).toMatchObject({ state: "editing", referencePath: expect.any(String) });
    expect(replacement.referencePath).toContain(join(root, ".pragma", "dsl-drafts"));
    expect(replacement.referencePath).not.toContain(join(root, "state"));
    await expect(
      readFile(join(replacement.referencePath!, replacement.resources[0]!.relativePath), "utf8"),
    ).resolves.toContain("kind: Expert");
    await expect(
      adapter.inspectDslDraft({ missionId, draftId: conflictingDraft.draftId }),
    ).rejects.toThrow("already discarded");

    const preparedDraft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [{ mode: "edit", ref: "expert:1xddvess309a6gme" }],
    });
    const preparedFile = preparedDraft.resources[0]!.filePath!;
    await writeFile(
      preparedFile,
      (await readFile(preparedFile, "utf8")).replace(
        "Write concise text.",
        "Write carefully reviewed text.",
      ),
    );
    const preparedBeforeRace = requirePrepared(
      await adapter.prepareDslDraft({ missionId, draftId: preparedDraft.draftId }),
    );
    const changedAfterPrepare = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 4,
        sources: [expert("Changed after prepare", runtimeRef)],
      }),
    );
    await adapter.commit({
      changeSetId: changedAfterPrepare.changeSetId,
      operationId: "changed-after-prepare",
    });
    await expect(
      adapter.commit({ changeSetId: preparedBeforeRace.changeSetId, operationId: "stale-draft" }),
    ).rejects.toThrow();
    await expect(
      adapter.restartDslDraft({ missionId, draftId: conflictingDraft.draftId }),
    ).rejects.toThrow("Only a conflicted or stale prepared DSL draft can be restarted");
    await expect(
      adapter.restartDslDraft({ missionId, draftId: preparedDraft.draftId }),
    ).resolves.toMatchObject({ state: "editing", referencePath: expect.any(String) });
    const afterRestart = await project.get();
    await expect(
      adapter.commit({
        changeSetId: preparedBeforeRace.changeSetId,
        operationId: "restarted-old-change-set",
      }),
    ).rejects.toThrow("no longer matches");
    await expect(project.get()).resolves.toEqual(afterRestart);
  });

  it("replays an interrupted DSL draft discard journal", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-discard-recovery-");
    const stateRoot = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(adapterOptions(project, stateRoot));
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [
        {
          mode: "create",
          key: "writer",
          kind: "Expert",
          name: "Writer",
          description: "Writes concise text.",
        },
      ],
    });
    const source = join(draft.draftPath!, "..");
    const trash = join(stateRoot, "trash", "dsl-resource-drafts", `${draft.draftId}-recovery`);
    const recordRoot = join(
      stateRoot,
      "dsl-resource-drafts",
      encodePragmaPathSegment(draft.draftId),
    );
    await mkdir(join(stateRoot, "trash", "dsl-resource-drafts"), { recursive: true });
    await cp(source, trash, { recursive: true });
    await mkdir(recordRoot, { recursive: true });
    await writeFile(
      join(recordRoot, "discard.json"),
      JSON.stringify({
        schemaVersion: "pragma.dsl-draft-discard/v1",
        draftId: draft.draftId,
        source,
        trash,
        state: "prepared",
      }),
    );

    const recovered = createDesktopPragmaAgentProjectPort(adapterOptions(project, stateRoot));
    await expect(recovered.listDslDrafts({ missionId, limit: 25 })).resolves.toMatchObject({
      items: [expect.objectContaining({ draftId: draft.draftId, state: "discarded" })],
    });
    await expect(readFile(draft.resources[0]!.filePath!, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(trash, "worktree", draft.resources[0]!.relativePath), "utf8"),
    ).resolves.toContain("kind: Expert");
  });

  it("rejects a symlinked draft root and fails closed on a corrupt known record", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-boundary-");
    const stateRoot = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(adapterOptions(project, stateRoot));
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [
        {
          mode: "create",
          key: "writer",
          kind: "Expert",
          name: "Writer",
          description: "Writes concise text.",
        },
      ],
    });
    const external = join(root, "external-draft");
    await mkdir(join(external, "experts"), { recursive: true });
    await writeFile(join(external, draft.resources[0]!.relativePath), "kind: Expert\n");
    await rm(draft.draftPath!, { recursive: true });
    await symlink(external, draft.draftPath!, "dir");

    await expect(adapter.prepareDslDraft({ missionId, draftId: draft.draftId })).rejects.toThrow(
      "real directory",
    );

    await writeFile(
      join(stateRoot, "dsl-resource-drafts", encodePragmaPathSegment(draft.draftId), "draft.json"),
      "{",
    );
    await expect(adapter.listDslDrafts({ missionId, limit: 25 })).rejects.toThrow();
  });

  it("verifies an immutable prepared submission against its content-addressed identity", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-submission-integrity-");
    const stateRoot = join(root, "state");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(adapterOptions(project, stateRoot));
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const initial = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Original", runtimeRef)],
      }),
    );
    await adapter.commit({ changeSetId: initial.changeSetId, operationId: "integrity-base" });
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [{ mode: "edit", ref: "expert:1xddvess309a6gme" }],
    });
    const file = draft.resources[0]!.filePath!;
    await writeFile(file, (await readFile(file, "utf8")).replace("Write concise text.", "Write."));
    const hash = (await adapter.inspectDslDraft({ missionId, draftId: draft.draftId }))
      .workingTreeHash;
    requirePrepared(await adapter.prepareDslDraft({ missionId, draftId: draft.draftId }));
    await writeFile(
      join(
        stateRoot,
        "dsl-resource-drafts",
        encodePragmaPathSegment(draft.draftId),
        "submissions",
        hash,
        draft.resources[0]!.relativePath,
      ),
      "tampered\n",
    );

    await expect(adapter.inspectDslDraft({ missionId, draftId: draft.draftId })).rejects.toThrow(
      "content hash",
    );
  });

  it("allocates IDs and prepares new Expert and ExpertTeam files atomically", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-create-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [
        {
          mode: "create",
          key: "writer",
          kind: "Expert",
          name: "Writer",
          description: "Writes concise text.",
        },
        {
          mode: "create",
          key: "team",
          kind: "ExpertTeam",
          name: "Writing Team",
          description: "Coordinates writing.",
        },
      ],
    });
    const writer = draft.resources.find((resource) => resource.key === "writer")!;
    const team = draft.resources.find((resource) => resource.key === "team")!;
    expect(writer.ref).toMatch(/^expert:[0-9a-hj-km-np-tv-z]{16}$/u);
    expect(team.ref).toMatch(/^team:[0-9a-hj-km-np-tv-z]{16}$/u);
    await expect(
      adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
    ).resolves.toMatchObject({
      status: "invalid",
    });

    await writeFile(
      writer.filePath!,
      expert("Writes concise text.", runtimeRef, writer.ref.slice("expert:".length)),
    );
    await writeFile(team.filePath!, expertTeam(team.ref.slice("team:".length), writer.ref));
    const prepared = requirePrepared(
      await adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
    );
    expect(prepared.changes.map((change) => change.ref)).toEqual(
      expect.arrayContaining([writer.ref, team.ref, runtimeRef]),
    );
  });

  it("allocates a fresh create ID when a conflicted draft ID was occupied", async () => {
    const root = await temporaryRoot("pragma-dsl-draft-create-conflict-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const missionId = "ed1bcbb5-b1e6-4aa5-9357-7853ce745f6b";
    const draft = await adapter.startDslDraft({
      missionId,
      workspacePath: root,
      targets: [
        {
          mode: "create",
          key: "writer",
          kind: "Expert",
          name: "Writer",
          description: "Writes concise text.",
        },
      ],
    });
    const originalRef = draft.resources[0]!.ref;
    const occupied = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Occupied", runtimeRef, originalRef.slice("expert:".length))],
      }),
    );
    await adapter.commit({ changeSetId: occupied.changeSetId, operationId: "occupy-draft-id" });
    await expect(
      adapter.prepareDslDraft({ missionId, draftId: draft.draftId }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "project.resource_conflict" })],
    });

    const replacement = await adapter.restartDslDraft({ missionId, draftId: draft.draftId });
    expect(replacement.resources[0]!.ref).not.toBe(originalRef);
  });

  it("creates and updates the same exact ref through immutable project revisions", async () => {
    const root = await temporaryRoot("pragma-default-agent-project-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const first = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("First", runtimeRef)],
      }),
    );
    expect(first.diagnostics).toEqual([]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "expert:1xddvess309a6gme", kind: "created" }),
        expect.objectContaining({ ref: runtimeRef, kind: "created" }),
      ]),
    );
    await expect(
      adapter.commit({ changeSetId: first.changeSetId, operationId: "first" }),
    ).resolves.toMatchObject({ projectRevision: 1 });

    const second = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Second", runtimeRef)],
      }),
    );
    expect(second.changes).toMatchObject([{ ref: "expert:1xddvess309a6gme", kind: "updated" }]);
    const committed = await adapter.commit({
      changeSetId: second.changeSetId,
      operationId: "second",
    });
    expect(committed.projectRevision).toBe(2);
    expect((await adapter.read("expert:1xddvess309a6gme")).source).toContain("Second");
  });

  it("replays a committed operation idempotently", async () => {
    const root = await temporaryRoot("pragma-default-agent-idempotent-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const candidate = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("One", runtimeRef)],
      }),
    );
    const first = await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "same" });
    const second = await adapter.commit({
      changeSetId: candidate.changeSetId,
      operationId: "same",
    });
    expect(second).toEqual(first);
    expect((await project.get()).revision).toBe(1);
  });

  it("exposes only available models and ready capabilities through the portable port", async () => {
    const root = await temporaryRoot("pragma-default-agent-options-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state"), [
        capability("00000000-0000-4000-8000-000000000001", "ready"),
        capability("00000000-0000-4000-8000-000000000002", "needs_attention"),
      ]),
    );

    const runtimeModels = await adapter.listExpertOptions({
      category: "runtime-models",
      limit: 25,
    });
    const capabilities = await adapter.listExpertOptions({ category: "capabilities", limit: 25 });
    const avatars = await adapter.listExpertOptions({ category: "avatars", limit: 25 });
    const builtinExperts = await adapter.listExpertOptions({
      category: "builtin-experts",
      limit: 25,
    });

    expect(runtimeModels.items).toEqual([
      expect.objectContaining({
        runtimeName: "Test Runtime",
        providerName: "Test",
        modelName: "Test Model",
        isDefault: true,
      }),
    ]);
    expect(capabilities.items).toEqual([
      expect.objectContaining({
        name: "Pragma management tools",
        kind: "tools",
        toolNames: expect.arrayContaining([
          "knowledge_revision_list_targets",
          "knowledge_revision_list_drafts",
          "knowledge_revision_start",
          "knowledge_revision_get_draft",
          "knowledge_revision_inspect_rebase",
          "knowledge_revision_rebase",
          "knowledge_revision_submit_draft",
          "knowledge_revision_discard_draft",
        ]),
      }),
      expect.objectContaining({
        name: "Repository access",
        kind: "skill",
        toolNames: [],
      }),
    ]);
    expect(avatars.items).toHaveLength(25);
    expect(avatars.items[0]).toEqual({
      avatarId: "pragma.avatar.expert.07",
      name: "Ada",
      gender: "woman",
      personality: ["meticulous", "analytical", "focused"],
    });
    expect(builtinExperts.items).toEqual([
      expect.objectContaining({
        ref: "expert:0000000000pragma",
        name: "Pragma",
        model: { mode: "system-default" },
        assignableAs: ["team-member", "coordinator"],
        origin: "system",
        readOnly: true,
      }),
      expect.objectContaining({
        ref: "expert:0000000000sk1rev",
        name: "Skill Revision Agent",
        model: { mode: "system-default" },
        assignableAs: ["team-member", "coordinator"],
        origin: "system",
        readOnly: true,
      }),
      expect.objectContaining({
        ref: "expert:0000000000st0rev",
        name: "Store Revision Agent",
        model: { mode: "system-default" },
        assignableAs: ["team-member", "coordinator"],
        origin: "system",
        readOnly: true,
      }),
    ]);
  });

  it("reads built-in Experts through the DSL port without exposing them as project resources", async () => {
    const root = await temporaryRoot("pragma-default-agent-system-expert-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );

    await expect(adapter.list({ limit: 25 })).resolves.toEqual({ projectRevision: 0, items: [] });
    await expect(adapter.read("expert:0000000000st0rev")).resolves.toMatchObject({
      ref: "expert:0000000000st0rev",
      kind: "Expert",
      name: "Store Revision Agent",
      projectRevision: 0,
      origin: "system",
      readOnly: true,
      source: expect.stringContaining("id: 0000000000st0rev"),
    });
  });

  it("reuses an existing compatible project RuntimeProfile without creating a duplicate", async () => {
    const root = await temporaryRoot("pragma-default-agent-existing-runtime-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const runtime = PragmaRuntimeProfileResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: {
        id: "2h3j4k5m6n7p8q9r",
        name: "Existing Writer Runtime",
        description: "A project RuntimeProfile that already selects the requested model.",
        tags: [],
      },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: {
          runtimeId: "test",
          providerId: "test",
          model: "model",
        },
      },
    });
    await project.publish({ expectedRevision: 0, resources: [runtime] });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const runtimeRef = "runtime-profile:2h3j4k5m6n7p8q9r";

    const prepared = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Uses the existing RuntimeProfile", runtimeRef)],
      }),
    );

    expect(prepared.changes).toEqual([
      expect.objectContaining({
        ref: "expert:1xddvess309a6gme",
        kind: "created",
      }),
    ]);
    expect(prepared.changes.some((change) => change.ref === runtimeRef)).toBe(false);
  });

  it("creates a 16-character Expert that Desktop can list and open, and rejects 17", async () => {
    const root = await temporaryRoot("pragma-default-agent-expert-id-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const experts = createExpertDefinitionStore({
      project,
      systemExperts: createDesktopSystemExpertRegistry(),
      validateModel: async () => undefined,
    });
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    const acceptedId = "a".repeat(16);
    const candidate = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [expert("Boundary", runtimeRef, acceptedId)],
      }),
    );

    await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "boundary" });

    expect((await experts.list()).map((value) => value.id)).toContain(acceptedId);
    await expect(experts.get(`expert:${acceptedId}`)).resolves.toMatchObject({
      id: acceptedId,
      description: "Boundary",
    });
    await expect(
      adapter.prepare({
        expectedProjectRevision: 1,
        sources: [expert("Too long", runtimeRef, "a".repeat(17))],
      }),
    ).resolves.toMatchObject({ status: "invalid" });
    expect((await project.get()).revision).toBe(1);
  });

  it("prepares a Flow and its later test set in independent commits", async () => {
    const root = await temporaryRoot("pragma-default-agent-flow-draft-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state"), [emptyDescriptionMcpCapability()]),
    );
    const description = "发布审批：验证非空 description";
    const created = await adapter.createFlowDraft({
      expectedProjectRevision: 0,
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Release Gate",
        description,
        tags: [],
      },
    });
    expect(created.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ severity: "incomplete" })]),
    );
    const withStep = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 0,
      operations: [
        {
          type: "upsert_step",
          stepId: "approve",
          step: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Release?" }] },
              options: [
                { value: "ship", label: "Ship" },
                { value: "hold", label: "Hold" },
              ],
            },
          },
        },
      ],
    });
    expect(withStep.draftRevision).toBe(1);
    const graphComplete = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 1,
      operations: [
        { type: "set_start", stepId: "approve" },
        { type: "set_transition", stepId: "approve", transition: { end: true } },
      ],
    });
    expect(graphComplete.diagnostics).toEqual([]);
    await expect(adapter.validateFlowDraft(created.draftId)).resolves.toMatchObject({
      resource: { metadata: { description } },
      diagnostics: [],
    });
    const runtimeRef = (
      (await adapter.listExpertOptions({ category: "runtime-models", limit: 25 })).items[0] as {
        runtimeProfileRef: string;
      }
    ).runtimeProfileRef;
    await expect(
      adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 2,
        additionalSources: [expert("Must use a file draft", runtimeRef)],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "dsl.file_draft_required" })],
    });
    await expect(
      adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 2,
        additionalSources: [evaluationSource(created.resource.metadata.id)],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "evaluation.independent_prepare_required" })],
    });
    const prepared = requirePrepared(
      await adapter.prepareFlowDraft({
        draftId: created.draftId,
        expectedDraftRevision: 2,
      }),
    );
    expect(prepared.changes).toEqual([
      expect.objectContaining({
        ref: expect.stringMatching(/^flow:[0-9a-hjkmnp-tv-z]{16}$/),
        kind: "created",
        source: expect.stringContaining(description),
      }),
    ]);
    const directlyPrepared = requirePrepared(
      await adapter.prepare({
        expectedProjectRevision: 0,
        sources: [prepared.changes[0]!.source],
      }),
    );
    expect(directlyPrepared.changes).toEqual([
      expect.objectContaining({
        ref: prepared.changes[0]!.ref,
        source: expect.stringContaining(description),
      }),
    ]);
    await adapter.commit({ changeSetId: prepared.changeSetId, operationId: "commit-flow-draft" });
    expect(await project.get()).toMatchObject({
      revision: 1,
      resources: [
        expect.objectContaining({
          kind: "Flow",
          metadata: expect.objectContaining({ id: created.resource.metadata.id }),
        }),
      ],
    });

    const evaluation = await adapter.createEvaluationDraft({
      mode: "create",
      expectedProjectRevision: 1,
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Release approval run dry",
        description: "Verifies the release approval path.",
        tags: ["run-dry"],
      },
      targetRef: `flow:${created.resource.metadata.id}`,
    });
    expect(evaluation.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "evaluation.draft.cases_empty" })]),
    );
    const evaluationWithCase = await adapter.updateEvaluationDraft({
      draftId: evaluation.draftId,
      expectedDraftRevision: 0,
      operations: [
        {
          type: "upsert_case",
          case: {
            id: "ship",
            name: "Ship release",
            input: {},
            mocks: {
              approve: {
                expectInput: {},
                expectPrompt: "Release?",
                output: { selection: "ship" },
              },
            },
            expect: {
              status: "succeeded",
              path: ["approve"],
              output: { selection: "ship" },
            },
          },
        },
      ],
    });
    await expect(
      adapter.runEvaluationDraft({
        draftId: evaluation.draftId,
        caseIds: ["ship"],
      }),
    ).resolves.toMatchObject({
      requestedCases: [expect.objectContaining({ id: "ship", passed: true })],
      suite: { passed: true, total: 1, passedCount: 1, failedCount: 0 },
      coverage: { missing: [] },
    });
    const evaluationPrepared = requirePrepared(
      await adapter.prepareEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: evaluationWithCase.draftRevision,
      }),
    );
    expect(evaluationPrepared.changes).toEqual([
      expect.objectContaining({
        ref: "evaluation:7h8j9k0m1n2p3q4r",
        kind: "created",
      }),
    ]);
    await adapter.commit({
      changeSetId: evaluationPrepared.changeSetId,
      operationId: "commit-release-evaluation",
    });
    const snapshot = await project.get();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "Flow" }),
        expect.objectContaining({
          kind: "Evaluation",
          spec: expect.objectContaining({
            target: { ref: `flow:${created.resource.metadata.id}` },
          }),
        }),
      ]),
    );
  });

  it("validates nested Flow input mappings against the draft base revision", async () => {
    const root = await temporaryRoot("pragma-default-agent-nested-flow-draft-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const child = PragmaFlowResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Flow",
      metadata: {
        id: "7k2m9q4v8np6r3dt",
        name: "Child",
        description: "Accepts a typed goal.",
        tags: [],
      },
      spec: {
        input: {
          schema: {
            type: "object",
            properties: { goal: { type: "string" } },
            required: ["goal"],
            additionalProperties: false,
          },
        },
        graph: {
          start: "finish",
          steps: {
            finish: {
              human: {
                selectionMode: "single",
                prompt: { segments: [{ text: "Finish?" }] },
                options: [
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ],
              },
            },
          },
          transitions: { finish: { end: true } },
          loops: {},
        },
      },
    });
    await project.publish({ expectedRevision: 0, resources: [child] });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const created = await adapter.createFlowDraft({
      expectedProjectRevision: 1,
      metadata: {
        id: "9h0j1k2m3n4p5q6r",
        name: "Parent",
        description: "Passes its typed input to a child Flow.",
        tags: [],
      },
      input: {
        schema: {
          type: "object",
          properties: { goal: { type: "number" } },
          required: ["goal"],
          additionalProperties: false,
        },
      },
    });

    const updated = await adapter.updateFlowDraft({
      draftId: created.draftId,
      expectedDraftRevision: 0,
      operations: [
        {
          type: "upsert_step",
          stepId: "child",
          step: { flow: { ref: "flow:7k2m9q4v8np6r3dt" } },
        },
        { type: "set_start", stepId: "child" },
        { type: "set_transition", stepId: "child", transition: { end: true } },
      ],
    });

    expect(updated.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "flow.contract.type_mismatch",
          path: ["spec", "graph", "steps", "child", "input"],
        }),
      ]),
    );
  });

  it("runs selected cases with cumulative coverage and blocks a failing full suite", async () => {
    const root = await temporaryRoot("pragma-default-agent-evaluation-draft-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const flow = approvalRouteFlow();
    expect(await project.validateChanges({ baseRevision: 0, upserts: [flow] })).toEqual([]);
    await project.publish({ expectedRevision: 0, resources: [flow] });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const evaluation = await adapter.createEvaluationDraft({
      mode: "create",
      expectedProjectRevision: 1,
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Approval route Run Dry",
        description: "Covers both approval routes.",
        tags: ["run-dry"],
      },
      targetRef: "flow:8h9j0k1m2n3p4q5r",
    });
    const cases = approvalRouteCases();
    const updated = await adapter.updateEvaluationDraft({
      draftId: evaluation.draftId,
      expectedDraftRevision: 0,
      operations: cases.map((testCase) => ({ type: "upsert_case" as const, case: testCase })),
    });
    await expect(
      adapter.updateEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: updated.draftRevision,
        operations: Array.from({ length: 11 }, (_, index) => ({
          type: "remove_case" as const,
          caseId: `case-${index}`,
        })),
      }),
    ).rejects.toThrow("1 to 10 operations");
    await expect(
      adapter.runEvaluationDraft({
        draftId: evaluation.draftId,
        caseIds: Array.from({ length: 11 }, (_, index) => `case-${index}`),
      }),
    ).rejects.toThrow("1 to 10 unique case IDs");

    await expect(
      adapter.runEvaluationDraft({
        draftId: evaluation.draftId,
        caseIds: ["approve"],
      }),
    ).resolves.toMatchObject({
      requestedCases: [expect.objectContaining({ id: "approve", passed: true })],
      suite: {
        passed: true,
        total: 2,
        passedCount: 2,
        failedCount: 0,
        failedCaseIds: [],
      },
      coverage: { passed: true, missing: [] },
    });
    const prepared = requirePrepared(
      await adapter.prepareEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: updated.draftRevision,
      }),
    );
    await adapter.commit({
      changeSetId: prepared.changeSetId,
      operationId: "commit-evaluation-draft",
    });

    const edit = await adapter.createEvaluationDraft({
      mode: "edit",
      expectedProjectRevision: 2,
      evaluationRef: "evaluation:7h8j9k0m1n2p3q4r",
    });
    const brokenReject = PragmaFlowRunDryCaseSchema.parse({
      ...cases[1],
      expect: { ...cases[1]!.expect, path: ["decision"] },
    });
    const broken = await adapter.updateEvaluationDraft({
      draftId: edit.draftId,
      expectedDraftRevision: 0,
      operations: [{ type: "upsert_case", case: brokenReject }],
    });
    await expect(
      adapter.runEvaluationDraft({ draftId: edit.draftId, caseIds: ["approve"] }),
    ).resolves.toMatchObject({
      requestedCases: [expect.objectContaining({ id: "approve", passed: true })],
      suite: { passed: false, failedCaseIds: ["reject"] },
    });
    await expect(
      adapter.prepareEvaluationDraft({
        draftId: edit.draftId,
        expectedDraftRevision: broken.draftRevision,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [
        expect.objectContaining({
          code: "evaluation.case.path",
          message: expect.stringContaining("reject"),
        }),
      ],
    });
  });

  it("requires an Evaluation draft to target a committed Flow", async () => {
    const root = await temporaryRoot("pragma-default-agent-evaluation-target-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    const evaluation = await adapter.createEvaluationDraft({
      mode: "create",
      expectedProjectRevision: 0,
      metadata: {
        id: "7h8j9k0m1n2p3q4r",
        name: "Uncommitted target",
        description: "Must not attach to an uncommitted Flow draft.",
        tags: [],
      },
      targetRef: "flow:8h9j0k1m2n3p4q5r",
    });

    expect(evaluation.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          code: "evaluation.draft.target_missing",
          message: expect.stringContaining("committed Flow"),
        }),
      ]),
    );
    await expect(
      adapter.prepareEvaluationDraft({
        draftId: evaluation.draftId,
        expectedDraftRevision: evaluation.draftRevision,
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "evaluation.draft.target_missing" }),
      ]),
    });
  });

  it("rejects Evaluation YAML through the generic prepare path", async () => {
    const root = await temporaryRoot("pragma-default-agent-evaluation-generic-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );

    await expect(
      adapter.prepare({
        expectedProjectRevision: 0,
        sources: [evaluationSource("8h9j0k1m2n3p4q5r")],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "evaluation.independent_prepare_required" })],
    });
  });

  it("returns structured prepare diagnostics for malformed YAML", async () => {
    const root = await temporaryRoot("pragma-default-agent-invalid-yaml-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );
    await expect(
      adapter.prepare({ expectedProjectRevision: 0, sources: ["kind: ["] }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [expect.objectContaining({ code: "source.parse", source: "source:0" })],
    });
  });

  it("rejects over-limit Automation fields during prepare", async () => {
    const root = await temporaryRoot("pragma-default-agent-automation-limit-");
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopPragmaAgentProjectPort(
      adapterOptions(project, join(root, "state")),
    );

    await expect(
      adapter.prepare({
        expectedProjectRevision: 0,
        sources: [automationWithPrompt("p".repeat(PRAGMA_TEXT_LIMITS.automation.prompt + 1))],
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      diagnostics: [
        expect.objectContaining({
          code: "schema.invalid",
          path: ["spec", "route", "input", "value"],
        }),
      ],
    });
    expect((await project.get()).revision).toBe(0);
  });
});

function requirePrepared<
  T extends Awaited<ReturnType<ReturnType<typeof createDesktopPragmaAgentProjectPort>["prepare"]>>,
>(result: T) {
  if (result.status !== "prepared") {
    throw new Error(`Expected prepared change-set: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.changeSet;
}

function expert(description: string, runtimeRef: string, id = "1xddvess309a6gme"): string {
  return [
    "apiVersion: pragma/v5",
    "kind: Expert",
    "metadata:",
    `  id: ${id}`,
    "  name: Writer",
    `  description: ${description}`,
    "  tags: []",
    "spec:",
    "  scope: Write.",
    "  instructions: Write concise text.",
    "  runtime:",
    `    ref: ${runtimeRef}`,
    "  capabilities: []",
    "  toolApprovals: {}",
    "  contextStores: []",
    "  plugins: []",
    "  tools: []",
    "",
  ].join("\n");
}

function expertTeam(id: string, expertRef: string): string {
  return [
    "apiVersion: pragma/v5",
    "kind: ExpertTeam",
    "metadata:",
    `  id: ${id}`,
    "  name: Writing Team",
    "  description: Coordinates writing.",
    "  tags: []",
    "spec:",
    "  coordinator:",
    `    ref: ${expertRef}`,
    "  members:",
    `    - ref: ${expertRef}`,
    "  instructions: Collaborate on concise writing.",
    "  contextStores: []",
    "  delegation:",
    "    permissions:",
    "      interact: {}",
    "    maxConcurrency: 2",
    "    maxDepth: 2",
    "    runtimes: {}",
    "",
  ].join("\n");
}

function evaluationSource(flowId: string): string {
  return [
    "apiVersion: pragma/v5",
    "kind: Evaluation",
    "metadata:",
    "  id: 7h8j9k0m1n2p3q4r",
    "  name: Run Dry test set",
    "  description: Must be prepared separately.",
    "  tags: []",
    "spec:",
    `  target: { ref: "flow:${flowId}" }`,
    "  method:",
    "    type: flow-run-dry",
    "    cases:",
    "      - id: ship",
    "        name: Ship",
    "        input: {}",
    "        mocks:",
    "          approve:",
    "            expectInput: {}",
    '            expectPrompt: "Release?"',
    "            output: { selection: ship }",
    "        expect:",
    "          status: succeeded",
    "          path: [approve]",
    "          output: { selection: ship }",
  ].join("\n");
}

function automationWithPrompt(prompt: string): string {
  return [
    "apiVersion: pragma/v5",
    "kind: Automation",
    "metadata:",
    "  id: 55af1v8nmn4j0h3z",
    "  name: Daily review",
    "  description: Reviews the current workspace",
    "  tags: []",
    "spec:",
    "  adapter: pragma.automation.schedule@v1",
    "  binding: binding:desktop-automation",
    "  config:",
    "    trigger:",
    "      kind: calendar",
    "      frequency: daily",
    "      time: 09:00",
    "      timezone: UTC",
    "  enabled: true",
    "  route:",
    "    executor:",
    "      ref: expert:3sfd30h5017wd17d",
    "    input:",
    "      kind: prompt",
    `      value: ${JSON.stringify(prompt)}`,
    "  interaction:",
    "    mode: reuse-session",
    "  delivery:",
    "    adapter: pragma.automation.delivery.local@v1",
    "",
  ].join("\n");
}

function approvalRouteFlow() {
  return PragmaFlowResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: {
      id: "8h9j0k1m2n3p4q5r",
      name: "Approval route",
      description: "Routes an approval decision.",
      tags: [],
    },
    spec: {
      graph: {
        start: "decision",
        steps: {
          decision: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Approve?" }] },
              options: [
                { value: "approve", label: "Approve" },
                { value: "reject", label: "Reject" },
              ],
            },
          },
          approved: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Published" }] },
              options: [
                { value: "done", label: "Done" },
                { value: "back", label: "Back" },
              ],
            },
          },
          rejected: {
            human: {
              selectionMode: "single",
              prompt: { segments: [{ text: "Cancelled" }] },
              options: [
                { value: "done", label: "Done" },
                { value: "back", label: "Back" },
              ],
            },
          },
        },
        transitions: {
          decision: {
            route: "selection",
            cases: { approve: "approved" },
            fallback: "rejected",
          },
          approved: { end: true },
          rejected: { end: true },
        },
        loops: {},
      },
    },
  });
}

function approvalRouteCases() {
  return [
    PragmaFlowRunDryCaseSchema.parse({
      id: "approve",
      name: "Approve",
      input: {},
      mocks: {
        decision: {
          expectInput: {},
          expectPrompt: "Approve?",
          output: { selection: "approve" },
        },
        approved: {
          expectInput: {},
          expectPrompt: "Published",
          output: { selection: "done" },
        },
      },
      expect: {
        status: "succeeded",
        path: ["decision", "approved"],
        output: { selection: "done" },
      },
    }),
    PragmaFlowRunDryCaseSchema.parse({
      id: "reject",
      name: "Reject",
      input: {},
      mocks: {
        decision: {
          expectInput: {},
          expectPrompt: "Approve?",
          output: { selection: "reject" },
        },
        rejected: {
          expectInput: {},
          expectPrompt: "Cancelled",
          output: { selection: "done" },
        },
      },
      expect: {
        status: "succeeded",
        path: ["decision", "rejected"],
        output: { selection: "done" },
      },
    }),
  ];
}

function adapterOptions(
  project: ReturnType<typeof createPragmaProjectStore>,
  stateRoot: string,
  values: readonly Capability[] = [],
) {
  const capabilities = { list: async () => values } as unknown as CapabilityStore;
  const runtimes = {
    getMaterializationCacheKey: async () => "test-environment",
    getDefaultRuntimeId: async () => "test",
    list: async () => [
      {
        head: {
          entry: { runtimeId: "test" },
          revision: {
            revision: 1,
            status: "active",
            definition: {
              id: "test",
              displayName: "Test Runtime",
              origin: "built-in",
              adapter: { id: "test.adapter", version: "v1" },
              config: {},
            },
          },
        },
        adapter: {
          descriptor: { id: "test", kind: "test", displayName: "Test Runtime" },
          canUse: async () => ({ usable: true as const }),
          listModels: async () => [
            {
              id: "model",
              displayName: "Test Model",
              provider: { kind: "runtime-managed" as const, id: "test", displayName: "Test" },
              default: true,
            },
          ],
        },
      },
    ],
  } as unknown as RuntimeEnvironmentService;
  return {
    project,
    stateRoot,
    capabilities,
    runtimes,
    systemExperts: createDesktopSystemExpertRegistry(),
  };
}

function capability(id: string, status: "ready" | "needs_attention"): Capability {
  return {
    manifest: {
      schemaVersion: "pragma.capability/v3",
      id,
      runtimeKey: `repository_${id.at(-1)}`,
      name: "Repository access",
      kind: "skill",
      latestRevision: 1,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
    definition: {
      name: "Repository access",
      description: "Reads repository context.",
      kind: "skill",
      entryPath: "SKILL.md",
      contentHash: "a".repeat(64),
    },
    health: {
      revision: 1,
      status,
      checkedAt: "2026-07-19T00:00:00.000Z",
      ...(status === "needs_attention"
        ? { diagnostic: { code: "unavailable", message: "Unavailable", retryable: true } }
        : {}),
    },
  };
}

function emptyDescriptionMcpCapability(): Capability {
  return {
    manifest: {
      schemaVersion: "pragma.capability/v3",
      id: "00000000-0000-4000-8000-000000000003",
      runtimeKey: "empty_description_mcp",
      name: "Empty description MCP",
      kind: "mcp_server",
      latestRevision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      updatedAt: "2026-07-24T00:00:00.000Z",
    },
    definition: {
      name: "Empty description MCP",
      description: "",
      kind: "mcp_server",
      connection: {
        transport: "streamable-http",
        url: "https://example.com/mcp",
      },
      timeoutMs: 30_000,
      tools: [],
    },
    health: {
      revision: 1,
      status: "ready",
      checkedAt: "2026-07-24T00:00:00.000Z",
    },
  };
}
