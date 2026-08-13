import { describeRuntimeConformance } from "@pragma/core/testing/vitest";

import { createQoderCliRuntime } from "../src/adapter.ts";

describeRuntimeConformance("Qoder CLI", {
  createRuntime: createQoderCliRuntime,
});
