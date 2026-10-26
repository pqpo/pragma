import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AssetGitTarget } from "../../../../shared/contracts/index.ts";
import { formatMissionDateTime } from "../../lib/mission-time.ts";
import { AssetGitSyncIndicator } from "./AssetGitSyncIndicator.tsx";

export function StudioCatalogCard(props: {
  readonly name: string;
  readonly description: string;
  readonly updatedAt?: string | undefined;
  readonly expertNames?: readonly string[] | undefined;
  readonly syncTarget?: AssetGitTarget | undefined;
  readonly badge?: ReactNode;
  readonly summary?: ReactNode;
  readonly footer?: ReactNode;
  readonly actions?: ReactNode;
  readonly builtIn?: boolean | undefined;
  readonly needsAttention?: boolean | undefined;
  readonly onOpen: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const updatedAt = new Date(props.updatedAt ?? "");
  const updatedLabel = Number.isFinite(updatedAt.getTime())
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        year: updatedAt.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
        month: "short",
        day: "numeric",
      }).format(updatedAt)
    : null;
  return (
    <div className={`studio-catalog-card${props.actions ? " has-actions" : ""}`} role="listitem">
      <button className="studio-catalog-card-open" type="button" onClick={props.onOpen}>
        <span className="studio-catalog-card-heading">
          <span className="studio-catalog-card-name" title={props.name}>
            {props.name}
          </span>
          {props.badge ??
            (props.builtIn === true ? (
              <span className="studio-catalog-card-source">{t("builtIn")}</span>
            ) : props.syncTarget !== undefined ? (
              <AssetGitSyncIndicator target={props.syncTarget} />
            ) : null)}
        </span>
        {props.description ? (
          <span className="studio-catalog-card-description">{props.description}</span>
        ) : null}
        {props.summary}
        {props.needsAttention === true ? (
          <span className="studio-catalog-card-attention">{t("needsAttention")}</span>
        ) : null}
        <span className="studio-catalog-card-footer">
          {props.footer}
          {(props.expertNames?.length ?? 0) > 0 ? (
            <span title={props.expertNames?.join("、")}>
              {t("assetUsedByExperts", { count: props.expertNames?.length })}
            </span>
          ) : null}
          {updatedLabel !== null && props.updatedAt !== undefined ? (
            <time dateTime={props.updatedAt} title={formatMissionDateTime(props.updatedAt)}>
              {t("assetUpdatedAt", { date: updatedLabel })}
            </time>
          ) : null}
        </span>
      </button>
      {props.actions ? <div className="studio-catalog-card-actions">{props.actions}</div> : null}
    </div>
  );
}
