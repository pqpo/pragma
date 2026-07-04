import { contextBridge, ipcRenderer } from "electron";

import type {
  DesktopBridgeSnapshot,
  PragmaDesktopAPI,
  PickWorkspaceResult,
  ValidateWorkspaceResult,
} from "../shared/desktop-api.ts";

const api: PragmaDesktopAPI = {
  getBridgeSnapshot: () => ipcRenderer.invoke("bridge:snapshot") as Promise<DesktopBridgeSnapshot>,
  pickWorkspace: () => ipcRenderer.invoke("workspace:pick") as Promise<PickWorkspaceResult>,
  validateWorkspace: (path: string) =>
    ipcRenderer.invoke("workspace:validate", path) as Promise<ValidateWorkspaceResult>,
};

contextBridge.exposeInMainWorld("pragmaDesktop", api);
