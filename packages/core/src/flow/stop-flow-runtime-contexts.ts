import { RuntimeContextRecordSchema } from "@pragma/shared";

import { readAgentDelegationDefinition } from "../agent/agent-launcher.ts";
import type { Expert } from "../agent/expert-agent.ts";
import { isExpertTeam, type ExpertDefinition } from "../agent/expert-team.ts";
import type { ExecutionStore } from "../execution/execution-store.ts";
import type { PragmaLoggerProvider } from "../logging/logger.ts";
import type { RuntimeResolver } from "../runtime-resolver.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import type { Flow } from "./flow.ts";

export class FlowInterruptionUnconfirmedError extends Error {
  readonly code = "FLOW_NATIVE_STOP_UNCONFIRMED";

  constructor(
    readonly executionId: string,
    cause: unknown,
  ) {
    super("Flow interruption was not confirmed; its execution remains recoverable.", { cause });
    this.name = "FlowInterruptionUnconfirmedError";
  }
}

/** Restore only owned native Sessions. No Flow step or Runtime turn is dispatched. */
export async function stopFlowRuntimeContexts(options: {
  readonly flow: Flow;
  readonly executionId: string;
  readonly executions: ExecutionStore;
  readonly runtimes: RuntimeResolver;
  readonly pragmaHome: string;
  readonly loggerProvider?: PragmaLoggerProvider | undefined;
  readonly assertOwnership: () => Promise<void>;
}): Promise<void> {
  const experts = flowExperts(options.flow);
  const invocations = await options.executions.listInvocations(options.executionId);
  const contexts = (await options.executions.listContexts(options.executionId)).map((value) =>
    RuntimeContextRecordSchema.parse(value),
  );
  const owned = contexts.flatMap((context) => {
    if (context.owner.type !== "flow-execution" || context.owner.ownerId !== options.executionId)
      throw new Error(`Flow Runtime Context ownership mismatch: ${context.contextId}.`);
    if (context.snapshot === undefined)
      throw new Error(
        `Flow Runtime Context has no recoverable Native snapshot: ${context.contextId}.`,
      );
    const origin = context.origin;
    if (
      origin.type !== "invocation" ||
      !invocations.some(
        (invocation) =>
          invocation.invocationId === origin.invocationId &&
          invocation.contextId === context.contextId,
      )
    )
      throw new Error(`Flow Runtime Context origin is unavailable: ${context.contextId}.`);
    const expert = experts.get(context.expert.id);
    if (expert === undefined)
      throw new Error(`Flow Runtime Context Expert is unavailable: ${context.expert.id}.`);
    return [{ context, expert, invocationId: origin.invocationId }];
  });
  for (const { context, expert, invocationId } of owned) {
    await options.assertOwnership();
    const resolved = await options.runtimes.resolve({
      binding: context.runtime,
      modelSelection: context.modelSelection,
    });
    if (
      resolved.binding.runtimeId !== context.runtime.runtimeId ||
      resolved.binding.revision !== context.runtime.revision ||
      resolved.binding.fingerprint !== context.runtime.fingerprint
    )
      throw new Error(`Flow Runtime Context binding changed: ${context.contextId}.`);
    await options.assertOwnership();
    const native = await openRuntimeSession(resolved.adapter, {
      agent: expert,
      owner: { type: "flow-execution", ownerId: options.executionId, invocationId },
      pragmaHome: options.pragmaHome,
      systemSessionId: context.snapshot!.systemSessionId,
      runtimeSession: context.snapshot!.runtimeSession,
      modelSelection: context.modelSelection,
      loggerProvider: options.loggerProvider,
    });
    try {
      const info = native.info();
      if (
        info.systemSessionId !== context.snapshot!.systemSessionId ||
        info.runtimeSession.type !== context.snapshot!.runtimeSession.type ||
        info.runtimeSession.id !== context.snapshot!.runtimeSession.id
      )
        throw new Error(`Restored Flow Native Session identity changed: ${context.contextId}.`);
      await options.assertOwnership();
      if (native.stopForDeletion !== undefined) await native.stopForDeletion();
      else await native.close();
      await options.assertOwnership();
    } finally {
      // Also clean up a restore that returned after the stop budget or lease
      // expired. Closing cannot dispatch a turn and never authorizes cancellation.
      await native.close();
    }
  }
}

function flowExperts(flow: Flow): ReadonlyMap<string, Expert> {
  const experts = new Map<string, Expert>();
  const visitedFlows = new Set<Flow>();
  const visitExpert = (definition: ExpertDefinition): void => {
    if (isExpertTeam(definition)) {
      visitExpert(definition.coordinator);
      for (const member of definition.members) visitExpert(member);
      return;
    }
    if (experts.has(definition.id)) return;
    experts.set(definition.id, definition);
    for (const tool of definition.tools ?? [])
      for (const delegated of readAgentDelegationDefinition(tool)?.experts ?? [])
        visitExpert(delegated);
  };
  const visitFlow = (definition: Flow): void => {
    if (visitedFlows.has(definition)) return;
    visitedFlows.add(definition);
    for (const step of definition.steps.values()) {
      const child = step.definition;
      if ("kind" in child) {
        if (child.kind === "flow") visitFlow(child);
        else if (child.kind === "expert-team") visitExpert(child);
      } else visitExpert(child);
    }
  };
  visitFlow(flow);
  return experts;
}
