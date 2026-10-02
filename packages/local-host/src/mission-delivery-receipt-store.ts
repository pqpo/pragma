import type { CanonicalEventPage } from "@pragma/core";
import { acquireHostStoragePool } from "./host-storage-pool.ts";
import { canonicalReceiptPage } from "./canonical-receipt-page.ts";
import type { MissionReceiptNotice } from "./mission-delivery-receipts.ts";

export interface MissionReceiptRow {
  id: string;
  execution_id: string;
  mission_id: string;
  payload: string;
  step: number;
  attempts: number;
}
export interface MissionReceiptDiagnostic {
  state: "healthy" | "degraded";
  errorCode?: string | undefined;
  pending: number;
  nextWakeAt?: number | undefined;
}
export async function createMissionDeliveryReceiptStore(input: {
  path: string;
  onNotice: (notice: MissionReceiptNotice) => void;
}) {
  const pool = acquireHostStoragePool();
  let closed = false;
  const call = async <T>(
    operation: string,
    args: unknown[] = [],
    background = false,
  ): Promise<T> => {
    if (closed) throw new Error("Mission receipt store is closed.");
    const result = await pool.clients[background ? 1 : 0]!.call<{
      value: T;
      notices: MissionReceiptNotice[];
    }>(`mission-receipt:${operation}`, input.path, args);
    for (const notice of result.notices) {
      try {
        input.onNotice(notice);
      } catch (error) {
        console.warn("MISSION_DELIVERY_NOTIFICATION_FAILED", error);
      }
    }
    return result.value;
  };
  let cursor: number;
  try {
    cursor = await call<number>("open");
  } catch (error) {
    await pool.close();
    throw error;
  }
  return {
    safeThrough: () => cursor,
    registerLink: async (executionId: string, missionId: string, payload: string) => {
      await call("register", [executionId, missionId, payload]);
    },
    stagePage: async function stagePage(page: CanonicalEventPage): Promise<void> {
      try {
        page = canonicalReceiptPage(page, true);
        cursor = Math.max(cursor, await call<number>("stagePage", [page], true));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "HOST_STORAGE_BACKPRESSURE" ||
          page.items.length < 2
        )
          throw error;
        const midpoint = Math.ceil(page.items.length / 2);
        const first = page.items.slice(0, midpoint);
        await stagePage({ items: first, nextCursor: first.at(-1)!.cursor });
        await stagePage({ items: page.items.slice(midpoint), nextCursor: page.nextCursor });
      }
    },
    claim: async () => await call<{ row: MissionReceiptRow; claim: string } | undefined>("claim"),
    link: async (executionId: string) =>
      await call<{ payload: string } | undefined>("link", [executionId]),
    owned: async (id: string, claim: string) => await call<boolean>("owned", [id, claim]),
    isDeleted: async (missionId: string) => await call<boolean>("isDeleted", [missionId]),
    renew: async (id: string, claim: string) => {
      await call("renew", [id, claim]);
    },
    acknowledge: async (id: string, claim: string, missionId: string) =>
      await call<boolean>("acknowledge", [id, claim, missionId]),
    fail: async (id: string, claim: string, invalid: boolean, attempts: number) => {
      await call("fail", [id, claim, invalid, attempts]);
    },
    retry: async (missionId: string) => {
      await call("retry", [missionId]);
    },
    links: async (missionId: string) =>
      await call<{ execution_id: string; payload: string }[]>("links", [missionId]),
    markDeleted: async (missionId: string, executionIds: readonly string[]) => {
      await call("markDeleted", [missionId, executionIds]);
    },
    finishDelete: async (missionId: string) => {
      await call("finishDelete", [missionId]);
    },
    inspect: async () => await call<MissionReceiptDiagnostic>("inspect", [], true),
    async close() {
      if (closed) return;
      closed = true;
      await pool.close();
    },
  };
}
