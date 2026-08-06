import { ipcMain } from "electron";

import {
  ExpertMemoryContextStoreContentSchema,
  ExpertMemoryContextStoreDescriptorSchema,
  ExpertMemoryContextStoreEntrySchema,
  ExpertMemoryContextStoreSearchMatchSchema,
  GetExpertMemoryContextStoreSchema,
  ListExpertMemoryContextStoreEntriesSchema,
  ReadExpertMemoryContextStoreEntrySchema,
  SearchExpertMemoryContextStoreSchema,
} from "../../../shared/contracts/index.ts";
import type { ExpertMemoryContextStoreBrowserService } from "./expert-memory-context-store-browser.ts";

export function installExpertMemoryContextStoreBrowserHandlers(
  service: ExpertMemoryContextStoreBrowserService,
): void {
  ipcMain.handle("expert-memory-context-stores:get", async (_event, input: unknown) =>
    ExpertMemoryContextStoreDescriptorSchema.parse(
      await service.get(GetExpertMemoryContextStoreSchema.parse(input)),
    ),
  );
  ipcMain.handle("expert-memory-context-stores:list", async (_event, input: unknown) =>
    ExpertMemoryContextStoreEntrySchema.array().parse(
      await service.list(ListExpertMemoryContextStoreEntriesSchema.parse(input)),
    ),
  );
  ipcMain.handle("expert-memory-context-stores:read", async (_event, input: unknown) =>
    ExpertMemoryContextStoreContentSchema.parse(
      await service.read(ReadExpertMemoryContextStoreEntrySchema.parse(input)),
    ),
  );
  ipcMain.handle("expert-memory-context-stores:search", async (_event, input: unknown) =>
    ExpertMemoryContextStoreSearchMatchSchema.array().parse(
      await service.search(SearchExpertMemoryContextStoreSchema.parse(input)),
    ),
  );
}
