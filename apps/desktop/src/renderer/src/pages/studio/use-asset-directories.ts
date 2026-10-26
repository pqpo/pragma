import { useMemo, useSyncExternalStore } from "react";
import type { ContextStoreEntry } from "../../../../shared/contracts/index.ts";
import { AssetDirectoryLoader } from "./asset-directory-loader.ts";

export function useAssetDirectories(
  resourceKey: string,
  read: (directory: string) => Promise<readonly ContextStoreEntry[]>,
) {
  const loader = useMemo(() => new AssetDirectoryLoader(read), [resourceKey]);
  loader.setReader(read);
  const snapshot = useSyncExternalStore(loader.subscribe, loader.getSnapshot, loader.getSnapshot);
  return { loader, ...snapshot };
}
