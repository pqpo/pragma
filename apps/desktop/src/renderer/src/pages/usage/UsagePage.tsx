import { useCallback, useEffect, useMemo, useState } from "react";
import { ChartLineUp, WarningCircle } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import type {
  UsageOverview,
  UsagePeriod,
  UsageSubjectItem,
  UsageSubjectKind,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { formatTokens } from "../../lib/usage-format.ts";
import { i18n } from "../../i18n/index.ts";

const PAGE_SIZE = 20;

export function UsagePage() {
  const { t } = useTranslation(["usage", "common"]);
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [kind, setKind] = useState<UsageSubjectKind>("mission");
  const [overview, setOverview] = useState<UsageOverview | null>(null);
  const [subjects, setSubjects] = useState<readonly UsageSubjectItem[]>([]);
  const [subjectTotal, setSubjectTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (offset = 0) => {
      setLoading(true);
      try {
        const [nextOverview, nextSubjects] = await Promise.all([
          window.pragmaDesktop.getUsageOverview({ period }),
          window.pragmaDesktop.listUsageSubjects({
            period,
            kind,
            offset,
            limit: PAGE_SIZE,
          }),
        ]);
        setOverview(nextOverview);
        setSubjects((current) =>
          offset > 0 ? [...current, ...nextSubjects.items] : nextSubjects.items,
        );
        setSubjectTotal(nextSubjects.total);
        setError(null);
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setLoading(false);
      }
    },
    [kind, period],
  );

  useEffect(() => {
    void load(0);
  }, [kind, period]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.pragmaDesktop.subscribeUsageUpdates(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = setTimeout(() => void load(0), 200);
    });
    return () => {
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
    };
  }, [load]);

  const startedAt =
    overview === null
      ? ""
      : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(
          new Date(overview.trackingStartedAt),
        );

  return (
    <section className="usage-page">
      <header className="usage-page-header">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("description")}</p>
        </div>
        <div className="usage-period-control" role="group" aria-label={t("title")}>
          {(
            [
              ["7d", t("periods.sevenDays")],
              ["30d", t("periods.thirtyDays")],
              ["all", t("periods.all")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={period === value ? "is-active" : undefined}
              type="button"
              aria-pressed={period === value}
              onClick={() => setPeriod(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {error !== null && overview === null ? (
        <div className="usage-empty" role="alert">
          <WarningCircle size={30} aria-hidden="true" />
          <h2>{t("loadError")}</h2>
          <p>{error}</p>
          <button type="button" onClick={() => void load(0)}>
            {t("actions.retry", { ns: "common" })}
          </button>
        </div>
      ) : overview === null ? (
        <div className="usage-empty" role="status">
          {t("loading")}
        </div>
      ) : (
        <>
          <p className="usage-tracking-since">{t("trackingSince", { date: startedAt })}</p>
          <section className="usage-summary-card">
            <div className="usage-total">
              <span>{t("total")}</span>
              <strong>{formatTokens(overview.totals.totalTokens)}</strong>
            </div>
            <dl className="usage-breakdown">
              <UsageMetric label={t("input")} value={overview.totals.input} />
              <UsageMetric label={t("output")} value={overview.totals.output} />
              <UsageMetric label={t("cacheRead")} value={overview.totals.cacheRead} />
              <UsageMetric label={t("cacheWrite")} value={overview.totals.cacheWrite} />
            </dl>
          </section>

          {overview.totals.totalTokens === 0 ? (
            <div className="usage-empty">
              <ChartLineUp size={31} aria-hidden="true" />
              <h2>{t("noUsage")}</h2>
              <p>{t("noUsageDescription")}</p>
            </div>
          ) : (
            <>
              <section className="usage-chart-card">
                <header>
                  <h2>{t("trend")}</h2>
                </header>
                <UsageTrendChart overview={overview} label={t("trend")} />
              </section>
              <section className="usage-subject-card">
                <div className="usage-subject-tabs" role="tablist">
                  {(["mission", "expert", "team", "flow"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={kind === value}
                      className={kind === value ? "is-active" : undefined}
                      onClick={() => setKind(value)}
                    >
                      {t(`subjects.${value}`)}
                    </button>
                  ))}
                </div>
                {kind === "team" || kind === "flow" ? (
                  <p className="usage-inclusive-note">{t("inclusiveNote")}</p>
                ) : null}
                <ol className="usage-subject-list">
                  {subjects.map((subject) => (
                    <li key={`${subject.kind}:${subject.id}`}>
                      <div className="usage-subject-row">
                        <span title={subject.id}>{subject.name}</span>
                        <strong>{formatTokens(subject.usage.totalTokens)}</strong>
                      </div>
                      <div className="usage-share-track" aria-hidden="true">
                        <span style={{ width: `${subject.share * 100}%` }} />
                      </div>
                      <small>{t("share", { percent: Math.round(subject.share * 100) })}</small>
                    </li>
                  ))}
                </ol>
                {subjects.length < subjectTotal ? (
                  <button
                    className="usage-load-more"
                    type="button"
                    disabled={loading}
                    onClick={() => void load(subjects.length)}
                  >
                    {t("loadMore")}
                  </button>
                ) : null}
              </section>
            </>
          )}
        </>
      )}
    </section>
  );
}

function UsageMetric(props: { readonly label: string; readonly value: number }) {
  return (
    <div>
      <dt>{props.label}</dt>
      <dd>{formatTokens(props.value)}</dd>
    </div>
  );
}

function UsageTrendChart(props: { readonly overview: UsageOverview; readonly label: string }) {
  const points = useMemo(() => {
    const values = props.overview.daily.map((point) => point.totalTokens);
    const max = Math.max(...values, 1);
    return values.map((value, index) => {
      const x = values.length <= 1 ? 50 : (index / (values.length - 1)) * 100;
      const y = 92 - (value / max) * 78;
      return { x, y };
    });
  }, [props.overview.daily]);
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length === 0 ? "" : `0,96 ${line} 100,96`;
  return (
    <svg
      className="usage-trend-chart"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={props.label}
    >
      <line x1="0" y1="96" x2="100" y2="96" className="usage-chart-axis" />
      <polygon points={area} className="usage-chart-area" />
      <polyline points={line} className="usage-chart-line" />
    </svg>
  );
}
