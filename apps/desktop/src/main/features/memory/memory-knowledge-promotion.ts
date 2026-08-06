import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/context-filesystem";
import type {
  KnowledgeContent,
  KnowledgeExtractionCandidate,
  KnowledgeSourceSnapshot,
  MemorySubjectRef,
} from "@pragma/shared";
import { z } from "zod";

import {
  MemoryKnowledgeInitializationCandidateRefSchema,
  MemoryKnowledgeInitializationCandidateSchema,
  UpdateMemoryKnowledgeInitializationCandidateSchema,
  type ContextStore,
  type ContextStoreSnapshot,
  type ListMemoryKnowledgeInitializationCandidates,
  type MemoryKnowledgeInitializationCandidate,
  type MemoryKnowledgeInitializationCandidateRef,
  type UpdateMemoryKnowledgeInitializationCandidate,
} from "../../../shared/contracts/index.ts";
import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";

const BindingSchema = z
  .object({
    expertRef: z.string().regex(/^expert:[0-9a-hjkmnp-tv-z]{16}$/u),
    storeId: z.string().uuid().optional(),
    lastSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    updatedAt: z.string().datetime(),
  })
  .strict();
const BindingFileSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-knowledge-store-bindings/v1"),
    bindings: BindingSchema.array(),
  })
  .strict();
const PromotionJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-knowledge-promotion-journal/v1"),
    candidateId: z.string().uuid(),
    expertRef: z.string(),
    storeId: z.string().uuid(),
  })
  .strict();

export interface MemoryKnowledgePromotionService {
  routeLearning(input: {
    readonly expertRefs: readonly string[];
    readonly sourceDigest: string;
    readonly proposals: readonly {
      readonly title: string;
      readonly summary: string;
      readonly guidance: readonly string[];
      readonly normalizedKey: string;
    }[];
  }): Promise<void>;
  list(
    input?: ListMemoryKnowledgeInitializationCandidates,
  ): Promise<readonly MemoryKnowledgeInitializationCandidate[]>;
  update(
    input: UpdateMemoryKnowledgeInitializationCandidate,
  ): Promise<MemoryKnowledgeInitializationCandidate>;
  reject(
    input: MemoryKnowledgeInitializationCandidateRef,
  ): Promise<MemoryKnowledgeInitializationCandidate>;
  createStore(input: MemoryKnowledgeInitializationCandidateRef): Promise<ContextStore>;
  clearStoreBinding(storeId: string): Promise<void>;
  clearExpertBinding(expertRef: string): Promise<void>;
  recover(): Promise<void>;
}

export function groupMemoryKnowledgeProposalsByExpert(input: {
  readonly rootRef: MemorySubjectRef;
  readonly candidates: readonly KnowledgeExtractionCandidate[];
  readonly sources: readonly KnowledgeSourceSnapshot[];
}): ReadonlyMap<string, readonly KnowledgeContent[]> {
  const proposalsByExpert = new Map<string, KnowledgeContent[]>();
  for (const candidate of input.candidates) {
    const sourceKeys = new Set(
      candidate.sourceRefs.map((ref) => `${ref.kind}\0${ref.id}\0${ref.revision}`),
    );
    const producerExperts = input.sources
      .filter((source) =>
        sourceKeys.has(`${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`),
      )
      .flatMap((source) => source.producerRefs)
      .filter((ref) => ref.type === "pragma.expert")
      .map((ref) => `expert:${ref.id}`);
    if (producerExperts.length === 0 && input.rootRef.type === "pragma.expert") {
      producerExperts.push(`expert:${input.rootRef.id}`);
    }
    for (const expertRef of new Set(producerExperts)) {
      const proposals = proposalsByExpert.get(expertRef) ?? [];
      proposals.push(candidate.content);
      proposalsByExpert.set(expertRef, proposals);
    }
  }
  return proposalsByExpert;
}

