import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AssetGitStatus, AssetGitTarget } from "../../../../shared/contracts/index.ts";
import { desktopApi } from "./studio-model.ts";

type SyncState = AssetGitStatus["status"] | "loading" | "unavailable";

export function AssetGitSyncIcon(props: { readonly state: SyncState }) {
  const { t } = useTranslation("studio");
  const paths = {
    synced: ["M7 18h11a4 4 0 0 0 0-8h-1a6 6 0 0 0-11.8-1A4.5 4.5 0 0 0 7 18Z"],
    syncing: ["M2 12c3-6 7-6 10 0s7 6 10 0"],
    unbound: ["M10 7l1-1a5 5 0 0 1 7 7l-1 1", "M14 17l-1 1a5 5 0 0 1-7-7l1-1", "M3 3l18 18"],
    pending: [
      "M7 18a4.5 4.5 0 0 1-1.8-9A6 6 0 0 1 17 10h1a4 4 0 0 1 0 8",
      "M12 21V13m-3 3 3-3 3 3",
    ],
    conflict: [
      "M12 8v5m0 4h.01",
      "M10.3 3.9 2 18.3a1.8 1.8 0 0 0 1.6 2.7h16.8a1.8 1.8 0 0 0 1.6-2.7L13.7 3.9a2 2 0 0 0-3.4 0Z",
    ],
    error: ["M12 8v4m0 4h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"],
    loading: ["M5 12h.01M12 12h.01M19 12h.01"],
    unavailable: ["M12 8v4m0 4h.01", "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"],
  }[props.state];
  const label =
    props.state === "loading"
      ? t("checking")
      : props.state === "unavailable"
        ? t("skillSyncUnavailable")
        : t(`assetGit.status.${props.state}`);
  return (
    <span
      className={`asset-git-sync-icon${props.state === "conflict" || props.state === "error" || props.state === "unavailable" ? " is-error" : ""}`}
      data-sync-state={props.state}
      role="img"
      aria-label={label}
      title={label}
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {paths.map((path) => (
          <path key={path} d={path} />
        ))}
      </svg>
    </span>
  );
}

export function AssetGitSyncIndicator(props: { readonly target: AssetGitTarget }) {
  const [state, setState] = useState<SyncState>("loading");
  const { kind, id } = props.target;
  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) {
      setState("unavailable");
      return;
    }
    let active = true;
    let receivedUpdate = false;
    setState("loading");
    const unsubscribe = api.subscribeAssetGitStatusUpdates((next) => {
      if (!active || next.target.kind !== kind || next.target.id !== id) return;
      receivedUpdate = true;
      setState(next.status);
    });
    void api.getAssetGitStatus({ kind, id }).then(
      (next) => {
        if (active && !receivedUpdate && next.target.kind === kind && next.target.id === id) {
          setState(next.status);
        }
      },
      () => {
        if (active && !receivedUpdate) setState("unavailable");
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [kind, id]);
  return <AssetGitSyncIcon state={state} />;
}
