import type { ExpertMeshDesktopAPI } from "../shared/desktop-api.ts";

declare global {
  interface Window {
    expertMeshDesktop: ExpertMeshDesktopAPI;
  }
}

export {};
