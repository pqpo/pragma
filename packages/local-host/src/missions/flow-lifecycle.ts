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
  return request.kind === "start"
    ? await app.flows.start(definition, request.options)
    : await app.flows.recover(definition, request.options);
}

/** Cold cancellation uses stop compilation and never starts or recovers the graph. */
export async function stopLocalHostFlowExecution(
  app: PragmaApp,
  definition: Parameters<FlowApplication["stop"]>[0],
  options: Parameters<FlowApplication["stop"]>[1],
): Promise<void> {
  await app.flows.stop(definition, options);
}
