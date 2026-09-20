import { parentPort, workerData } from "node:worker_threads";

import {
  createSynchronousFileCanonicalEventFeed,
  type CanonicalEventMaintenanceInput,
  type CanonicalEventFeed,
} from "./canonical-event-feed.ts";
import type { CanonicalEventCursor, CanonicalEventEnvelope } from "@pragma/shared";

interface WorkerRequest {
  readonly type: "request";
  readonly requestId: number;
  readonly operation: string;
  readonly input?: unknown;
}

const port = parentPort;
if (port === null) throw new Error("Canonical event feed worker requires a parent port.");

let feed: CanonicalEventFeed;
let queue = Promise.resolve();

void createSynchronousFileCanonicalEventFeed(workerOptions(workerData))
  .then((created) => {
    feed = created;
    port.postMessage({ type: "ready" });
    port.on("message", (message: unknown) => {
      if (!isWorkerRequest(message)) return;
      queue = queue.then(async () => {
        try {
          const value = await execute(feed, message);
          port.postMessage({ type: "response", requestId: message.requestId, ok: true, value });
        } catch (error) {
          port.postMessage({
            type: "response",
            requestId: message.requestId,
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    });
  })
  .catch((error: unknown) => {
    port.postMessage({
      type: "fatal",
      message: error instanceof Error ? error.message : String(error),
    });
  });

async function execute(feed: CanonicalEventFeed, request: WorkerRequest): Promise<unknown> {
  switch (request.operation) {
    case "append":
      return await feed.append(request.input as readonly CanonicalEventEnvelope[]);
    case "read":
      return await feed.read(
        request.input as {
          readonly after?: CanonicalEventCursor | undefined;
          readonly limit: number;
        },
      );
    case "inspect":
      return await feed.inspect();
    case "maintain":
      return await feed.maintain(request.input as CanonicalEventMaintenanceInput);
    case "forgetCorrelation":
      return await feed.forgetCorrelation(String(request.input));
    case "close":
      return await feed.close();
    default:
      throw new Error(`Unknown Canonical event feed operation: ${request.operation}`);
  }
}

function isWorkerRequest(value: unknown): value is WorkerRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "request" &&
    "requestId" in value &&
    typeof value.requestId === "number" &&
    "operation" in value &&
    typeof value.operation === "string"
  );
}

function workerOptions(value: unknown): { readonly pragmaHome?: string | undefined } {
  if (
    typeof value === "object" &&
    value !== null &&
    "pragmaHome" in value &&
    typeof value.pragmaHome === "string"
  ) {
    return { pragmaHome: value.pragmaHome };
  }
  return {};
}
