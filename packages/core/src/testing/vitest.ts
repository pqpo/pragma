import { describe, it } from "vitest";

import { createRuntimeConformanceCases, type RuntimeConformanceCaseOptions } from "./index.ts";

export function describeRuntimeConformance(
  runtimeName: string,
  options: RuntimeConformanceCaseOptions,
): void {
  describe(`${runtimeName} Runtime conformance`, () => {
    for (const testCase of createRuntimeConformanceCases(options)) {
      it(testCase.name, testCase.run);
    }
  });
}
