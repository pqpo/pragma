import {
  RuntimeUsageObservedSchema,
  type CanonicalEventFeed,
  type PragmaLogger,
  type RuntimeUsageObservation,
} from "@pragma/core";
import {
  createMissionDeliveryReceiptStore,
  type MissionReceiptDiagnostic,
  type MissionReceiptRow,
} from "@pragma/local-host";
import { z } from "zod";
import { MissionSchema, type Mission } from "../../../shared/contracts/index.ts";

const LinkSchema = z.object({ mission: MissionSchema, requestId: z.string().min(1) });
const TaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("usage"), observation: RuntimeUsageObservedSchema.shape.observation }),
  z.object({ kind: z.literal("terminal"), status: z.enum(["succeeded", "failed", "cancelled"]) }),
]);
export type MissionDeliveryStep = "terminal" | "metadata" | "memory" | "history" | "archive";
const STEPS: readonly MissionDeliveryStep[] = [
  "terminal",
  "metadata",
  "memory",
  "history",
  "archive",
];

/** Execution facts enter this queue only through the atomic canonical handoff. */
export async function createMissionDelivery(input: {
  path: string;
  feed: CanonicalEventFeed;
  logger: PragmaLogger;
  usage: (mission: Mission, observation: RuntimeUsageObservation) => Promise<void>;
  onDegraded?: (missionId: string) => void;
  onRecovered?: (missionId: string) => void;
  beforeDelete?: (mission: Mission, executionIds: readonly string[]) => Promise<void>;
  terminal: (
    mission: Mission,
    executionId: string,
    requestId: string,
    status: "succeeded" | "failed" | "cancelled",
    step: MissionDeliveryStep,
  ) => Promise<void>;
}) {
  const receipts = await createMissionDeliveryReceiptStore({
    path: input.path,
    onNotice: (notice) => {
      input.logger.warn(notice.event, notice.message, notice.data);
      if (typeof notice.data.missionId === "string") input.onDegraded?.(notice.data.missionId);
    },
  });
  let diagnostic: MissionReceiptDiagnostic = await receipts.inspect();
  let stopped = true;
  let closed = false;
  let closing: Promise<void> | undefined;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = new Map<string, Promise<void>>();
  const activeOwners = new Map<string, string>();
  let lastError: string | undefined;
  let retryMs = 1000;
  let intakeRetryMs = 1000;
  let nextIntakeAt = 0;
  let dirty = false;
  let unsubscribe: (() => void) | undefined;
  const ingest = async () => {
    const page = await input.feed.read({ after: { sequence: receipts.safeThrough() }, limit: 64 });
    if (page.items.length > 0) await receipts.stagePage(page);
    if (page.items.length === 64) dirty = true;
  };
  const deliver = async (row: MissionReceiptRow, claim: string) => {
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal !== undefined) return;
      renewal = receipts
        .renew(row.id, claim)
        .catch((error) => {
          input.logger.warn("mission.delivery_degraded", "Delivery lease renewal failed", {
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_RENEW_FAILED",
            error,
          });
        })
        .finally(() => {
          renewal = undefined;
        });
    }, 10_000);
    heartbeat.unref();
    try {
      const link = await receipts.link(row.execution_id);
      if (link === undefined || (await receipts.isDeleted(row.mission_id))) return;
      const { mission, requestId } = LinkSchema.parse(JSON.parse(link.payload));
      const task = TaskSchema.parse(JSON.parse(row.payload));
      if (task.kind === "usage") await input.usage(mission, task.observation);
      else {
        if (await receipts.isDeleted(row.mission_id)) return;
        const owned = await receipts.owned(row.id, claim);
        if (!owned) return;
        await input.terminal(mission, row.execution_id, requestId, task.status, STEPS[row.step]!);
      }
      const recovered = await receipts.acknowledge(row.id, claim, row.mission_id);
      if (row.attempts > 0 && recovered) input.onRecovered?.(row.mission_id);
    } catch (error) {
      const invalid = error instanceof z.ZodError;
      const code = invalid ? "MISSION_DELIVERY_INVALID_TASK" : "MISSION_DELIVERY_RETRY_PENDING";
      input.onDegraded?.(row.mission_id);
      await receipts.fail(row.id, claim, invalid, row.attempts);
      input.logger.warn("mission.delivery_degraded", "Mission background delivery needs recovery", {
        missionId: row.mission_id,
        executionId: row.execution_id,
        moduleId: "pragma.mission-delivery",
        errorCode: code,
        error,
      });
    } finally {
      clearInterval(heartbeat);
    }
  };
  const dispatchPending = async () => {
    while (active.size < 2 && !stopped) {
      const claimed = await receipts.claim();
      if (claimed === undefined) break;
      const operation = deliver(claimed.row, claimed.claim);
      active.set(claimed.row.id, operation);
      activeOwners.set(claimed.row.id, claimed.row.mission_id);
      void operation
        .catch((error: unknown) => {
          input.logger.warn("mission.delivery_degraded", "Mission delivery claim needs recovery", {
            moduleId: "pragma.mission-delivery",
            errorCode: "MISSION_DELIVERY_CLAIM_FAILED",
            error,
          });
        })
        .finally(() => {
          active.delete(claimed.row.id);
          activeOwners.delete(claimed.row.id);
          wake();
        });
    }
  };
  const tick = async () => {
    // Receipt custody is independent of source availability. Start recovered
    // tasks before intake and also dispatch facts received in this tick.
    await dispatchPending();
    lastError = nextIntakeAt === 0 ? undefined : "MISSION_DELIVERY_RECEIVE_FAILED";
    if (Date.now() >= nextIntakeAt) {
      try {
        await ingest();
        nextIntakeAt = 0;
        intakeRetryMs = 1000;
        lastError = undefined;
      } catch (error) {
        lastError = "MISSION_DELIVERY_RECEIVE_FAILED";
        nextIntakeAt = Date.now() + intakeRetryMs;
        intakeRetryMs = Math.min(30_000, intakeRetryMs * 2);
        input.logger.warn("mission.delivery_degraded", "Mission delivery intake needs recovery", {
          moduleId: "pragma.mission-delivery",
          errorCode: lastError,
          error,
        });
      }
    }
    await dispatchPending();
    diagnostic = await receipts.inspect();
  };
  const wake = () => {
    if (stopped) return;
    if (running !== undefined) {
      dirty = true;
      return;
    }
    dirty = false;
    if (timer !== undefined) clearTimeout(timer);
    running = tick()
      .catch((error: unknown) => {
        lastError = "MISSION_DELIVERY_CLAIM_FAILED";
        input.logger.warn("mission.delivery_degraded", "Mission delivery claim needs recovery", {
          moduleId: "pragma.mission-delivery",
          errorCode: lastError,
          error,
        });
      })
      .finally(() => {
        running = undefined;
        if (!stopped) {
          const due =
            diagnostic.nextWakeAt === undefined
              ? 30_000
              : Math.max(10, diagnostic.nextWakeAt - Date.now());
          timer = setTimeout(
            wake,
            lastError !== undefined && lastError !== "MISSION_DELIVERY_RECEIVE_FAILED"
              ? retryMs
              : dirty
                ? 0
                : Math.min(
                    30_000,
                    due,
                    nextIntakeAt === 0 ? 30_000 : Math.max(10, nextIntakeAt - Date.now()),
                  ),
          );
          retryMs =
            lastError === undefined || lastError === "MISSION_DELIVERY_RECEIVE_FAILED"
              ? 1000
              : Math.min(30_000, retryMs * 2);
          timer.unref();
        }
      });
  };
  return {
    async register(mission: Mission, executionId: string, requestId: string) {
      if (closing !== undefined) throw new Error("MISSION_DELIVERY_CLOSING");
      await receipts.registerLink(
        executionId,
        mission.id,
        JSON.stringify(LinkSchema.parse({ mission, requestId })),
      );
      wake();
    },
    async retry(missionId: string) {
      await receipts.retry(missionId);
      wake();
    },
    safeThrough: receipts.safeThrough,
    wake,
    start() {
      stopped = false;
      unsubscribe ??= input.feed.subscribeChanges?.(wake);
      wake();
    },
    inspect() {
      if (closed) throw new Error("Mission delivery is closed.");
      return {
        ...diagnostic,
        state: lastError === undefined ? diagnostic.state : ("degraded" as const),
        errorCode: lastError ?? diagnostic.errorCode,
      };
    },
    async deleteMission(
      missionId: string,
      owner?: { readonly mission: Mission; readonly executionIds: readonly string[] },
    ) {
      const links = await receipts.links(missionId);
      const executionIds = [
        ...new Set([...links.map((link) => link.execution_id), ...(owner?.executionIds ?? [])]),
      ];
      const mission =
        owner?.mission ??
        (links.length === 0 ? undefined : LinkSchema.parse(JSON.parse(links[0]!.payload)).mission);
      if (mission !== undefined) await input.beforeDelete?.(mission, executionIds);
      await receipts.markDeleted(missionId, executionIds);
      await running;
      await Promise.all(
        [...active]
          .filter(([id]) => activeOwners.get(id) === missionId)
          .map(([, operation]) => operation),
      );
      await receipts.finishDelete(missionId);
      diagnostic = await receipts.inspect();
    },
    async close() {
      if (closing !== undefined) return await closing;
      stopped = true;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer !== undefined) clearTimeout(timer);
      const settling = (async () => {
        await running;
        await Promise.all(active.values());
        if (!closed) {
          closed = true;
          await receipts.close();
        }
      })();
      closing = new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          input.logger.warn(
            "mission.delivery_shutdown_pending",
            "Mission delivery remains durable for restart",
            {
              moduleId: "pragma.mission-delivery",
              errorCode: "MISSION_DELIVERY_SHUTDOWN_PENDING",
              pending: active.size,
            },
          );
          resolve();
        }, 5000);
        settling.then(
          () => {
            clearTimeout(deadline);
            resolve();
          },
          (error: unknown) => {
            clearTimeout(deadline);
            reject(error);
          },
        );
      });
      await closing;
    },
  };
}
