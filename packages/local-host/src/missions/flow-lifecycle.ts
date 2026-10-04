import type { FlowExecution, PragmaApp } from "@pragma/core";

type FlowApplication = PragmaApp["flows"];
type FlowDefinition = Parameters<FlowApplication["start"]>[0];
export type LocalHostFlowOpenRequest =
  | { readonly kind: "start"; readonly options: Parameters<FlowApplication["start"]>[1] }
  | { readonly kind: "recover"; readonly options: Parameters<FlowApplication["recover"]>[1] };

/** Core continues to own graph and Runtime recovery; Host surfaces share its entry boundary. */
export async function openLocalHostFlowExecution(
  app: PragmaApp,
  definition: FlowDefinition,
  request: LocalHostFlowOpenRequest,
): Promise<FlowExecution> {
  const execution =
    request.kind === "start"
      ? await app.flows.start(definition, request.options)
      : await app.flows.recover(definition, request.options);
  // Recovery can fail while the Host is still registering Memory or persisting
  // its owner projection. Observe rejection before those asynchronous steps,
  // retaining the original result Promise and its error for later consumers.
  void execution.result.catch(() => undefined);
  return execution;
}

/** Cold cancellation uses stop compilation and never starts or recovers the graph. */
export async function stopLocalHostFlowExecution(
  app: PragmaApp,
  definition: Parameters<FlowApplication["stop"]>[0],
  options: Parameters<FlowApplication["stop"]>[1],
): Promise<void> {
  await app.flows.stop(definition, options);
}

/** Wait for native Runtime teardown without deleting durable Execution facts. */
export async function releaseLocalHostFlowExecution(
  execution: Pick<FlowExecution, "cancel" | "getState"> &
    Partial<Pick<FlowExecution, "stopForDeletion" | "releaseRuntimeResources">>,
): Promise<void> {
  if (execution.releaseRuntimeResources !== undefined) {
    await execution.releaseRuntimeResources();
    return;
  }
  const state = await execution.getState();
  if (state.status === "waiting")
    throw new Error("A waiting Flow requires a native checkpoint release boundary.");
  if (execution.stopForDeletion !== undefined)
    await execution.stopForDeletion("Mission transient Flow resources released.");
  else
    // Cold terminal control facades bind cancel to Core's targeted flows.stop,
    // which confirms native teardown while preserving the terminal Execution.
    await execution.cancel("Mission transient Flow resources released.");
}
