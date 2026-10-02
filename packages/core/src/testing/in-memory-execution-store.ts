import { executionTransactionRules as rules } from "../execution/execution-transaction-rules.ts";
import { randomUUID } from "node:crypto";
import {
  ExecutionRecordSchema,
  InvocationSchema,
  type ExecutionRecord,
  type Invocation,
  type AgentInstance,
  type RuntimeContextRecord,
  type ExecutionEvent,
} from "@pragma/shared";
import {
  ExecutionVersionConflictError,
  type ExecutionStore,
  type ExecutionCommitResult,
} from "../execution/execution-store.ts";
import { getExecutionLiveBus } from "../execution/execution-live-bus.ts";

/** Test execution authority; no disk, migration, worker or implicit production default. */
export function createInMemoryExecutionStore(): ExecutionStore {
  type Aggregate = {
    execution: ExecutionRecord;
    invocations: Invocation[];
    agents: AgentInstance[];
    contexts: RuntimeContextRecord[];
    events: ExecutionEvent[];
    receipts: Map<string, { signature: string; result: ExecutionCommitResult }>;
  };
  const owners = new Map<string, Aggregate>();
  const requireOwner = (id: string) => {
    const value = owners.get(id);
    if (value === undefined) throw new Error(`Execution not found: ${id}`);
    return value;
  };
  const copy = <T>(value: T): T => structuredClone(value);
  const store: ExecutionStore = {
    async create(record, root) {
      if (owners.has(record.executionId))
        throw new Error(`Execution already exists: ${record.executionId}`);
      const execution = ExecutionRecordSchema.parse(record);
      const invocation = InvocationSchema.parse(root);
      rules.assertExpertTurnRootPrompt(execution, [invocation]);
      owners.set(record.executionId, {
        execution,
        invocations: [invocation],
        agents: [],
        contexts: [],
        events: [],
        receipts: new Map(),
      });
    },
    get: async (id) => copy(owners.get(id)?.execution),
    async commit(request) {
      const current = requireOwner(request.executionId);
      const signature = rules.commitSignature(request);
      const receipt = current.receipts.get(request.commitId);
      if (receipt !== undefined) {
        if (receipt.signature !== signature)
          throw new Error(`Execution commit idempotency conflict: ${request.commitId}`);
        return copy(receipt.result);
      }
      if (
        request.expectedVersion !== undefined &&
        request.expectedVersion !== current.execution.version
      )
        throw new ExecutionVersionConflictError(request.expectedVersion, current.execution.version);
      const now = new Date().toISOString();
      rules.assertFinalStatusTransitions(
        current.execution,
        current.invocations,
        request,
        rules.hasActiveRecoveryClaim(current.execution, request.recoveryClaimId),
      );
      const invocations = rules.applyInvocationChanges(
        current.invocations,
        request.invocationPuts ?? [],
        request.invocationPatches ?? [],
        now,
      );
      const agents = rules.applyAgentChanges(
        current.agents,
        request.agentPuts ?? [],
        request.agentPatches ?? [],
        now,
      );
      const contexts = rules.applyContextChanges(
        current.contexts,
        request.contextPuts ?? [],
        request.contextPatches ?? [],
        now,
      );
      rules.assertAgentContextBindings(agents, contexts, invocations);
      const materialized = rules.materializeEvents(
        request.executionId,
        current.events,
        request.events ?? [],
        now,
      );
      const execution = ExecutionRecordSchema.parse({
        ...current.execution,
        ...request.executionPatch,
        executionId: request.executionId,
        version: current.execution.version + 1,
        updatedAt: now,
        lastAppliedSequence:
          materialized.newEvents.at(-1)?.cursor.sequence ?? current.execution.lastAppliedSequence,
      });
      rules.assertExpertTurnRootPrompt(execution, invocations);
      const result = {
        execution,
        invocations,
        agents,
        contexts,
        events: materialized.requestedEvents,
      };
      owners.set(request.executionId, {
        execution,
        invocations,
        agents,
        contexts,
        events: [...current.events, ...materialized.newEvents],
        receipts: current.receipts,
      });
      current.receipts.set(request.commitId, { signature, result: copy(result) });
      for (const event of materialized.newEvents)
        getExecutionLiveBus(store).publishEvent(request.executionId, event);
      return copy(result);
    },
    getInvocation: async (id, key) =>
      copy(owners.get(id)?.invocations.find((item) => item.invocationId === key)),
    listInvocations: async (id) => copy(owners.get(id)?.invocations ?? []),
    getAgent: async (id, key) => copy(owners.get(id)?.agents.find((item) => item.agentId === key)),
    listAgents: async (id) => copy(owners.get(id)?.agents ?? []),
    getContext: async (id, key) =>
      copy(owners.get(id)?.contexts.find((item) => item.contextId === key)),
    listContexts: async (id) => copy(owners.get(id)?.contexts ?? []),
    getTree: async (id) => {
      const value = owners.get(id);
      return value === undefined
        ? undefined
        : copy(rules.buildTree(value.execution.rootInvocationId, value.invocations));
    },
    readEvents: async (id, after, limit) =>
      copy(rules.filterAfter(owners.get(id)?.events ?? [], id, after).slice(0, limit)),
    async claimRecovery(id, claimId, leaseMs) {
      const current = requireOwner(id).execution;
      const claim = current.state["__recoveryClaim"] as
        { claimId: string; expiresAt: string } | undefined;
      if (
        claim !== undefined &&
        claim.claimId !== claimId &&
        Date.parse(claim.expiresAt) > Date.now()
      )
        return false;
      await store.commit({
        executionId: id,
        commitId: randomUUID(),
        expectedVersion: current.version,
        executionPatch: {
          state: {
            ...current.state,
            __recoveryClaim: {
              claimId,
              processId: process.pid,
              expiresAt: new Date(Date.now() + leaseMs).toISOString(),
            },
          },
        },
      });
      return true;
    },
    async releaseWaitingHumanRecovery(id, claimId) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const current = await this.get(id);
        if (current === undefined) throw new Error(`Execution not found: ${id}`);
        const claim = current.state["__recoveryClaim"] as
          { claimId: string; expiresAt: string } | undefined;
        if (
          current.status !== "waiting" ||
          claim?.claimId !== claimId ||
          Date.parse(claim.expiresAt) <= Date.now() ||
          !(await this.listInvocations(id)).some(
            (invocation) =>
              invocation.status === "waiting" && invocation.waitReason === "human_input",
          )
        )
          throw new Error("Execution has no owned human recovery claim.");
        const state = { ...current.state };
        delete state["__recoveryClaim"];
        try {
          await this.commit({
            executionId: id,
            commitId: `release-waiting-human-recovery:${claimId}`,
            expectedVersion: current.version,
            executionPatch: { state },
          });
          return;
        } catch (error) {
          if (!(error instanceof ExecutionVersionConflictError) || attempt === 7) throw error;
        }
      }
    },
    async delete(id) {
      owners.delete(id);
    },
    async archive(id) {
      requireOwner(id);
    },
  };
  return store;
}
