import type {
  RuntimeAdapter,
  RuntimeAdapterDescriptor,
  RuntimeAgentSession,
  RuntimeCanUseResult,
  RuntimeModel,
} from "../src/index.ts";
import {
  registerRuntimeSessionFactory,
  type OwnedRuntimeSessionRequest,
} from "../src/runtime/session-factory.ts";

export function createTestRuntimeAdapter(options: {
  readonly descriptor: RuntimeAdapterDescriptor;
  readonly canUse?: (() => Promise<RuntimeCanUseResult> | RuntimeCanUseResult) | undefined;
  readonly listModels?: (() => Promise<readonly RuntimeModel[]>) | undefined;
  readonly openSession: (request: OwnedRuntimeSessionRequest) => Promise<RuntimeAgentSession>;
}): RuntimeAdapter {
  const runtime: RuntimeAdapter = {
    descriptor: options.descriptor,
    canUse: options.canUse ?? (() => ({ usable: true })),
    ...(options.listModels === undefined ? {} : { listModels: options.listModels }),
  };
  registerRuntimeSessionFactory(runtime, options.openSession);
  return runtime;
}
