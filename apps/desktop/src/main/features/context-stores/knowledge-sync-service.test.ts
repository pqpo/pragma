import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeSyncStoreManifestSchema,
  type KnowledgeSyncConfiguration,
} from "../../../shared/contracts/index.ts";
import {
  createContextStoreStore,
  hashSnapshotContent,
  type ContextStoreStore,
} from "./context-store-store.ts";
import {
  createGitContextStoreSyncProvider,
  createKnowledgeSyncService,
  type ContextStoreSyncProvider,
  type RemoteStore,
} from "./knowledge-sync-service.ts";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const localStoreId = "00000000-0000-4000-8000-000000000101";
const remoteStoreId = "00000000-0000-4000-8000-000000000102";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-knowledge-sync-"));
  temporaryDirectories.push(root);
  return root;
}

async function gitIdentityEnvironment(
  root: string,
  name = "Desktop Git User",
  email = "desktop-user@example.test",
): Promise<NodeJS.ProcessEnv> {
  const globalConfig = join(root, "gitconfig");
  await writeFile(globalConfig, `[user]\n\tname = ${name}\n\temail = ${email}\n`, "utf8");
  return {
    HOME: root,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
}

function remoteStore(id: string, name: string, content: string) {
  return {
    id,
    name,
    description: `${name} description`,
    directories: ["guides"],
    files: [
      {
        id: "guides/readme.md",
        content,
        metadata: { trigger: "always_on" as const, priority: "normal" as const },
      },
    ],
  };
}

function memoryProvider(initialStores: ReturnType<typeof remoteStore>[]) {
  let revision = "remote-1";
  let stores: Map<string, RemoteStore> = new Map(initialStores.map((store) => [store.id, store]));
  let externalRevision = 1;
  let readCount = 0;
  let readError: Error | undefined;
  let forcedHeadChanges = 0;
  let reference = "main";
  const publications: Parameters<ContextStoreSyncProvider["publish"]>[0][] = [];
  const provider: ContextStoreSyncProvider = {
    async readHead() {
      readCount += 1;
      if (readError !== undefined) throw readError;
      return { revision, reference, repository: { stores: new Map(stores) } };
    },
    async publish(input) {
      publications.push(input);
      if (forcedHeadChanges > 0) {
        forcedHeadChanges -= 1;
        externalRevision += 1;
        revision = `external-${externalRevision}`;
        return { status: "head_changed" };
      }
      if (input.expectedRevision !== revision) return { status: "head_changed" };
      revision = `remote-${publications.length + 1}`;
      stores = new Map(input.repository.stores);
      return { status: "published", revision };
    },
  };
  return {
    provider,
    publications,
    stores: () => stores,
    readCount: () => readCount,
    failReadsWith: (error: Error | undefined) => {
      readError = error;
    },
    forceHeadChanges: (count: number) => {
      forcedHeadChanges = count;
    },
    setReference: (value: string) => {
      reference = value;
    },
    replaceRemote: (next: ReturnType<typeof remoteStore>[]) => {
      externalRevision += 1;
      revision = `external-${externalRevision}`;
      stores = new Map(next.map((store) => [store.id, store]));
    },
  };
}

async function fixture(provider: ContextStoreSyncProvider, storeOverride?: ContextStoreStore) {
  const root = await temporaryRoot();
  const stores =
    storeOverride ?? createContextStoreStore({ storesPath: join(root, "data", "context-stores") });
  const service = createKnowledgeSyncService({
    configurationPath: join(root, "state", "knowledge-sync-settings.json"),
    statePath: join(root, "state", "knowledge-sync-state.json"),
    cacheRoot: join(root, "cache", "knowledge-sync"),
    stores,
    provider,
  });
  return { root, stores, service };
}

async function configure(service: Awaited<ReturnType<typeof fixture>>["service"]) {
  return await service.configure({
    remote: "ssh://git@example.test/knowledge.git",
    autoPush: true,
    pushDeletions: false,
  });
}

describe("knowledge sync service", () => {
  it("merges local-only and remote-only stores on first connection", async () => {
    const memory = memoryProvider([remoteStore(remoteStoreId, "Remote", "# Remote\n")]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Local",
      description: "Local description",
      files: remoteStore(localStoreId, "Local", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });

    const overview = await configure(service);

    expect(memory.publications).toHaveLength(1);
    expect([...memory.stores().keys()].toSorted()).toEqual([localStoreId, remoteStoreId]);
    expect((await stores.getContent(remoteStoreId, "guides/readme.md")).content).toBe("# Remote\n");
    expect(overview).toMatchObject({ status: "ready", conflicts: [] });
    expect(overview.stores.every((store) => store.status === "synced")).toBe(true);
  });

  it("requires a whole-store choice when the same id differs and records remote application as sync", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Remote\n")]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });

    const conflicted = await configure(service);
    expect(conflicted.status).toBe("conflict");
    expect(conflicted.conflicts).toHaveLength(1);
    expect(memory.publications).toHaveLength(0);

    const resolved = await service.resolveConflict(localStoreId, "remote");

    expect(resolved).toMatchObject({ status: "ready", conflicts: [] });
    expect((await stores.getContent(localStoreId, "guides/readme.md")).content).toBe("# Remote\n");
    expect(await stores.history(localStoreId)).toContainEqual(
      expect.objectContaining({ author: "sync", summary: "Synchronize knowledge from Git." }),
    );
    expect(memory.publications[0]?.alternate?.stores.get(localStoreId)?.files[0]?.content).toBe(
      "# Local\n",
    );
  });

  it("restores the selected target without publishing the local candidate", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Remote\n")]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Local\n").files,
      author: "user",
      summary: "Create local fixture.",
    });

    const restored = await service.configure({
      remote: "ssh://git@example.test/knowledge.git",
      autoPush: true,
      pushDeletions: false,
      initializationMode: "restore_remote",
    });

    expect(restored.status).toBe("ready");
    expect(memory.publications).toHaveLength(0);
    expect((await stores.getContent(localStoreId, "guides/readme.md")).content).toBe("# Remote\n");
  });

  it("preserves a remotely synced store after local deletion until explicitly restored", async () => {
    const memory = memoryProvider([]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Local",
      description: "Local description",
      files: remoteStore(localStoreId, "Local", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });
    await configure(service);
    expect(memory.publications).toHaveLength(1);

    await stores.remove(localStoreId);
    const ignored = await service.sync();

    expect(memory.publications).toHaveLength(1);
    expect(memory.stores().has(localStoreId)).toBe(true);
    expect(ignored.stores).toContainEqual(
      expect.objectContaining({ storeId: localStoreId, status: "ignored_remote" }),
    );

    const restored = await service.restoreIgnored(localStoreId);
    expect(restored.stores).toContainEqual(
      expect.objectContaining({ storeId: localStoreId, status: "synced" }),
    );
    expect((await stores.getContent(localStoreId, "guides/readme.md")).content).toBe("# Local\n");
  });

  it("uses the configured provider head without fetching it twice", async () => {
    const memory = memoryProvider([]);
    const { service } = await fixture(memory.provider);

    await configure(service);

    expect(memory.readCount()).toBe(1);
  });

  it("starts with fresh bases when the resolved branch changes", async () => {
    const memory = memoryProvider([]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Local",
      description: "Local description",
      files: remoteStore(localStoreId, "Local", "# Local\n").files,
      author: "user",
      summary: "Create local fixture.",
    });
    await configure(service);

    memory.setReference("replacement");
    memory.replaceRemote([]);
    const refreshed = await service.refresh();

    expect((await stores.list()).some((store) => store.id === localStoreId)).toBe(true);
    expect(refreshed).toMatchObject({ resolvedBranch: "replacement", status: "ready" });
    expect(refreshed.stores).toContainEqual(
      expect.objectContaining({ storeId: localStoreId, status: "pending" }),
    );
  });

  it("rejects a conflict decision after the resolved branch changes", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Remote\n")]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Local\n").files,
      author: "user",
      summary: "Create local fixture.",
    });
    expect((await configure(service)).status).toBe("conflict");

    memory.setReference("replacement");
    await expect(service.resolveConflict(localStoreId, "remote")).rejects.toThrow(
      "backup target changed",
    );
  });

  it("never publishes local changes during a background pull when auto upload is disabled", async () => {
    const memory = memoryProvider([]);
    const { stores, service } = await fixture(memory.provider);
    await service.configure({
      remote: "ssh://git@example.test/knowledge.git",
      autoPush: false,
      pushDeletions: false,
    });
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Local",
      description: "Local description",
      files: remoteStore(localStoreId, "Local", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });

    const overview = await service.refresh();

    expect(memory.publications).toHaveLength(0);
    expect(overview.stores).toContainEqual(
      expect.objectContaining({ storeId: localStoreId, status: "pending" }),
    );
  });

  it("turns an incoming update into a conflict when the local store changes after scanning", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Base\n")]);
    const storeRoot = await temporaryRoot();
    const stores = createContextStoreStore({
      storesPath: join(storeRoot, "data", "context-stores"),
    });
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Base\n").files,
      author: "import",
      summary: "Create local fixture.",
    });
    let injectConcurrentEdit = false;
    const guardedStores: ContextStoreStore = {
      ...stores,
      async getSnapshot(storeId, revision) {
        const snapshot = await stores.getSnapshot(storeId, revision);
        if (injectConcurrentEdit && revision === undefined) {
          injectConcurrentEdit = false;
          const files = snapshot.files.map((file) =>
            file.id === "guides/readme.md" ? { ...file, content: "# Local late edit\n" } : file,
          );
          await stores.appendSnapshot(
            {
              storeId,
              baseRevision: snapshot.revision,
              baseSnapshotHash: snapshot.snapshotHash,
              snapshotHash: hashSnapshotContent(files, snapshot.directories),
              directories: snapshot.directories,
              files,
              summary: "Concurrent local edit.",
            },
            "user",
          );
        }
        return snapshot;
      },
    };
    const { service } = await fixture(memory.provider, guardedStores);
    await configure(service);
    memory.replaceRemote([remoteStore(localStoreId, "Shared", "# Remote update\n")]);
    injectConcurrentEdit = true;

    const overview = await service.sync();

    expect(overview.status).toBe("conflict");
    expect((await stores.getContent(localStoreId, "guides/readme.md")).content).toBe(
      "# Local late edit\n",
    );
  });

  it("rejects a stale conflict choice after its local candidate changes", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Remote\n")]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });
    await configure(service);
    const snapshot = await stores.getSnapshot(localStoreId);
    const files = snapshot.files.map((file) => ({ ...file, content: "# New local edit\n" }));
    await stores.appendSnapshot(
      {
        storeId: localStoreId,
        baseRevision: snapshot.revision,
        baseSnapshotHash: snapshot.snapshotHash,
        snapshotHash: hashSnapshotContent(files, snapshot.directories),
        directories: snapshot.directories,
        files,
        summary: "Edit after conflict.",
      },
      "user",
    );

    await expect(service.resolveConflict(localStoreId, "remote")).rejects.toThrow(
      "local knowledge base changed",
    );
    expect((await stores.getContent(localStoreId, "guides/readme.md")).content).toBe(
      "# New local edit\n",
    );
  });

  it("retries conflict resolution when the head moves without changing the candidate", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Remote\n")]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });
    await configure(service);
    memory.forceHeadChanges(1);

    const resolved = await service.resolveConflict(localStoreId, "remote");

    expect(resolved.status).toBe("ready");
    expect((await stores.getContent(localStoreId, "guides/readme.md")).content).toBe("# Remote\n");
  });

  it("stores conflict summaries without copying remote Markdown content", async () => {
    const memory = memoryProvider([remoteStore(localStoreId, "Shared", "# Secret remote body\n")]);
    const { root, stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Shared",
      description: "Shared description",
      files: remoteStore(localStoreId, "Shared", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });

    await configure(service);

    const persisted = await readFile(join(root, "state", "knowledge-sync-state.json"), "utf8");
    expect(persisted).not.toContain("Secret remote body");
    expect(persisted).toContain('"fingerprint"');
  });

  it("removes an ignored marker after the remote store disappears", async () => {
    const memory = memoryProvider([]);
    const { stores, service } = await fixture(memory.provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Readable name",
      description: "Local description",
      files: remoteStore(localStoreId, "Readable name", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });
    await configure(service);
    await stores.remove(localStoreId);
    const ignored = await service.sync();
    expect(ignored.stores).toContainEqual(
      expect.objectContaining({ name: "Readable name", status: "ignored_remote" }),
    );

    memory.replaceRemote([]);
    const refreshed = await service.refresh();

    expect(refreshed.stores.some((store) => store.storeId === localStoreId)).toBe(false);
  });

  it("bounds persisted errors and reports repeated remote changes", async () => {
    let publishCount = 0;
    const provider: ContextStoreSyncProvider = {
      async readHead() {
        return { revision: "moving", reference: "main", repository: { stores: new Map() } };
      },
      async publish() {
        publishCount += 1;
        return { status: "head_changed" };
      },
    };
    const { stores, service } = await fixture(provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Local",
      description: "Local description",
      files: remoteStore(localStoreId, "Local", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });

    const overview = await configure(service);

    expect(publishCount).toBe(3);
    expect(overview).toMatchObject({ status: "error", errorCode: "remote_changed_too_often" });
    expect(overview.errorMessage?.length).toBeLessThanOrEqual(2_000);
  });

  it("reports a rejected push without retrying it as a remote change", async () => {
    let publishCount = 0;
    const provider: ContextStoreSyncProvider = {
      async readHead() {
        return { revision: "stable", reference: "main", repository: { stores: new Map() } };
      },
      async publish() {
        publishCount += 1;
        throw new Error("[remote rejected] main -> main (protected branch)");
      },
    };
    const { stores, service } = await fixture(provider);
    await stores.createFromSnapshot({
      id: localStoreId,
      name: "Local",
      description: "Local description",
      files: remoteStore(localStoreId, "Local", "# Local\n").files,
      author: "import",
      summary: "Create local fixture.",
    });

    const overview = await configure(service);

    expect(publishCount).toBe(1);
    expect(overview).toMatchObject({ status: "error", errorCode: "git_push_rejected" });
    expect(overview.errorMessage).toContain("protected branch");
  });

  it("truncates provider failures to the public error-message limit", async () => {
    const memory = memoryProvider([]);
    const { service } = await fixture(memory.provider);
    await configure(service);
    memory.failReadsWith(new Error(`remote failure: ${"x".repeat(3_000)}`));

    const overview = await service.sync();

    expect(overview.status).toBe("error");
    expect(overview.errorMessage).toHaveLength(2_000);
  });
});