export function createMemoryKnowledgePromotionService(options: {
  readonly statePath: string;
  readonly contextStores: ContextStoreStore;
  readonly revisions: ContextStoreRevisionService;
  readonly mountStore: (expertRef: string, storeId: string) => Promise<void>;
  readonly expertExists: (expertRef: string) => Promise<boolean>;
}): MemoryKnowledgePromotionService {
  const candidatesPath = join(options.statePath, "candidates");
  const bindingsPath = join(options.statePath, "bindings.json");
  const journalPath = join(options.statePath, "promotion.json");
  const lockPath = join(options.statePath, ".lock");
  const candidatePath = (id: string) => join(candidatesPath, `${id}.json`);

  const readBindings = async () => {
    try {
      return BindingFileSchema.parse(JSON.parse(await readFile(bindingsPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return BindingFileSchema.parse({
          schemaVersion: "pragma.memory-knowledge-store-bindings/v1",
          bindings: [],
        });
      }
      throw error;
    }
  };
  const writeBindings = async (bindings: z.infer<typeof BindingSchema>[]) => {
    await writeJsonAtomic(bindingsPath, {
      schemaVersion: "pragma.memory-knowledge-store-bindings/v1",
      bindings,
    });
  };
  const readCandidate = async (id: string) =>
    MemoryKnowledgeInitializationCandidateSchema.parse(
      JSON.parse(await readFile(candidatePath(id), "utf8")),
    );
  const writeCandidate = async (candidate: MemoryKnowledgeInitializationCandidate) => {
    await writeJsonAtomic(candidatePath(candidate.id), candidate);
  };
  const readCandidates = async (): Promise<readonly MemoryKnowledgeInitializationCandidate[]> => {
    let names: string[];
    try {
      names = await readdir(candidatesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => readCandidate(name.slice(0, -5))),
    );
  };
  const stageCandidate = async (
    expertRef: string,
    sourceDigest: string,
    proposals: Parameters<MemoryKnowledgePromotionService["routeLearning"]>[0]["proposals"],
  ): Promise<void> => {
    const pending = (await readCandidates()).find(
      (candidate) => candidate.expertRef === expertRef && candidate.state === "pending_review",
    );
    if (pending?.sourceDigest === sourceDigest) return;
    await writeCandidate(
      pending === undefined
        ? createCandidate(expertRef, sourceDigest, proposals)
        : mergeCandidate(pending, sourceDigest, proposals),
    );
  };

  const finalizePromotion = async (journal: z.infer<typeof PromotionJournalSchema>) => {
    if (!(await options.expertExists(journal.expertRef))) {
      throw new Error("knowledge_expert_not_found");
    }
    const candidate = await readCandidate(journal.candidateId);
    let store: ContextStore;
    try {
      store = (await options.contextStores.list()).find((item) => item.id === journal.storeId)!;
      if (store === undefined) throw new Error("missing");
    } catch {
      store = await options.contextStores.createFromSnapshot({
        id: journal.storeId,
        name: candidate.name,
        description: candidate.description,
        files: candidate.files,
        author: "memory-initialization",
        summary: "Create Memory knowledge store from an approved initialization candidate.",
      });
    }
    await options.mountStore(journal.expertRef, journal.storeId);
    const bindings = await readBindings();
    await writeBindings([
      ...bindings.bindings.filter((binding) => binding.expertRef !== journal.expertRef),
      {
        expertRef: journal.expertRef,
        storeId: journal.storeId,
        lastSourceDigest: candidate.sourceDigest,
        updatedAt: new Date().toISOString(),
      },
    ]);
    if (candidate.state !== "created") {
      await writeCandidate(
        MemoryKnowledgeInitializationCandidateSchema.parse({
          ...candidate,
          revision: candidate.revision + 1,
          state: "created",
          storeId: journal.storeId,
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    await rm(journalPath, { force: true });
    return store;
  };

  const service: MemoryKnowledgePromotionService = {
    async routeLearning(input) {
      const sourceDigest = z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .parse(input.sourceDigest);
      for (const expertRef of [...new Set(input.expertRefs)].toSorted()) {
        if (!(await options.expertExists(expertRef))) continue;
        const storeId = await withFileLock(lockPath, async () => {
          const bindings = await readBindings();
          const binding = bindings.bindings.find((item) => item.expertRef === expertRef);
          if (binding?.lastSourceDigest === sourceDigest) return undefined;
          if (binding?.storeId !== undefined) {
            return binding.storeId;
          }
          await stageCandidate(expertRef, sourceDigest, input.proposals);
          return undefined;
        });
        if (storeId === undefined) continue;
        try {
          await options.contextStores.getSnapshot(storeId);
          const prompts = renderRevisionPrompts(input.proposals);
          for (const [index, prompt] of prompts.entries()) {
            await options.revisions.submit({
              schemaVersion: "pragma.context-store-revision-request/v1",
              storeId,
              source: "memory-learning",
              sourceDigest: revisionPartDigest(sourceDigest, index, prompts.length),
              prompt,
            });
          }
        } catch (error) {
          if (!isStoreNotFound(error)) throw error;
          await withFileLock(lockPath, async () => {
            const bindings = await readBindings();
            await writeBindings(
              bindings.bindings.map((item) =>
                item.expertRef === expertRef && item.storeId === storeId
                  ? { ...item, storeId: undefined, updatedAt: new Date().toISOString() }
                  : item,
              ),
            );
            await stageCandidate(expertRef, sourceDigest, input.proposals);
          });
          continue;
        }
        await withFileLock(lockPath, async () => {
          const bindings = await readBindings();
          await writeBindings(
            bindings.bindings.map((item) =>
              item.expertRef === expertRef && item.storeId === storeId
                ? { ...item, lastSourceDigest: sourceDigest, updatedAt: new Date().toISOString() }
                : item,
            ),
          );
        });
        options.revisions.scheduleProcessing();
      }
    },

    async list(input = { state: "pending_review" }) {
      const candidates = await readCandidates();
      return candidates
        .filter((candidate) => input.state === "all" || candidate.state === input.state)
        .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },

    async update(input) {
      const parsed = UpdateMemoryKnowledgeInitializationCandidateSchema.parse(input);
      return await withFileLock(lockPath, async () => {
        const current = await readCandidate(parsed.id);
        assertCandidateRevision(current, parsed.expectedRevision);
        if (current.state !== "pending_review") throw new Error("candidate_not_pending");
        const next = MemoryKnowledgeInitializationCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          name: parsed.name,
          description: parsed.description,
          files: parsed.files,
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(next);
        return next;
      });
    },

    async reject(input) {
      const parsed = MemoryKnowledgeInitializationCandidateRefSchema.parse(input);
      return await withFileLock(lockPath, async () => {
        const current = await readCandidate(parsed.id);
        assertCandidateRevision(current, parsed.expectedRevision);
        if (current.state !== "pending_review") throw new Error("candidate_not_pending");
        const next = MemoryKnowledgeInitializationCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          state: "rejected",
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(next);
        const bindings = await readBindings();
        await writeBindings([
          ...bindings.bindings.filter((binding) => binding.expertRef !== current.expertRef),
          {
            expertRef: current.expertRef,
            lastSourceDigest: current.sourceDigest,
            updatedAt: new Date().toISOString(),
          },
        ]);
        return next;
      });
    },

    async createStore(input) {
      const parsed = MemoryKnowledgeInitializationCandidateRefSchema.parse(input);
      return await withFileLock(lockPath, async () => {
        const current = await readCandidate(parsed.id);
        assertCandidateRevision(current, parsed.expectedRevision);
        if (current.state !== "pending_review") throw new Error("candidate_not_pending");
        if (!(await options.expertExists(current.expertRef))) {
          throw new Error("knowledge_expert_not_found");
        }
        const bindings = await readBindings();
        if (
          bindings.bindings.some(
            (binding) => binding.expertRef === current.expertRef && binding.storeId !== undefined,
          )
        ) {
          throw new Error("knowledge_store_already_initialized");
        }
        const competing = (await readCandidates()).some(
          (candidate) =>
            candidate.id !== current.id &&
            candidate.expertRef === current.expertRef &&
            candidate.state === "created",
        );
        if (competing) throw new Error("knowledge_store_already_initialized");
        const journal = PromotionJournalSchema.parse({
          schemaVersion: "pragma.memory-knowledge-promotion-journal/v1",
          candidateId: current.id,
          expertRef: current.expertRef,
          storeId: randomUUID(),
        });
        await writeJsonAtomic(journalPath, journal);
        return await finalizePromotion(journal);
      });
    },

    async clearStoreBinding(storeId) {
      await withFileLock(lockPath, async () => {
        const bindings = await readBindings();
        await writeBindings(
          bindings.bindings.map((binding) =>
            binding.storeId === storeId
              ? { ...binding, storeId: undefined, updatedAt: new Date().toISOString() }
              : binding,
          ),
        );
      });
    },

    async clearExpertBinding(expertRef) {
      const orphanStoreId = await withFileLock(lockPath, async () => {
        const bindings = await readBindings();
        await writeBindings(bindings.bindings.filter((binding) => binding.expertRef !== expertRef));
        for (const candidate of await readCandidates()) {
          if (candidate.expertRef === expertRef && candidate.state === "pending_review") {
            await writeCandidate(
              MemoryKnowledgeInitializationCandidateSchema.parse({
                ...candidate,
                revision: candidate.revision + 1,
                state: "rejected",
                updatedAt: new Date().toISOString(),
              }),
            );
          }
        }
        try {
          const journal = PromotionJournalSchema.parse(
            JSON.parse(await readFile(journalPath, "utf8")),
          );
          if (journal.expertRef === expertRef) {
            await rm(journalPath, { force: true });
            return journal.storeId;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return undefined;
      });
      if (orphanStoreId !== undefined) {
        const exists = (await options.contextStores.list()).some(
          (store) => store.id === orphanStoreId,
        );
        if (exists) await options.contextStores.remove(orphanStoreId);
      }
    },

    async recover() {
      try {
        const journal = PromotionJournalSchema.parse(
          JSON.parse(await readFile(journalPath, "utf8")),
        );
        await withFileLock(lockPath, async () => await finalizePromotion(journal));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
  return service;
}

function createCandidate(
  expertRef: string,
  sourceDigest: string,
  proposals: readonly {
    readonly title: string;
    readonly summary: string;
    readonly guidance: readonly string[];
    readonly normalizedKey: string;
  }[],
): MemoryKnowledgeInitializationCandidate {
  const timestamp = new Date().toISOString();
  const itemFilesById = new Map<string, ContextStoreSnapshot["files"][number]>();
  for (const proposal of proposals) {
    const id = `items/${itemName(proposal.normalizedKey)}.md`;
    itemFilesById.set(id, {
      id,
      content: [
        `# ${proposal.title}`,
        "",
        proposal.summary,
        "",
        "## Guidance",
        ...proposal.guidance.map((entry) => `- ${entry}`),
        "",
      ].join("\n"),
      metadata: {
        description: proposal.summary.slice(0, 2_000),
        trigger: "manual",
        priority: "normal",
      },
    });
  }
  const itemFiles = [...itemFilesById.values()].toSorted((left, right) =>
    left.id.localeCompare(right.id),
  );
  return MemoryKnowledgeInitializationCandidateSchema.parse({
    schemaVersion: "pragma.memory-knowledge-initialization-candidate/v1",
    id: randomUUID(),
    revision: 1,
    expertRef,
    sourceDigest,
    name: `Memory · ${expertRef.slice(-8)}`,
    description: "Structured knowledge promoted from reusable Memory.",
    files: buildProgressiveFiles(itemFiles),
    state: "pending_review",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function mergeCandidate(
  current: MemoryKnowledgeInitializationCandidate,
  sourceDigest: string,
  proposals: readonly {
    readonly title: string;
    readonly summary: string;
    readonly guidance: readonly string[];
    readonly normalizedKey: string;
  }[],
): MemoryKnowledgeInitializationCandidate {
  const incoming = createCandidate(current.expertRef, sourceDigest, proposals);
  const items = new Map(
    current.files.filter((file) => file.id.startsWith("items/")).map((file) => [file.id, file]),
  );
  for (const file of incoming.files.filter((entry) => entry.id.startsWith("items/"))) {
    items.set(file.id, file);
  }
  return MemoryKnowledgeInitializationCandidateSchema.parse({
    ...current,
    revision: current.revision + 1,
    sourceDigest,
    files: buildProgressiveFiles(
      [...items.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    ),
    updatedAt: new Date().toISOString(),
  });
}

function buildProgressiveFiles(
  itemFiles: ContextStoreSnapshot["files"],
): ContextStoreSnapshot["files"] {
  const overviewLines = itemFiles.map(
    (file) =>
      `- [${markdownLinkLabel(firstHeading(file.content))}](${file.id}) — ${file.metadata.description}`,
  );
  const shardSize = 20;
  const shards: ContextStoreSnapshot["files"] = [];
  for (let offset = 0; offset < itemFiles.length; offset += shardSize) {
    const part = Math.floor(offset / shardSize) + 1;
    shards.push({
      id: `indexes/part-${String(part).padStart(3, "0")}.md`,
      content: fitUtf8(
        [
          `# Index part ${part}`,
          "",
          ...itemFiles
            .slice(offset, offset + shardSize)
            .map((file) => `- [${markdownLinkLabel(firstHeading(file.content))}](${file.id})`),
          "",
        ],
        8_192,
      ),
      metadata: {
        description: `Detailed knowledge index part ${part}.`,
        trigger: "model_decision",
        priority: "normal",
      },
    });
  }
  const files: ContextStoreSnapshot["files"] = [
    {
      id: "guide.md",
      content:
        "# Guide\n\nStart with overview.md. When this store is large or the topic is unknown, search it. Use index.md for navigation and read only the relevant items/** documents.\n",
      metadata: {
        description: "How to use this knowledge base.",
        trigger: "always_on",
        priority: "critical",
      },
    },
    {
      id: "overview.md",
      content: fitUtf8(["# Overview", "", ...overviewLines, ""], 6_144),
      metadata: {
        description: "Bounded knowledge overview.",
        trigger: "model_decision",
        priority: "high",
      },
    },
    {
      id: "index.md",
      content: fitUtf8(
        [
          "# Index",
          "",
          ...shards.map(
            (file) => `- [${markdownLinkLabel(file.metadata.description ?? file.id)}](${file.id})`,
          ),
          "",
        ],
        8_192,
      ),
      metadata: {
        description: "Pointers to detailed knowledge.",
        trigger: "model_decision",
        priority: "normal",
      },
    },
    ...shards,
    ...itemFiles,
  ];
  return files;
}

function renderRevisionPrompts(
  proposals: readonly {
    readonly title: string;
    readonly summary: string;
    readonly guidance: readonly string[];
    readonly normalizedKey: string;
  }[],
): readonly string[] {
  const parts = proposals.flatMap((proposal) =>
    proposal.guidance.map((guidance) => ({
      ...proposal,
      guidance: [guidance],
    })),
  );
  const groups: (typeof parts)[] = [];
  let current: typeof parts = [];
  for (const part of parts) {
    const next = [...current, part];
    if (current.length > 0 && renderRevisionPrompt(next, 1, 1).length > 49_000) {
      groups.push(current);
      current = [part];
    } else {
      current = next;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group, index) => renderRevisionPrompt(group, index + 1, groups.length));
}

function renderRevisionPrompt(
  proposals: readonly {
    readonly title: string;
    readonly summary: string;
    readonly guidance: readonly string[];
    readonly normalizedKey: string;
  }[],
  part: number,
  total: number,
): string {
  return [
    `Memory learning revision part ${part} of ${total}.`,
    "Revise this Memory knowledge store using the newly learned reusable guidance below.",
    "Preserve unrelated items. Merge repeated normalizedKey entries, update overview/index pointers, and add or revise focused items/** documents.",
    "Do not add Memory ids, Evidence ids, source references, or the revision prompt to the Store.",
    JSON.stringify(proposals),
  ].join("\n\n");
}

function itemName(key: string): string {
  const prefix =
    key
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 72) || "knowledge";
  const suffix = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${prefix}-${suffix}`;
}

function revisionPartDigest(sourceDigest: string, index: number, total: number): string {
  if (total === 1) return sourceDigest;
  return createHash("sha256")
    .update(`${sourceDigest}:${index + 1}:${total}`)
    .digest("hex");
}

function firstHeading(content: string): string {
  return content.match(/^#\s+(.+)$/mu)?.[1]?.trim() ?? "Knowledge item";
}

function markdownLinkLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function fitUtf8(lines: readonly string[], maxBytes: number): string {
  const accepted: string[] = [];
  for (const line of lines) {
    const next = [...accepted, line].join("\n");
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    accepted.push(line);
  }
  return `${accepted.join("\n").trimEnd()}\n`;
}

function isStoreNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "store_not_found";
}

function assertCandidateRevision(
  candidate: MemoryKnowledgeInitializationCandidate,
  expected: number,
): void {
  if (candidate.revision !== expected) throw new Error("candidate_revision_conflict");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
