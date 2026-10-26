import { useTranslation } from "react-i18next";
import type { AssetGitTarget } from "../../../../shared/contracts/index.ts";
import { formatMissionDateTime } from "../../lib/mission-time.ts";
import { AssetGitSyncIndicator } from "./AssetGitSyncIndicator.tsx";

export function StudioCatalogCard(props: {
  readonly name: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly expertNames?: readonly string[] | undefined;
  readonly syncTarget: AssetGitTarget;
  readonly builtIn?: boolean | undefined;
  readonly needsAttention?: boolean | undefined;
  readonly onOpen: () => void;
}) {
  const { t, i18n } = useTranslation("studio");
  const updatedAt = new Date(props.updatedAt);
  const updatedLabel = Number.isFinite(updatedAt.getTime())
    ? new Intl.DateTimeFormat(i18n.resolvedLanguage, {
        year: updatedAt.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
        month: "short",
        day: "numeric",
      }).format(updatedAt)
    : null;
  return (
    <div className="studio-catalog-card" role="listitem">
      <button className="studio-catalog-card-open" type="button" onClick={props.onOpen}>
        <span className="studio-catalog-card-heading">
          <span className="studio-catalog-card-name" title={props.name}>
            {props.name}
          </span>
          {props.builtIn === true ? (
            <span className="studio-catalog-card-source">{t("builtIn")}</span>
          ) : (
            <AssetGitSyncIndicator target={props.syncTarget} />
          )}
        </span>
        {props.description ? (
          <span className="studio-catalog-card-description">{props.description}</span>
        ) : null}
        {props.needsAttention === true ? (
          <span className="studio-catalog-card-attention">{t("needsAttention")}</span>
        ) : null}
        <span className="studio-catalog-card-footer">
          {(props.expertNames?.length ?? 0) > 0 ? (
            <span title={props.expertNames?.join("、")}>
              {t("assetUsedByExperts", { count: props.expertNames?.length })}
            </span>
          ) : null}
          {updatedLabel !== null ? (
            <time dateTime={props.updatedAt} title={formatMissionDateTime(props.updatedAt)}>
              {t("assetUpdatedAt", { date: updatedLabel })}
            </time>
          ) : null}
        </span>
      </button>
    </div>
  );
}
