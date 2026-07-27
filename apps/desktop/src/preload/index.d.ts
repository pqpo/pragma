import type { PragmaDesktopAPI } from "../shared/contracts/index.ts";

declare global {
  interface Window {
    pragmaDesktop: PragmaDesktopAPI;
  }
}

export {};
