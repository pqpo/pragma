import type { ExecutionStore, ExpertSessionStore } from "@pragma/core";
import { RuntimeContextRecordSchema } from "@pragma/shared";
import { createIntegrationError } from "@pragma/shared/integration";
import type { MissionControllerStore } from "./controller/mission-controller-store.ts";

/** Resolve only the named Mission's durable references; never scan Session storage. */
export function createMissionSessionAssociationResolver(options: {
  readonly controller: Pick<MissionControllerStore, "readSnapshot">;
  readonly executions: Pick<ExecutionStore, "get" | "getInvocation" | "getContext">;
  readonly sessions: Pick<ExpertSessionStore, "get">;
  readonly repositorySessionId?: ((missionId: string) => Promise<string | undefined>) | undefined;
}) {
  return async (missionId: string): Promise<string | undefined> => {
    const pinned = await options.repositorySessionId?.(missionId);
    if (pinned !== undefined) return pinned;
    const { snapshot, events } = await options.controller.readSnapshot({ missionId });
    const operations = Object.values(snapshot.operations);
    let executionId: string | undefined;
    // Accepted sends own the latest Session association. Recovery projection
    // may append an older run.started afterwards, so event arrival order alone
    // cannot select the current owner.
    for (const event of events.toReversed()) {
      if (event.type !== "command.applied") continue;
      const operation = operations.find(
        (candidate) => candidate.commandId === event.data["commandId"],
      );
      if (operation?.kind !== "send" || typeof operation.result?.["executionId"] !== "string")
        continue;
      const associated = operation.result["sessionId"];
      if (typeof associated === "string") {
        if ((await options.sessions.get(associated)) === undefined)
          throw associationError(missionId, operation.result["executionId"]);
        return associated;
      }
      executionId = operation.result["executionId"];
      break;
    }
    if (executionId === undefined) {
      for (const event of events.toReversed()) {
        if (event.type !== "run.started" || typeof event.data["executionId"] !== "string") continue;
        const associated = event.data["sessionId"];
        if (typeof associated === "string") {
          if ((await options.sessions.get(associated)) === undefined)
            throw associationError(missionId, event.data["executionId"]);
          return associated;
        }
        executionId = event.data["executionId"];
        break;
      }
    }
    if (executionId === undefined) return (await options.sessions.get(missionId))?.sessionId;
    const execution = await options.executions.get(executionId);
    if (execution?.kind === "flow") return undefined;
    const root =
      execution === undefined
        ? undefined
        : await options.executions.getInvocation(executionId, execution.rootInvocationId);
    const rawContext =
      root === undefined
        ? undefined
        : await options.executions.getContext(executionId, root.contextId);
    if (rawContext === undefined) {
      // A queued turn can precede the first Runtime Context. Its original
      // Session remains named by the legacy Mission identity.
      const legacy = await options.sessions.get(missionId);
      if (legacy?.executionIds.includes(executionId)) return legacy.sessionId;
      throw associationError(missionId, executionId);
    }
    const context = RuntimeContextRecordSchema.parse(rawContext);
    if (context.origin.type !== "expert-session") throw associationError(missionId, executionId);
    return context.origin.sessionId;
  };
}

function associationError(missionId: string, executionId: string) {
  return createIntegrationError({
    code: "COMMAND_REJECTED",
    category: "conflict",
    message: "The Mission execution has no valid ExpertSession association.",
    details: { missionId, executionId, reason: "session_association_invalid" },
  });
}
