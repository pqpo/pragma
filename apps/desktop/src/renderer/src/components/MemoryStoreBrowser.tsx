import { ArrowLeft } from "@phosphor-icons/react";

import { ContextStoreBrowser, type ContextStoreBrowserSource } from "./ContextStoreBrowser.tsx";

export type { ContextStoreBrowserSource } from "./ContextStoreBrowser.tsx";

export function MemoryStoreBrowser(props: {
  readonly source: ContextStoreBrowserSource;
  readonly className?: string | undefined;
  readonly onBack?: (() => void) | undefined;
  readonly backLabel?: string | undefined;
}) {
  return (
    <div className={props.className ?? "memory-store-browser"}>
      {props.onBack !== undefined && props.backLabel !== undefined ? (
        <button type="button" className="mission-memory-back" onClick={props.onBack}>
          <ArrowLeft size={16} aria-hidden="true" />
          {props.backLabel}
        </button>
      ) : null}
      <ContextStoreBrowser source={props.source} />
    </div>
  );
}
