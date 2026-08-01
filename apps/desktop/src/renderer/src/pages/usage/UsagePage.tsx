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
                <p className="usage-inclusive-note">
                  {kind === "mission" ? t("missionListNote") : t("inclusiveNote")}
                </p>
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

export function usageTrendPoints(values: readonly number[]) {
  const max = Math.max(...values, 1);
  return values.map((value, index) => {
    const x = values.length <= 1 ? 50 : 1 + (index / (values.length - 1)) * 98;
    const y = 92 - (value / max) * 78;
    return { x, y };
  });
}

function usageChartDate(date: string, language: string, dateStyle: "axis" | "tooltip"): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(language, {
    timeZone: "UTC",
    ...(dateStyle === "axis"
      ? { month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" }),
  }).format(new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)));
}

export function usageTrendLabelIndexes(length: number): readonly number[] {
  if (length <= 0) return [];
  return [...new Set([0, Math.floor((length - 1) / 2), length - 1])];
}

export function UsageTrendChart(props: {
  readonly overview: UsageOverview;
  readonly label: string;
}) {
  const { t } = useTranslation("usage");
  const points = useMemo(
    () => usageTrendPoints(props.overview.daily.map((point) => point.totalTokens)),
    [props.overview.daily],
  );
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = points.length === 0 ? "" : `1,92 ${line} 99,92`;
  const maxTokens = Math.max(...props.overview.daily.map((point) => point.totalTokens), 1);
  const yTicks = [maxTokens, Math.round(maxTokens / 2), 0];
  const labelIndexes = usageTrendLabelIndexes(props.overview.daily.length);

  return (
    <div className="usage-chart-figure" role="group" aria-label={props.label}>
      <div className="usage-chart-y-axis" aria-hidden="true">
        {yTicks.map((value, index) => (
          <span key={`${value}:${index}`} style={{ top: `${[14, 53, 92][index]}%` }}>
            {formatTokens(value)}
          </span>
        ))}
      </div>
      <div className="usage-chart-content">
        <div className="usage-chart-plot">
          <svg
            className="usage-trend-chart"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {[14, 53, 92].map((y) => (
              <line key={y} x1="1" y1={y} x2="99" y2={y} className="usage-chart-grid-line" />
            ))}
            <line x1="1" y1="14" x2="1" y2="92" className="usage-chart-axis" />
            <line x1="1" y1="92" x2="99" y2="92" className="usage-chart-axis" />
            <polygon points={area} className="usage-chart-area" />
            <polyline points={line} className="usage-chart-line" />
          </svg>
          {props.overview.daily.map((daily, index) => {
            const point = points[index];
            if (point === undefined) return null;
            const tokenValue = new Intl.NumberFormat(i18n.language).format(daily.totalTokens);
            const date = usageChartDate(daily.date, i18n.language, "tooltip");
            return (
              <button
                key={daily.date}
                className={
                  index === 0
                    ? "usage-chart-node is-first"
                    : index === points.length - 1
                      ? "usage-chart-node is-last"
                      : "usage-chart-node"
                }
                type="button"
                style={{ left: `${point.x}%`, top: `${point.y}%` }}
                aria-label={t("chartPointLabel", { date, tokens: tokenValue })}
              >
                <span className="usage-chart-node-dot" aria-hidden="true" />
                <span className="usage-chart-tooltip" role="tooltip">
                  <time dateTime={daily.date}>{date}</time>
                  <strong>{t("chartTokenValue", { tokens: tokenValue })}</strong>
                </span>
              </button>
            );
          })}
        </div>
        <div className="usage-chart-x-axis" aria-hidden="true">
          {labelIndexes.map((index) => {
            const daily = props.overview.daily[index];
            return daily === undefined ? null : (
              <time key={daily.date} dateTime={daily.date}>
                {usageChartDate(daily.date, i18n.language, "axis")}
              </time>
            );
          })}
        </div>
      </div>
    </div>
  );
}
