import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";
import { readFileSync } from "node:fs";
import { SkillDataSchema } from "@pragma/local-host/deployment";
import { PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID } from "@pragma/built-in-agents";
import { describe, expect, it } from "vitest";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import type { CoreAssetSyncItem } from "../../../shared/contracts/index.ts";
import {
  encodeSyncRepository,
  decodeSyncRepository,
  type SyncFile,
} from "./asset-sync-repository.ts";
import { fingerprint } from "../asset-transfer/asset-transfer-fingerprint.ts";

const storeId = "f13af121-439b-4bad-8fe4-8b7dc27554d3";
const skillId = "0df66ebd-69bb-4656-82e5-5634a3878139";
const item = (
  kind: CoreAssetSyncItem["kind"],
  id: string,
  name: string,
  data: unknown,
): CoreAssetSyncItem => ({
  kind,
  key: `${kind}:${id}`,
  name,
  data,
  fingerprint: fingerprint(data),
});
const file = (content: string): SyncFile => ({ bytes: Buffer.from(content), executable: false });
const knowledge = () =>
  item("knowledge", storeId, "项目规范", {
    name: "项目规范",
    description: "团队约定",
    directories: ["empty", "guides"],
    files: [
      {
        id: "guides/coding.md",
        content: "# 编码规范\n\n保留原生正文。\n",
        metadata: { trigger: "manual", priority: "high", sensitivity: "internal" },
      },
    ],
  });
const skill = () =>
  item("skill", skillId, "review", {
    name: "review",
    description: "Review code",
    files: [
      {
        path: "SKILL.md",
        content: Buffer.from(
          "---\nname: review\ndescription: Review code\n---\n\nReview changes.\n",
        ).toString("base64"),
        executable: false,
      },
      {
        path: "scripts/check.mjs",
        content: Buffer.from("export const check = true;\n").toString("base64"),
        executable: true,
      },
      {
        path: "references/image.bin",
        content: Buffer.from([0, 255, 128, 10]).toString("base64"),
        executable: false,
      },
    ],
  });
const encode = (...items: CoreAssetSyncItem[]) =>
  encodeSyncRepository(new Map(items.map((entry) => [entry.key, entry])));

