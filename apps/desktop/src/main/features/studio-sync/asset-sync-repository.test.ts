import { PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID } from "@pragma/built-in-agents";
import { describe, expect, it } from "vitest";
import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { formatPragmaYaml } from "@pragma/interpreter";
import type { CoreAssetSyncItem } from "../../../shared/contracts/index.ts";
import {
  encodeSyncRepository,
  decodeSyncRepository,
  type SyncFile,
} from "./asset-sync-repository.ts";
import { fingerprint } from "../bundles/asset-transfer-fingerprint.ts";

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
