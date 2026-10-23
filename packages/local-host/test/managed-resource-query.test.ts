import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILT_IN_SKILLS } from "@pragma/built-in-agents";
import {
  ManagedSkillPageSchema,
  ManagedSkillDetailSchema,
  ManagedSkillFilesPageSchema,
  ManagedSkillFileSchema,
  ManagedKnowledgeDetailSchema,
  ManagedKnowledgeDocumentsPageSchema,
  ManagedKnowledgeSearchPageSchema,
  ManagedKnowledgeDocumentSchema,
  type ManagedResourceQuery,
} from "@pragma/shared/integration";
import { createManagedResourceQueryPort } from "../src/managed-resource-query.ts";
import { createCapabilityStore } from "../src/deployment/capabilities/capability-store.ts";
import { createContextStoreStore } from "../src/deployment/context-stores/context-store-store.ts";
import { createCapabilityCredentialStore } from "../src/resources/capability-credential-store.ts";
import { createSecretStore } from "../src/secrets/secret-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const metadata = {
  trigger: "always_on" as const,
  priority: "normal" as const,
  description: "Routing guidance",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pragma-managed-query-"));
  roots.push(root);
  const secrets = new Map<string, Uint8Array>();
  const credentials = createCapabilityCredentialStore({
    configPath: join(root, "credentials.json"),
    secretStore: createSecretStore({
      root: join(root, "secrets"),
      keychain: {
        inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
        get: async (service, account) => secrets.get(`${service}/${account}`) ?? null,
        set: async (service, account, value) => {
          secrets.set(`${service}/${account}`, value);
        },
        delete: async (service, account) => {
          secrets.delete(`${service}/${account}`);
        },
      },
    }),
  });
  const capabilities = createCapabilityStore({
    capabilitiesPath: join(root, "capabilities"),
    credentials,
    verify: async (definition) => ({
      definition,
      health: { status: "ready", checkedAt: new Date().toISOString() },
    }),
    mutations: {
      publish: async (input) => {
        await input.validateCurrent?.();
        return input.commit();
      },
      publishHealth: async (input) => {
        await input.validateCurrent?.();
        return input.commit();
      },
      mutate: async (input) => {
        await input.validateCurrent?.();
        await input.commit();
      },
    },
    isReferenced: async () => false,
  });
  const knowledge = createContextStoreStore({ storesPath: join(root, "knowledge") });
  const port = createManagedResourceQueryPort({
    capabilities,
    knowledge,
    resources: async () => [],
  });
  const makeSkill = async (
    id: string,
    body = "Formal body",
    extra: Record<string, string | Uint8Array> = {},
  ) => {
    const source = join(root, `source-${id}`);
    await mkdir(source);
    const content = `---\nname: review\ndescription: Review code\n---\n${body}`;
    for (const [path, data] of Object.entries({ "SKILL.md": content, ...extra })) {
      const target = join(source, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, data);
    }
    const skill = await capabilities.importSkill({ sourcePath: source }, { id });
    return { skill, content };
  };
  return { root, capabilities, knowledge, port, makeSkill };
}