describe("structured sync repository", () => {
  it("validates Git association ownership, resolved branches and credential-free remotes", () => {
    const source = item("knowledge-git", storeId, "项目规范", {
      remote: "ssh://git@pragma.test/docs.git",
      branch: "main",
    });
    const files = encode(knowledge(), source);
    expect(decodeSyncRepository(files).get(source.key)).toEqual(source);
    files.delete(`knowledge-bases/${storeId}/metadata.yaml`);
    expect(() => decodeSyncRepository(files)).toThrow("Git association has no asset");
    for (const data of [
      { remote: "ssh://git@pragma.test/docs.git" },
      { remote: "https://user:secret@example.com/docs.git", branch: "main" },
    ]) {
      expect(() => encode(knowledge(), { ...source, data })).toThrow();
    }
  });

  it.each(["pragma.asset-sync-repository/v1", "pragma.asset-sync-repository/v2"])(
    "upgrades historical DSL independently of repository format %s without changing source bytes",
    (schemaVersion) => {
      // Unmodified historical writer output, also used by Interpreter's migration tests.
      const legacy = readFileSync(
        new URL(
          "../../../../../../packages/interpreter/test/fixtures/compiler-v9-expert-permissions/experts/v2vt1v01vzz6j24q.pragma.yaml",
          import.meta.url,
        ),
        "utf8",
      );
      const chained = readFileSync(
        new URL(
          "../../../../../../packages/interpreter/test/fixtures/compiler-v5-avatar/pragma.yaml",
          import.meta.url,
        ),
        "utf8",
      );
      const files = new Map([
        ["sync.yaml", file(formatPragmaYaml({ schemaVersion }))],
        ["experts/v2vt1v01vzz6j24q.pragma.yaml", file(legacy)],
        ["experts/3sfd30h5017wd17d.pragma.yaml", file(chained)],
      ]);
      const original = new Map(
        [...files].map(([path, entry]) => [path, { ...entry, bytes: Buffer.from(entry.bytes) }]),
      );
      const restored = decodeSyncRepository(files);
      const expert = restored.get("expert:expert:v2vt1v01vzz6j24q")!;
      expect(expert.data).toEqual({
        ...(parsePragmaYaml(legacy) as object),
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      });
      expect(restored.get("expert:expert:3sfd30h5017wd17d")?.data).toMatchObject({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        metadata: { avatarId: "pragma.avatar.expert.default" },
      });
      expect(expert.fingerprint).toBe(fingerprint(expert.data));
      expect(files).toEqual(original);
      const current = encodeSyncRepository(restored);
      expect(current.get("experts/v2vt1v01vzz6j24q.pragma.yaml")?.bytes.toString()).toContain(
        `apiVersion: ${PRAGMA_DSL_WRITE_API_VERSION}`,
      );
      expect(decodeSyncRepository(current)).toEqual(restored);
      // Manual Git edits can update one resource while leaving another on its old version.
      current.set("experts/v2vt1v01vzz6j24q.pragma.yaml", file(legacy));
      expect(decodeSyncRepository(current)).toEqual(restored);
    },
  );

  it.each([
    ["future", "pragma/v999", "unsupported_api_version"],
    ["missing migration", "pragma/v1", "missing_migration_step"],
    ["malformed version", "invalid", "unsupported_api_version"],
  ])("rejects %s DSL without changing source files", (_label, apiVersion, code) => {
    const files = new Map([
      ["sync.yaml", file("schemaVersion: pragma.asset-sync-repository/v2\n")],
      [
        "experts/v2vt1v01vzz6j24q.pragma.yaml",
        file(formatPragmaYaml({ apiVersion, kind: "Expert", metadata: {} })),
      ],
    ]);
    const original = new Map(
      [...files].map(([path, entry]) => [path, { ...entry, bytes: Buffer.from(entry.bytes) }]),
    );
    expect(() => decodeSyncRepository(files)).toThrowError(expect.objectContaining({ code }));
    expect(files).toEqual(original);
  });

  it("rejects invalid historical known fields and Bundle documents in resource paths", () => {
    const legacy = readFileSync(
      new URL(
        "../../../../../../packages/interpreter/test/fixtures/compiler-v9-expert-permissions/experts/v2vt1v01vzz6j24q.pragma.yaml",
        import.meta.url,
      ),
      "utf8",
    );
    const resource = parsePragmaYaml(legacy) as { spec: { instructions: unknown } };
    resource.spec.instructions = null;
    const files = new Map([
      ["sync.yaml", file("schemaVersion: pragma.asset-sync-repository/v2\n")],
      ["experts/v2vt1v01vzz6j24q.pragma.yaml", file(formatPragmaYaml(resource))],
    ]);
    expect(() => decodeSyncRepository(files)).toThrow();
    files.set(
      "experts/v2vt1v01vzz6j24q.pragma.yaml",
      file(
        formatPragmaYaml({
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
          kind: "Bundle",
          resources: [],
        }),
      ),
    );
    expect(() => decodeSyncRepository(files)).toThrow("Unsupported sync resource kind");
  });

  it("writes readable YAML and original files with stable, binary-safe round trips", () => {
    const entries = [knowledge(), skill()];
    const files = encode(...entries);
    expect(files.get(`knowledge-bases/${storeId}/files/guides/coding.md`)?.bytes.toString()).toBe(
      "# 编码规范\n\n保留原生正文。\n",
    );
    expect(files.get(`skills/${skillId}/files/references/image.bin`)?.bytes).toEqual(
      Buffer.from([0, 255, 128, 10]),
    );
    expect(files.get(`skills/${skillId}/files/scripts/check.mjs`)?.executable).toBe(true);
    expect(files.get("README.md")?.bytes.toString()).toContain("项目规范");
    expect([...files.keys()].some((path) => path.endsWith(".json"))).toBe(false);
    const restored = [...decodeSyncRepository(files).values()];
    expect(restored[0]).toEqual(entries[0]);
    const skillData = entries[1]!.data as {
      name: string;
      description: string;
      files: { path: string; content: string; executable: boolean }[];
    };
    const normalizedSkill = {
      ...skillData,
      files: [...skillData.files].sort((a, b) => a.path.localeCompare(b.path)),
    };
    expect(restored[1]).toEqual(item("skill", skillId, "review", normalizedSkill));
    expect(encodeSyncRepository(decodeSyncRepository(files))).toEqual(files);
  });
  it("round-trips binary resources without counting UTF-8 replacement bytes", () => {
    const data = SkillDataSchema.parse(skill().data);
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0xff);
    data.files.push({
      path: "assets/runtime.bin",
      content: bytes.toString("base64"),
      executable: true,
    });
    const files = encode(item("skill", skillId, "review", data));
    expect(files.get(`skills/${skillId}/files/assets/runtime.bin`)?.bytes.equals(bytes)).toBe(true);
    const restored = SkillDataSchema.parse(
      decodeSyncRepository(files).get(`skill:${skillId}`)!.data,
    );
    expect(restored.files.find((entry) => entry.path === "assets/runtime.bin")).toEqual(
      data.files.at(-1),
    );
  });

  it("rejects binary resources exceeding the actual package byte limit", () => {
    const data = SkillDataSchema.parse(skill().data);
    data.files.push({
      path: "assets/runtime.bin",
      content: Buffer.alloc(MAX_SKILL_PACKAGE_BYTES, 0xff).toString("base64"),
      executable: true,
    });
    expect(() => encode(item("skill", skillId, "review", data))).toThrow("package exceeds 25 MiB");
  });

  it("rejects an entry document containing invalid UTF-8 instead of decoding it lossily", () => {
    const files = encode(skill());
    files.set(`skills/${skillId}/files/SKILL.md`, {
      bytes: Buffer.concat([
        Buffer.from("---\nname: review\ndescription: "),
        Buffer.from([0xff]),
        Buffer.from("\n---\n"),
      ]),
      executable: false,
    });
    expect(() => decodeSyncRepository(files)).toThrow("entry must be valid UTF-8 text");
  });

  it("identifies an invalid incoming Skill by ID and package path", () => {
    const files = encode(skill());
    files.set(
      `skills/${skillId}/files/SKILL.md`,
      file("---\nname: another-skill\ndescription: Review code\n---\n"),
    );

    let errorMessage = "";
    try {
      decodeSyncRepository(files);
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toContain(`ID ${skillId}`);
    expect(errorMessage).toContain(`pragma-sync/skills/${skillId}`);
    expect(errorMessage).toContain("SKILL.md:name");
  });
  it.each(["Review\ncode", String.raw`Review \ncode with \"quotes\"`, "Different description"])(
    "derives the metadata description from SKILL.md instead of stale cache text: %s",
    (description) => {
      const original = skill();
      const originalData = original.data as {
        name: string;
        description: string;
        files: { path: string; content: string; executable: boolean }[];
      };
      const multilineData = { ...originalData, description };
      const files = encode(item("skill", skillId, "review", multilineData));

      const restored = decodeSyncRepository(files).get(`skill:${skillId}`);

      expect(restored?.data).toMatchObject({ description: "Review code" });
      expect(encodeSyncRepository(decodeSyncRepository(files))).toEqual(files);
    },
  );
  it.each(["Legacy directory annotation", "🧠".repeat(300)])(
    "migrates a frozen v1 Skill description snapshot without rewriting its source: %s",
    (annotation) => {
      const metadataPath = `skills/${skillId}/metadata.yaml`;
      const entryPath = `skills/${skillId}/files/SKILL.md`;
      const legacyMetadata = `id: ${skillId}\nname: review\ndescription: ${annotation}\nentryPath: SKILL.md\n`;
      const entry =
        "---\nname: review\ndescription: |-\n  Actual skill\n  description\n---\n\nRun the review.\n";
      const legacy = new Map<string, SyncFile>([
        ["sync.yaml", file("schemaVersion: pragma.asset-sync-repository/v1\n")],
        [metadataPath, file(legacyMetadata)],
        [entryPath, file(entry)],
        [
          `skills/${skillId}/files/references/metadata.yaml`,
          file("description: Native YAML resource\n"),
        ],
        [
          `skills/${skillId}/files/scripts/run.sh`,
          { bytes: Buffer.from("#!/bin/sh\nexit 0\n"), executable: true },
        ],
      ]);
      const restored = decodeSyncRepository(legacy);
      expect(restored.get(`skill:${skillId}`)?.data).toMatchObject({
        description: "Actual skill\ndescription",
      });
      expect(legacy.get(metadataPath)?.bytes.toString()).toBe(legacyMetadata);
      expect(legacy.get("sync.yaml")?.bytes.toString()).toContain("repository/v1");
      const current = encodeSyncRepository(restored);
      expect(current.get("sync.yaml")?.bytes.toString()).toContain("repository/v2");
      expect(current.get(entryPath)?.bytes.toString()).toBe(entry);
      expect(
        current.get(`skills/${skillId}/files/references/metadata.yaml`)?.bytes.toString(),
      ).toBe("description: Native YAML resource\n");
      expect(decodeSyncRepository(current)).toEqual(restored);
      expect(current.get(`skills/${skillId}/files/scripts/run.sh`)?.executable).toBe(true);
    },
  );

  it("migrates actual v1 writer output at the 50 Unicode-character name boundary", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL("./fixtures/repository-v1/skill-name-boundary.json", import.meta.url),
        "utf8",
      ),
    ) as { files: { path: string; content: string; executable: boolean }[] };
    const legacy = new Map(
      fixture.files.map((entry) => [
        entry.path,
        { bytes: Buffer.from(entry.content), executable: entry.executable },
      ]),
    );
    const restored = decodeSyncRepository(legacy);
    expect(restored.get(`skill:${skillId}`)?.name).toBe("🧠".repeat(50));
    expect(encodeSyncRepository(decodeSyncRepository(encodeSyncRepository(restored)))).toEqual(
      encodeSyncRepository(restored),
    );
    expect(legacy.get("sync.yaml")?.bytes.toString()).toContain("repository/v1");
  });

  it("rejects unknown future repository versions without altering their files", () => {
    const files = encode(skill());
    const future = file("schemaVersion: pragma.asset-sync-repository/v3\n");
    files.set("sync.yaml", future);
    expect(() => decodeSyncRepository(files)).toThrow();
    expect(files.get("sync.yaml")).toBe(future);
  });

  it("accepts edits, additions and deletions without a manually updated hash index", () => {
    const original = knowledge();
    const files = encode(original);
    files.delete(`knowledge-bases/${storeId}/files/guides/coding.md`);
    files.set(`knowledge-bases/${storeId}/files/new.md`, file("# New knowledge\n"));
    const updated = decodeSyncRepository(files).get(original.key)!;
    expect(updated.fingerprint).not.toBe(original.fingerprint);
    expect(updated.data).toMatchObject({
      directories: ["empty", "guides"],
      files: [
        {
          id: "new.md",
          content: "# New knowledge\n",
          metadata: { trigger: "manual", priority: "normal" },
        },
      ],
    });
  });
  it("ignores YAML formatting and generated documentation in semantic fingerprints", () => {
    const original = knowledge();
    const files = encode(original);
    const path = `knowledge-bases/${storeId}/metadata.yaml`;
    files.set(path, file(`# User comment\n${files.get(path)!.bytes.toString()}\n`));
    files.set("README.md", file("User edited explanation"));
    expect(decodeSyncRepository(files).get(original.key)?.fingerprint).toBe(original.fingerprint);
  });
  it("keeps stable paths after a rename", () => {
    const original = knowledge();
    const renamed = item("knowledge", storeId, "新名称", {
      ...(original.data as object),
      name: "新名称",
    });
    expect([...encode(original).keys()]).toEqual([...encode(renamed).keys()]);
  });
  it("rejects missing/future format markers and malformed YAML", () => {
    const files = encode(knowledge());
    files.delete("sync.yaml");
    expect(() => decodeSyncRepository(files)).toThrow("missing");
    files.set("sync.yaml", file("schemaVersion: pragma.asset-sync-repository/v999\n"));
    expect(() => decodeSyncRepository(files)).toThrow();
    files.set("sync.yaml", file("schemaVersion: [invalid"));
    expect(() => decodeSyncRepository(files)).toThrow();
  });
  it("rejects path collisions, orphan payloads and oversized Knowledge before publication", () => {
    const files = encode(knowledge());
    files.set(`knowledge-bases/${storeId}/files/GUIDES/coding.md`, file("Collision"));
    expect(() => decodeSyncRepository(files)).toThrow("collision");
    files.delete(`knowledge-bases/${storeId}/files/GUIDES/coding.md`);
    files.set("skills/unknown/files/SKILL.md", file("Orphan"));
    expect(() => decodeSyncRepository(files)).toThrow("orphaned");
    files.delete("skills/unknown/files/SKILL.md");
    files.set(`knowledge-bases/${storeId}/files/guides/coding.md`, file("文".repeat(333_334)));
    expect(() => decodeSyncRepository(files)).toThrow("1 MB");
  });
  it("rejects asset identity mismatches and unsafe metadata directory paths", () => {
    const files = encode(knowledge());
    const path = `knowledge-bases/${storeId}/metadata.yaml`;
    files.set(
      path,
      file(
        formatPragmaYaml({
          id: "../escape",
          name: "Invalid",
          description: "",
          directories: [],
          files: [],
        }),
      ),
    );
    expect(() => decodeSyncRepository(files)).toThrow();
  });
  it("continues to reject Git metadata in incoming sync paths and Knowledge metadata", () => {
    const files = encode(knowledge());
    files.set(`knowledge-bases/${storeId}/files/.git/config`, file("Unsafe metadata"));
    expect(() => decodeSyncRepository(files)).toThrow("Unsafe sync path");
    files.delete(`knowledge-bases/${storeId}/files/.git/config`);
    files.set(
      `knowledge-bases/${storeId}/metadata.yaml`,
      file(
        formatPragmaYaml({
          id: storeId,
          name: "Docs",
          description: "",
          directories: [".GIT"],
          files: [],
        }),
      ),
    );
    expect(() => decodeSyncRepository(files)).toThrow("Unsafe sync path");
  });
  it("validates RuntimeProfile configuration and never exports an embedded key", () => {
    const id = "01h0000000000001";
    const data = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "RuntimeProfile",
      metadata: { id, name: "Codex", description: "Runtime binding", tags: [] },
      spec: {
        adapter: "pragma.runtime.profile@v1",
        config: { runtimeId: "codex", providerId: "openai", model: "gpt-test" },
      },
    };
    const files = encode(item("runtime-profile", `runtime-profile:${id}`, "Codex", data));
    expect(files.get(`runtime-profiles/${id}.pragma.yaml`)?.bytes.toString()).not.toContain(
      "apiKey",
    );
    expect(() =>
      encode(
        item("runtime-profile", `runtime-profile:${id}`, "Codex", {
          ...data,
          spec: { ...data.spec, config: { ...data.spec.config, apiKey: "secret" } },
        }),
      ),
    ).toThrow();
  });
  it("rejects total byte and file budgets before parsing asset contents", () => {
    const bytes = Buffer.alloc(1024 * 1024);
    expect(() =>
      decodeSyncRepository(
        new Map(
          Array.from({ length: 151 }, (_, i) => [`files/${i}`, { bytes, executable: false }]),
        ),
      ),
    ).toThrow("150 MiB");
    expect(() =>
      decodeSyncRepository(
        new Map(Array.from({ length: 20_001 }, (_, i) => [`files/${i}`, file("")])),
      ),
    ).toThrow("20,000 files");
  });
  it("validates empty-directory portability against the actual knowledge tree", () => {
    const asset = knowledge();
    const data = asset.data as { directories: string[]; files: { id: string }[] };
    expect(() => encode({ ...asset, data: { ...data, directories: ["Guides"] } })).toThrow(
      "collision",
    );
    expect(() =>
      encode({ ...asset, data: { ...data, directories: ["guides/coding.md"] } }),
    ).toThrow("collision");
  });
  it("canonicalizes manual Knowledge metadata and implicit parents before fingerprinting", () => {
    const files = encode(knowledge());
    files.set(
      `knowledge-bases/${storeId}/metadata.yaml`,
      file(
        formatPragmaYaml({
          id: storeId,
          name: "  Docs  ",
          description: "   ",
          directories: ["empty/nested"],
          files: [],
        }),
      ),
    );
    expect(decodeSyncRepository(files).get(`knowledge:${storeId}`)?.data).toMatchObject({
      name: "Docs",
      description: "",
      directories: ["empty", "empty/nested", "guides"],
    });
  });
  it("rejects colliding Skill directory prefixes, control characters and empty directory ancestors", () => {
    const files = encode(skill());
    files.set(`skills/${skillId}/files/Scripts/new.mjs`, file("export const ok = true;"));
    expect(() => decodeSyncRepository(files)).toThrow("collision");
    files.delete(`skills/${skillId}/files/Scripts/new.mjs`);
    files.set(`skills/${skillId}/files/references/bad\nname.txt`, file("Invalid"));
    expect(() => decodeSyncRepository(files)).toThrow("Unsafe");
    const asset = knowledge();
    expect(() =>
      encode({
        ...asset,
        data: { ...(asset.data as object), directories: ["guides/coding.md/nested"] },
      }),
    ).toThrow("collision");
  });
  it("rejects two payload types for one Capability identity and reserved system identities", () => {
    const definition = {
      kind: "mcp_server",
      name: "Tools",
      description: "Tools",
      connection: { transport: "streamable-http", url: "https://example.test/mcp" },
      tools: [],
      timeoutMs: 30_000,
    };
    expect(() =>
      decodeSyncRepository(encode(skill(), item("capability", skillId, "Tools", definition))),
    ).toThrow("identity");
    expect(() =>
      decodeSyncRepository(
        encode(item("capability", PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID, "Tools", definition)),
      ),
    ).toThrow("System");
  });
});
