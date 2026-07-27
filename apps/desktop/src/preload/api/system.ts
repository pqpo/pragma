import { ipcRenderer } from "electron";

import { DesktopRendererLogSchema } from "../../shared/contracts/logging.ts";
import { DesktopBridgeSnapshotSchema } from "../../shared/contracts/runtime.ts";
import type { PragmaDesktopAPI } from "../../shared/contracts/api.ts";
export const systemApi = {
  reportRendererLog: (input) => {
    const record = DesktopRendererLogSchema.safeParse(input);
    if (record.success) ipcRenderer.send("logs:renderer", record.data);
  },
  getBridgeSnapshot: async () =>
    DesktopBridgeSnapshotSchema.parse(await ipcRenderer.invoke("bridge:snapshot")),
} satisfies Pick<PragmaDesktopAPI, "reportRendererLog" | "getBridgeSnapshot">;
