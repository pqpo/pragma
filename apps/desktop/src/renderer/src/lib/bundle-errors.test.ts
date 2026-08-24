import { describe, expect, it } from "vitest";

import { localizedBundleMutationError } from "./bundle-errors.ts";

describe("localizedBundleMutationError", () => {
  it("replaces legacy generated Context names with a useful knowledge-base label", () => {
    const translated = localizedBundleMutationError(
      {
        code: "bundle_setup_required",
        message: "Complete setup.",
        diagnostics: [],
        bundleSetup: {
          rootRef: "expert:1xddvess309a6gme",
          operation: "create_mission",
          dependencies: [
            {
              id: "context-store:context-store:kqh4nx7rx26mb3e7",
              kind: "context-store",
              resourceRef: "context-store:kqh4nx7rx26mb3e7",
              name: "Context 26980318-cc35-4a16-95ae-fd8806492c4a",
              status: "missing",
              code: "context_store_missing",
              action: "choose_knowledge_base",
              message: "Choose a knowledge base.",
            },
          ],
        },
      },
      (key, options) =>
        key === "bundleLegacyKnowledgeBase"
          ? "知识库（旧版 Bundle 未保留名称）"
          : `${String(options?.["count"])}:${String(options?.["resources"])}`,
    );

    expect(translated).toBe("1:知识库（旧版 Bundle 未保留名称）");
  });
});
