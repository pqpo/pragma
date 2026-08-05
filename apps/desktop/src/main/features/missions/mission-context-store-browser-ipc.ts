import { ipcMain } from "electron";

import {
  GetMissionContextStoreSchema,
  ListMissionContextStoreEntriesSchema,
  MissionContextStoreContentSchema,
  MissionContextStoreDescriptorSchema,
  MissionContextStoreEntrySchema,
  MissionContextStoreSearchMatchSchema,
  ReadMissionContextStoreEntrySchema,
  SearchMissionContextStoreSchema,
} from "../../../shared/contracts/index.ts";
import type { MissionContextStoreBrowserService } from "./mission-context-store-browser.ts";

export function installMissionContextStoreBrowserHandlers(
  service: MissionContextStoreBrowserService,
): void {
  ipcMain.handle("mission-context-stores:get", async (_event, input: unknown) =>
    MissionContextStoreDescriptorSchema.parse(
      await service.get(GetMissionContextStoreSchema.parse(input)),
    ),
  );
  ipcMain.handle("mission-context-stores:list", async (_event, input: unknown) =>
    MissionContextStoreEntrySchema.array().parse(
      await service.list(ListMissionContextStoreEntriesSchema.parse(input)),
    ),
  );
  ipcMain.handle("mission-context-stores:read", async (_event, input: unknown) =>
    MissionContextStoreContentSchema.parse(
      await service.read(ReadMissionContextStoreEntrySchema.parse(input)),
    ),
  );
  ipcMain.handle("mission-context-stores:search", async (_event, input: unknown) =>
    MissionContextStoreSearchMatchSchema.array().parse(
      await service.search(SearchMissionContextStoreSchema.parse(input)),
    ),
  );
}
