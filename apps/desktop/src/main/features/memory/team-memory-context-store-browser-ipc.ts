import { ipcMain } from "electron";

import {
  GetTeamMemoryContextStoreSchema,
  ListTeamMemoryContextStoreEntriesSchema,
  ReadTeamMemoryContextStoreEntrySchema,
  SearchTeamMemoryContextStoreSchema,
  TeamMemoryContextStoreContentSchema,
  TeamMemoryContextStoreDescriptorSchema,
  TeamMemoryContextStoreEntrySchema,
  TeamMemoryContextStoreSearchMatchSchema,
} from "../../../shared/contracts/index.ts";
import type { TeamMemoryContextStoreBrowserService } from "./team-memory-context-store-browser.ts";

export function installTeamMemoryContextStoreBrowserHandlers(
  service: TeamMemoryContextStoreBrowserService,
): void {
  ipcMain.handle("team-memory-context-stores:get", async (_event, input: unknown) =>
    TeamMemoryContextStoreDescriptorSchema.parse(
      await service.get(GetTeamMemoryContextStoreSchema.parse(input)),
    ),
  );
  ipcMain.handle("team-memory-context-stores:list", async (_event, input: unknown) =>
    TeamMemoryContextStoreEntrySchema.array().parse(
      await service.list(ListTeamMemoryContextStoreEntriesSchema.parse(input)),
    ),
  );
  ipcMain.handle("team-memory-context-stores:read", async (_event, input: unknown) =>
    TeamMemoryContextStoreContentSchema.parse(
      await service.read(ReadTeamMemoryContextStoreEntrySchema.parse(input)),
    ),
  );
  ipcMain.handle("team-memory-context-stores:search", async (_event, input: unknown) =>
    TeamMemoryContextStoreSearchMatchSchema.array().parse(
      await service.search(SearchTeamMemoryContextStoreSchema.parse(input)),
    ),
  );
}
