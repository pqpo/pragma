import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  Capability,
  ContextStore,
  DesktopRuntimeAvailability,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { PragmaBundleDialog } from "../studio/PragmaBundleDialog.tsx";
import { SquareDirectoryFragment } from "../studio/SquareDirectoryFragment.tsx";
import { desktopApi } from "../studio/studio-model.ts";

type MarketBundleData = {
  readonly project: PragmaProjectSnapshot;
  readonly capabilities: readonly Capability[];
  readonly contextStores: readonly ContextStore[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
};

type BundleRequest = {
  readonly mode: "import" | "export";
  readonly sourcePath?: string;
  readonly rootRef?: string;
};

async function loadBundleData(): Promise<MarketBundleData | null> {
  const api = desktopApi();
  if (api === undefined) return null;
  const [project, capabilities, contextStores, runtimes] = await Promise.all([
    api.getPragmaProject(),
    api.listCapabilities(),
    api.listContextStores(),
    api.getRuntimeAvailability(),
  ]);
  return {
    project,
    capabilities: capabilities.filter((item) => item.managedBy !== "system"),
    contextStores,
    runtimes,
  };
}

export function MarketPage(props: { readonly onOpenCapability: (capabilityId: string) => void }) {
  const { t } = useTranslation("common");
  const [data, setData] = useState<MarketBundleData | null>(null);
  const [request, setRequest] = useState<BundleRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshBundleData = useCallback(async () => {
    const next = await loadBundleData();
    setData(next);
    setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadBundleData()
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="market-page">
      {error !== null ? (
        <div className="market-page-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              void refreshBundleData().catch((cause: unknown) => setError(errorMessage(cause)));
            }}
          >
            {t("actions.retry")}
          </button>
        </div>
      ) : null}
      <SquareDirectoryFragment
        canExport={data !== null}
        onExport={() => setRequest({ mode: "export" })}
        onImport={() => setRequest({ mode: "import" })}
        onInstall={(sourcePath, rootRef) => setRequest({ mode: "import", sourcePath, rootRef })}
      />
      {request !== null && data !== null ? (
        <PragmaBundleDialog
          mode={request.mode}
          project={data.project}
          capabilities={data.capabilities}
          contextStores={data.contextStores}
          runtimes={data.runtimes}
          initialSourcePath={request.sourcePath}
          initialRootRef={request.rootRef}
          onRefreshRuntimes={async () => {
            const runtimes = (await desktopApi()?.getRuntimeAvailability()) ?? [];
            setData((current) => (current === null ? null : { ...current, runtimes }));
            return runtimes;
          }}
          onChanged={refreshBundleData}
          onClose={() => setRequest(null)}
          onOpenCapability={props.onOpenCapability}
        />
      ) : null}
    </section>
  );
}
