import type { PragmaDesktopAPI } from "../shared/desktop-api.ts";

declare global {
  interface Window {
    pragmaDesktop: PragmaDesktopAPI;
  }
}

export {};
