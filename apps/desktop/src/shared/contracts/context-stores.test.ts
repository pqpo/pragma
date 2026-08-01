import { describe, expect, it } from "vitest";

import {
  CreateContextStoreFileSchema,
  CreateContextStoreFolderSchema,
  RenameContextStoreEntrySchema,
} from "./context-stores.ts";

const STORE_ID = "ec827580-bcab-4f25-b03b-7126b8d3e828";

describe("context-store managed entry contracts", () => {
  it("accepts readable Unicode names up to 100 characters", () => {
    expect(
      CreateContextStoreFolderSchema.safeParse({ storeId: STORE_ID, id: "产品说明-v2（草稿）" })
        .success,
    ).toBe(true);
    expect(
      CreateContextStoreFileSchema.safeParse({
        storeId: STORE_ID,
        id: `${"a".repeat(100)}.md`,
        content: "",
      }).success,
    ).toBe(true);
  });

  it("rejects whitespace, reserved names, and names over 100 characters", () => {
    expect(
      CreateContextStoreFolderSchema.safeParse({ storeId: STORE_ID, id: "two words" }).success,
    ).toBe(false);
    expect(
      CreateContextStoreFileSchema.safeParse({ storeId: STORE_ID, id: "CON.md", content: "" })
        .success,
    ).toBe(false);
    expect(
      CreateContextStoreFileSchema.safeParse({
        storeId: STORE_ID,
        id: `${"a".repeat(101)}.md`,
        content: "",
      }).success,
    ).toBe(false);
  });

  it("validates renamed names but still permits moving an unchanged imported name", () => {
    expect(
      RenameContextStoreEntrySchema.safeParse({
        storeId: STORE_ID,
        id: "notes.md",
        nextId: "two words.md",
        kind: "file",
      }).success,
    ).toBe(false);
    expect(
      RenameContextStoreEntrySchema.safeParse({
        storeId: STORE_ID,
        id: "legacy name.md",
        nextId: "archive/legacy name.md",
        kind: "file",
      }).success,
    ).toBe(true);
  });
});