describe("formal managed resource queries", () => {
  it("discovers all unmounted and system Skills, filters and follows continuation without guessing identities", async () => {
    const f = await fixture();
    await f.makeSkill("0000000000000001");
    await f.makeSkill("0000000000000002");
    const first = ManagedSkillPageSchema.parse(
      await f.port.execute({
        command: "skill.list",
        input: { query: "review", managedBy: "user", status: "ready", limit: 1 },
      }),
    );
    expect(first.items.map((item) => item.capabilityId)).toEqual(["0000000000000001"]);
    const second = ManagedSkillPageSchema.parse(
      await f.port.execute(first.continuation as ManagedResourceQuery),
    );
    expect(second.items.map((item) => item.capabilityId)).toEqual(["0000000000000002"]);
    expect(second.continuation).toBeUndefined();
    const system = ManagedSkillPageSchema.parse(
      await f.port.execute({ command: "skill.list", input: { managedBy: "system" } }),
    );
    expect(system.items.map((item) => item.capabilityId)).toEqual(
      BUILT_IN_SKILLS.map((item) => item.id),
    );
    expect(
      ManagedSkillPageSchema.parse(
        await f.port.execute({ command: "skill.list", input: { status: "needs_attention" } }),
      ).items,
    ).toEqual([]);
    await f.makeSkill("0000000000000003");
    await expect(f.port.execute(first.continuation as ManagedResourceQuery)).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
      details: { recovery: { requestIdPolicy: "new" } },
    });
    await expect(
      f.port.execute({
        command: "skill.list",
        input: { query: "different", cursor: first.nextCursor },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("reads latest formal SKILL.md in one query and supports the explicitly active revision", async () => {
    const f = await fixture();
    const { skill, content } = await f.makeSkill("0000000000000001");
    const id = skill.manifest.id;
    const updated = await f.capabilities.saveSkillFiles({
      id,
      baseRevision: 1,
      files: [{ path: "SKILL.md", content: content + "\nUpdated formal content" }],
    });
    // Keep real writer revisions, with a valid manifest whose activation still points at the prior revision.
    await writeFile(
      join(f.root, "capabilities", id, "capability.json"),
      JSON.stringify({ ...updated.manifest, activeRevision: 1 }),
    );
    const latest = ManagedSkillDetailSchema.parse(
      await f.port.execute({ command: "skill.get", input: { capabilityId: id, view: "content" } }),
    );
    expect(latest).toMatchObject({
      latestRevision: 2,
      activeRevision: 1,
      revision: 2,
      path: "SKILL.md",
      data: { content: content + "\nUpdated formal content", complete: true },
    });
    const active = ManagedSkillDetailSchema.parse(
      await f.port.execute({
        command: "skill.get",
        input: { capabilityId: id, revision: "active", view: "content" },
      }),
    );
    expect(active).toMatchObject({ revision: 1, latestRevision: 2, data: { content } });
    const summary = ManagedSkillDetailSchema.parse(
      await f.port.execute({ command: "skill.get", input: { capabilityId: id } }),
    );
    expect(summary.data).toBeUndefined();
    const definition = ManagedSkillDetailSchema.parse(
      await f.port.execute({
        command: "skill.get",
        input: { capabilityId: id, view: "definition" },
      }),
    );
    expect(definition.dslRefs).toEqual([]);
    await expect(
      f.port.execute({
        command: "skill.get",
        input: { capabilityId: id, contentHash: "a".repeat(64) },
      }),
    ).rejects.toMatchObject({
      code: "CURSOR_EXPIRED",
      details: {
        recovery: { command: "skill.get", input: { capabilityId: id }, requestIdPolicy: "new" },
      },
    });
  });

  it("reads the actual system Skill and its static DSL from the same registry", async () => {
    const f = await fixture();
    const builtin = BUILT_IN_SKILLS[0]!;
    const read = ManagedSkillDetailSchema.parse(
      await f.port.execute({
        command: "skill.get",
        input: { capabilityId: builtin.id, view: "content" },
      }),
    );
    expect(read.data?.content).toBe(builtin.files["SKILL.md"]);
    const definition = ManagedSkillDetailSchema.parse(
      await f.port.execute({
        command: "skill.get",
        input: { capabilityId: builtin.id, view: "definition" },
      }),
    );
    expect(definition.dslRefs).toEqual([builtin.ref]);
    expect(definition.data?.content).toContain("kind: Capability");
  });

  it("pages files and distinguishes binary files, invalid paths and absent resources", async () => {
    const f = await fixture();
    await f.makeSkill("0000000000000001", "Read references.", {
      "references/routing.md": "Routing",
      "assets/test.bin": new Uint8Array([0, 255, 128]),
    });
    const first = ManagedSkillFilesPageSchema.parse(
      await f.port.execute({
        command: "skill.files.list",
        input: { capabilityId: "0000000000000001", limit: 1 },
      }),
    );
    const second = ManagedSkillFilesPageSchema.parse(
      await f.port.execute(first.continuation as ManagedResourceQuery),
    );
    expect(second.revision).toBe(first.revision);
    expect(second.contentHash).toBe(first.contentHash);
    const binary = ManagedSkillFileSchema.parse(
      await f.port.execute({
        command: "skill.files.read",
        input: { capabilityId: "0000000000000001", path: "assets/test.bin" },
      }),
    );
    expect(binary.data).toMatchObject({
      content: null,
      readable: false,
      unavailableReason: "binary_or_unsupported_encoding",
    });
    expect(binary.sizeBytes).toBe(3);
    await expect(
      f.port.execute({
        command: "skill.files.read",
        input: { capabilityId: "0000000000000001", path: "missing.md" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.port.execute({
        command: "skill.files.read",
        input: { capabilityId: "0000000000000001", path: "../secret" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      f.port.execute({ command: "skill.get", input: { capabilityId: "0000000000000009" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps escaped Chinese and emoji output bounded and reconstructs the exact text from continuations", async () => {
    const f = await fixture();
    const { content } = await f.makeSkill("0000000000000001", '中文😀"\\\n'.repeat(30_000));
    let request: ManagedResourceQuery | undefined = {
      command: "skill.get",
      input: { capabilityId: "0000000000000001", view: "content", limitChars: 100_000 },
    };
    let restored = "";
    let calls = 0;
    while (request !== undefined) {
      const result = ManagedSkillDetailSchema.parse(await f.port.execute(request));
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(128 * 1024);
      expect(result.data!.content!.isWellFormed()).toBe(true);
      restored += result.data!.content;
      request = result.continuation as ManagedResourceQuery | undefined;
      calls++;
    }
    expect(calls).toBeGreaterThan(1);
    expect(restored).toBe(content);
    const pair = await f.makeSkill("0000000000000002", "😀😀");
    const start = pair.content.indexOf("😀");
    const read = ManagedSkillDetailSchema.parse(
      await f.port.execute({
        command: "skill.get",
        input: { capabilityId: "0000000000000002", view: "content", offset: start, limitChars: 1 },
      }),
    );
    expect(read.data?.content).toBe("😀");
    await expect(
      f.port.execute({
        command: "skill.get",
        input: { capabilityId: "0000000000000002", view: "content", offset: start + 1 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("queries a formal unmounted snapshot, searches by path/content, and keeps reads pinned across publication", async () => {
    const f = await fixture();
    const store = await f.knowledge.createFromSnapshot({
      name: "Architecture",
      description: "Formal docs",
      files: [
        { id: "Routing.md", content: "Current routing\nNext routing", metadata },
        { id: "Other.md", content: "Other", metadata },
      ],
      author: "user",
      summary: "Initial",
    });
    const detail = ManagedKnowledgeDetailSchema.parse(
      await f.port.execute({ command: "knowledge-store.get", input: { storeId: store.id } }),
    );
    expect(detail).toMatchObject({
      revision: 1,
      snapshotHash: store.snapshotHash,
      writeApprovalMode: "required",
    });
    const page = ManagedKnowledgeDocumentsPageSchema.parse(
      await f.port.execute({
        command: "knowledge-store.documents.list",
        input: { storeId: store.id, limit: 1 },
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(
      ManagedKnowledgeDocumentsPageSchema.parse(
        await f.port.execute(page.continuation as ManagedResourceQuery),
      ).items,
    ).toHaveLength(1);
    const search = ManagedKnowledgeSearchPageSchema.parse(
      await f.port.execute({
        command: "knowledge-store.documents.search",
        input: { storeId: store.id, query: "routing", limit: 1 },
      }),
    );
    expect(search.items[0]).toMatchObject({ documentId: "Routing.md", matchType: "path" });
    const bodyHit = ManagedKnowledgeSearchPageSchema.parse(
      await f.port.execute(search.continuation as ManagedResourceQuery),
    );
    expect(bodyHit.items[0]).toMatchObject({ matchType: "content", line: 1 });
    const read = ManagedKnowledgeDocumentSchema.parse(
      await f.port.execute({
        command: "knowledge-store.documents.read",
        input: { storeId: store.id, documentId: "Routing.md", limitChars: 5 },
      }),
    );
    const before = await f.knowledge.getContent(store.id, "Routing.md");
    await f.knowledge.updateFile(store.id, "Routing.md", "New content", metadata, before.revision!);
    const rest = ManagedKnowledgeDocumentSchema.parse(
      await f.port.execute(read.continuation as ManagedResourceQuery),
    );
    expect(rest.revision).toBe(1);
    expect(rest.data.content).toBe("nt ro");
    const current = ManagedKnowledgeDocumentSchema.parse(
      await f.port.execute({
        command: "knowledge-store.documents.read",
        input: { storeId: store.id, documentId: "Routing.md" },
      }),
    );
    expect(current.revision).toBe(2);
    expect(current.data.content).toBe("New content");
    await expect(
      f.port.execute({
        command: "knowledge-store.documents.read",
        input: { storeId: store.id, documentId: "Absent.md" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.port.execute({
        command: "knowledge-store.get",
        input: { storeId: store.id, snapshotHash: "a".repeat(64) },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("does not report a corrupt resource catalog as an empty successful list", async () => {
    const f = await fixture();
    const { skill } = await f.makeSkill("0000000000000001");
    const path = join(f.root, "capabilities", skill.manifest.id, "capability.json");
    await writeFile(path, "broken");
    await expect(f.port.execute({ command: "skill.list", input: {} })).rejects.toMatchObject({
      code: "STORAGE_CORRUPTED",
    });
    expect(await f.capabilities.list()).toEqual([]);
  });

  it("pages dense search hits by snapshot identity across publication without losing line positions", async () => {
    const f = await fixture();
    const store = await f.knowledge.createFromSnapshot({
      name: "Dense matches",
      description: "",
      files: [{ id: "Routing.md", content: "routing\n".repeat(100_000), metadata }],
      author: "user",
      summary: "Initial",
    });
    const first = ManagedKnowledgeSearchPageSchema.parse(
      await f.port.execute({
        command: "knowledge-store.documents.search",
        input: { storeId: store.id, query: "ROUTING", scope: "content", limit: 2 },
      }),
    );
    expect(first.items.map((hit) => hit.line)).toEqual([1, 2]);
    const before = await f.knowledge.getContent(store.id, "Routing.md");
    await f.knowledge.updateFile(store.id, "Routing.md", "Unrelated", metadata, before.revision!);
    const second = ManagedKnowledgeSearchPageSchema.parse(
      await f.port.execute(first.continuation as ManagedResourceQuery),
    );
    expect(second).toMatchObject({ revision: 1, snapshotHash: first.snapshotHash });
    expect(second.items.map((hit) => hit.line)).toEqual([3, 4]);
    await expect(
      f.port.execute({
        command: "knowledge-store.documents.search",
        input: {
          storeId: store.id,
          revision: first.revision,
          snapshotHash: first.snapshotHash,
          query: "different",
          scope: "content",
          limit: 2,
          cursor: first.nextCursor,
        },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });

  it("distinguishes invalid request input from damaged snapshot records and allows retry after repair", async () => {
    const f = await fixture();
    const store = await f.knowledge.createFromSnapshot({
      name: "Knowledge",
      description: "",
      files: [{ id: "Routing.md", content: "Routing", metadata }],
      author: "user",
      summary: "Initial",
    });
    const request: ManagedResourceQuery = {
      command: "knowledge-store.documents.read",
      input: { storeId: store.id, documentId: "Routing.md" },
    };
    const recordPath = join(f.root, "knowledge", store.id, "revisions", "00000001", "record.json");
    const original = await readFile(recordPath, "utf8");
    await writeFile(recordPath, JSON.stringify({ ...JSON.parse(original), revision: "broken" }));
    await expect(
      f.port.execute({
        command: "knowledge-store.documents.read",
        input: { ...request.input, limitChars: 0 },
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(f.port.execute(request)).rejects.toMatchObject({ code: "STORAGE_CORRUPTED" });
    await expect(readFile(recordPath, "utf8")).resolves.toContain('"broken"');
    await writeFile(recordPath, original);
    expect(ManagedKnowledgeDocumentSchema.parse(await f.port.execute(request)).data.content).toBe(
      "Routing",
    );
  });
});
