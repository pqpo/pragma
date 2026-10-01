import { parentPort, workerData } from "node:worker_threads";
import { PragmaPaths } from "./pragma-paths.ts";
import { inspectStorage } from "./storage-maintenance.ts";

const data = workerData as { pragmaHome: string };
const overview = await inspectStorage(new PragmaPaths(data), undefined, { entryDelayMs: 2 });
parentPort?.postMessage(overview);
