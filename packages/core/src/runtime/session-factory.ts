import type {
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeDriverSessionRequest,
} from "./runtime-adapter.ts";

type RuntimeSessionFactory = (request: RuntimeDriverSessionRequest) => Promise<RuntimeAgentSession>;

const runtimeSessionFactories = new WeakMap<RuntimeAdapter, RuntimeSessionFactory>();

export function registerRuntimeSessionFactory(
  runtime: RuntimeAdapter,
  factory: RuntimeSessionFactory,
): void {
  runtimeSessionFactories.set(runtime, factory);
}

export async function openRuntimeSession(
  runtime: RuntimeAdapter,
  request: RuntimeDriverSessionRequest,
): Promise<RuntimeAgentSession> {
  const factory = runtimeSessionFactories.get(runtime);
  if (factory === undefined) {
    throw new Error(
      `Runtime adapter ${runtime.descriptor.id} has no Session factory. Create it with defineRuntimeDriver().`,
    );
  }
  validateOwner(request);
  return await factory(request);
}

function validateOwner(request: RuntimeDriverSessionRequest): void {
  if (request.owner.ownerId.trim() === "") {
    throw new Error("Runtime Session ownerId must not be empty.");
  }
  if (request.owner.type === "expert-session" && request.owner.contextId === undefined) {
    throw new Error("Expert Session Runtime ownership requires contextId.");
  }
  if (request.owner.type === "flow-execution" && request.owner.invocationId === undefined) {
    throw new Error("Flow Execution Runtime ownership requires invocationId.");
  }
}