describe("knowledge sync protocol", () => {
  it("rejects duplicate file paths before a repository is loaded", () => {
    const parsed = KnowledgeSyncStoreManifestSchema.safeParse({
      schemaVersion: "pragma.knowledge-sync-store/v1",
      id: localStoreId,
      name: "Duplicate",
      description: "",
      directories: [],
      files: [
        {
          path: "readme.md",
          metadata: { trigger: "always_on", priority: "normal" },
        },
        {
          path: "readme.md",
          metadata: { trigger: "always_on", priority: "normal" },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });
});

describe("Git knowledge sync provider", { timeout: 15_000 }, () => {
  it("writes readable Markdown while preserving unrelated repository files", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    const checkout = join(root, "checkout");
    await git(undefined, "init", "--bare", "--initial-branch=main", remote);
    await git(undefined, "init", "--initial-branch=main", seed);
    await git(seed, "config", "user.name", "Fixture");
    await git(seed, "config", "user.email", "fixture@example.test");
    await writeFile(join(seed, "README.md"), "Existing repository content.\n", "utf8");
    await git(seed, "add", "README.md");
    await git(seed, "commit", "-m", "Seed repository");
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "origin", "main");

    const configuration = {
      schemaVersion: "pragma.knowledge-sync-settings/v1",
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    } satisfies KnowledgeSyncConfiguration;
    const cacheRoot = join(root, "cache");
    const provider = createGitContextStoreSyncProvider(cacheRoot, configuration, {
      env: await gitIdentityEnvironment(root),
    });
    const head = await provider.readHead();
    await git(join(cacheRoot, "repository"), "config", "user.name", "Pragma Knowledge Sync");
    await git(join(cacheRoot, "repository"), "config", "user.email", "knowledge-sync@pragma.local");
    const store = remoteStore(localStoreId, "Readable", "# Directly readable\n");
    const published = await provider.publish({
      expectedRevision: head.revision,
      repository: { stores: new Map([[store.id, store]]) },
      message: "Publish readable knowledge",
    });
    expect(published.status).toBe("published");

    await git(undefined, "clone", remote, checkout);
    expect(await readFile(join(checkout, "README.md"), "utf8")).toBe(
      "Existing repository content.\n",
    );
    expect(
      await readFile(
        join(checkout, "knowledge-bases", localStoreId, "files", "guides", "readme.md"),
        "utf8",
      ),
    ).toBe("# Directly readable\n");
    expect(await readFile(join(checkout, "pragma-knowledge-sync.yaml"), "utf8")).toContain(
      "pragma.knowledge-sync/v1",
    );
    expect((await git(checkout, "log", "-1", "--format=%an <%ae>")).trim()).toBe(
      "Desktop Git User <desktop-user@example.test>",
    );
  });

  it("preserves the server rejection instead of misreporting a remote head change", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote");
    await git(undefined, "init", "--initial-branch=main", remote);
    await git(remote, "config", "user.name", "Fixture");
    await git(remote, "config", "user.email", "fixture@example.test");
    await writeFile(join(remote, "README.md"), "Protected repository content.\n", "utf8");
    await git(remote, "add", "README.md");
    await git(remote, "commit", "-m", "Seed repository");

    const configuration = {
      schemaVersion: "pragma.knowledge-sync-settings/v1",
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    } satisfies KnowledgeSyncConfiguration;
    const provider = createGitContextStoreSyncProvider(join(root, "cache"), configuration, {
      env: await gitIdentityEnvironment(root),
    });
    const head = await provider.readHead();
    const store = remoteStore(localStoreId, "Readable", "# Directly readable\n");

    await expect(
      provider.publish({
        expectedRevision: head.revision,
        repository: { stores: new Map([[store.id, store]]) },
        message: "Publish to a protected branch",
      }),
    ).rejects.toThrow(/checked out branch|branch is currently checked out/u);
  });

  it("fails with an actionable error when the global Git identity is missing", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    const globalConfig = join(root, "empty-gitconfig");
    await git(undefined, "init", "--bare", "--initial-branch=main", remote);
    await writeFile(globalConfig, "", "utf8");
    const configuration = {
      schemaVersion: "pragma.knowledge-sync-settings/v1",
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    } satisfies KnowledgeSyncConfiguration;
    const provider = createGitContextStoreSyncProvider(join(root, "cache"), configuration, {
      env: {
        HOME: root,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    const head = await provider.readHead();
    const store = remoteStore(localStoreId, "Readable", "# Directly readable\n");

    await expect(
      provider.publish({
        expectedRevision: head.revision,
        repository: { stores: new Map([[store.id, store]]) },
        message: "Publish without a Git identity",
      }),
    ).rejects.toThrow("git config --global");
  });

  it("rejects oversized managed Markdown before loading repository content", async () => {
    const root = await temporaryRoot();
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    await git(undefined, "init", "--bare", "--initial-branch=main", remote);
    await git(undefined, "init", "--initial-branch=main", seed);
    await git(seed, "config", "user.name", "Fixture");
    await git(seed, "config", "user.email", "fixture@example.test");
    await mkdir(join(seed, "knowledge-bases", localStoreId, "files", "guides"), {
      recursive: true,
    });
    await writeFile(
      join(seed, "pragma-knowledge-sync.yaml"),
      "schemaVersion: pragma.knowledge-sync/v1\n",
    );
    await writeFile(
      join(seed, "knowledge-bases", localStoreId, "store.yaml"),
      [
        "schemaVersion: pragma.knowledge-sync-store/v1",
        `id: ${localStoreId}`,
        "name: Oversized",
        'description: ""',
        "directories:",
        "  - guides",
        "files:",
        "  - path: guides/readme.md",
        "    metadata:",
        "      trigger: always_on",
        "      priority: normal",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(seed, "knowledge-bases", localStoreId, "files", "guides", "readme.md"),
      "x".repeat(1_000_001),
    );
    await git(seed, "add", ".");
    await git(seed, "commit", "-m", "Add oversized knowledge file");
    await git(seed, "remote", "add", "origin", remote);
    await git(seed, "push", "origin", "main");
    const configuration = {
      schemaVersion: "pragma.knowledge-sync-settings/v1",
      remote,
      branch: "main",
      autoPush: true,
      pushDeletions: false,
    } satisfies KnowledgeSyncConfiguration;
    const provider = createGitContextStoreSyncProvider(join(root, "cache"), configuration);

    await expect(provider.readHead()).rejects.toThrow("exceeds 1000000 bytes");
  });
});

async function git(repository: string | undefined, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    repository === undefined ? args : ["-C", repository, ...args],
  );
  return stdout;
}
