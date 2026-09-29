import { describe, expect, it } from "vitest";
import {
  decodeMetadata,
  encodeMetadata,
  mergeMetadata,
  metadataDocumentPath,
  metadataPath,
  normalizeKnowledgeFiles,
} from "./knowledge-git-metadata.ts";

const path = metadataPath("guides/setup.md");
const base = {
  description: "Setup",
  trigger: "manual" as const,
  priority: "normal" as const,
  trustLevel: "user" as const,
  sensitivity: "internal" as const,
};

describe("knowledge Git YAML metadata", () => {
  it("mirrors document paths and round trips every field in a stable order", () => {
    expect(metadataDocumentPath(path)).toBe("guides/setup.md");
    expect(decodeMetadata(path, encodeMetadata(base))).toEqual(base);
    expect(encodeMetadata(base).toString()).toBe(
      "schemaVersion: pragma.knowledge-document-metadata/v1\ndescription: Setup\ntrigger: manual\npriority: normal\ntrustLevel: user\nsensitivity: internal\n",
    );
  });
  it("merges independent fields and explicit optional-field removal", () => {
    const withoutDescription = { ...base, description: undefined };
    const merged = mergeMetadata(
      path,
      encodeMetadata(base),
      encodeMetadata(withoutDescription),
      encodeMetadata({ ...base, priority: "high" }),
    );
    expect(merged.conflict).toBe(false);
    expect(decodeMetadata(path, merged.local).description).toBeUndefined();
    expect(decodeMetadata(path, merged.local).priority).toBe("high");
  });
  it("keeps automatic field merges in both favored conflict previews", () => {
    const result = mergeMetadata(
      path,
      encodeMetadata(base),
      encodeMetadata({ ...base, description: "Local", priority: "high" }),
      encodeMetadata({ ...base, description: "Remote", sensitivity: "restricted" }),
    );
    expect(result.conflict).toBe(true);
    expect(decodeMetadata(path, result.local)).toEqual({
      ...base,
      description: "Local",
      priority: "high",
      sensitivity: "restricted",
    });
    expect(decodeMetadata(path, result.remote)).toEqual({
      ...base,
      description: "Remote",
      priority: "high",
      sensitivity: "restricted",
    });
  });
  it.each([
    "schemaVersion: pragma.knowledge-document-metadata/v2\ntrigger: manual\npriority: normal\n",
    "schemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: manual\npriority: high\npriority: low\n",
    "schemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: manual\npriority: normal\nunknown: yes\n",
    "schemaVersion: [\n",
    "schemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: !unsupported manual\npriority: normal\n",
    "%YAML 1.3\n---\nschemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: manual\npriority: normal\n",
    "schemaVersion: pragma.knowledge-document-metadata/v1\ntrigger: invented\npriority: normal\n",
    "x".repeat(65_537),
  ])("rejects invalid metadata with its path", (yaml) => {
    expect(() => decodeMetadata(path, Buffer.from(yaml))).toThrow(path);
  });
  it("preserves fallback metadata but rejects orphans and invalid mirrored paths", () => {
    const content = new Map([["guides/setup.md", Buffer.from("# Setup\n")]]);
    const result = normalizeKnowledgeFiles(content, new Map([[path, encodeMetadata(base)]]));
    expect(decodeMetadata(path, result.get(path)!)).toEqual(base);
    expect(() => normalizeKnowledgeFiles(new Map([[path, encodeMetadata(base)]]))).toThrow(
      "corresponding Markdown",
    );
    expect(() => metadataDocumentPath(".pragma/metadata/../setup.md.yaml")).toThrow("mirrored");
  });
});
