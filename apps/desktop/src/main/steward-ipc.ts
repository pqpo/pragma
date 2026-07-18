import { ipcMain } from "electron";
import {
  InitializeStewardSchema,
  PromptStewardSchema,
  RespondStewardInteractionSchema,
  type StewardService,
} from "@pragma/steward";

export function installStewardHandlers(service: StewardService): void {
  ipcMain.handle("steward:state:get", () => service.getState());
  ipcMain.handle("steward:initialize", (_event, input: unknown) =>
    service.initialize(InitializeStewardSchema.parse(input).runtimeId),
  );
  ipcMain.handle("steward:prompt", (_event, input: unknown) =>
    service.prompt(PromptStewardSchema.parse(input)),
  );
  ipcMain.handle("steward:chat:get", () => service.getChat());
  ipcMain.handle("steward:interactions:list", () => service.listInteractions());
  ipcMain.handle("steward:interactions:respond", (_event, input: unknown) =>
    service.respond(RespondStewardInteractionSchema.parse(input)),
  );
  ipcMain.handle("steward:interrupt", () => service.interrupt());
  ipcMain.handle("steward:reset", () => service.reset());
}
