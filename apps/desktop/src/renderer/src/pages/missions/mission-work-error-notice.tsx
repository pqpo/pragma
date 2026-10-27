import { useTranslation } from "react-i18next";

export function MissionWorkErrorNotice(props: {
  readonly title: string;
  readonly error: string | null | undefined;
  readonly loading: boolean;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { t } = useTranslation("common");
  if (props.error == null) return null;
  return (
    <div className="mission-work-error-notice" role="alert">
      <span>
        {props.title}: {props.error}
      </span>
      {props.onRetry === undefined ? null : (
        <button type="button" disabled={props.loading} onClick={props.onRetry}>
          {t("actions.retry")}
        </button>
      )}
    </div>
  );
}
