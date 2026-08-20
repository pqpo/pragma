import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ContextStore } from "../../../shared/contracts/index.ts";

const PAGE_SIZE = 20;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function ContextStorePickerDialog(props: {
  readonly stores: readonly ContextStore[];
  readonly selectedStoreIds: readonly string[];
  readonly description: string;
  readonly footerHint: string;
  readonly onSelectedStoreIdsChange: (storeIds: readonly string[]) => void;
  readonly onClose: () => void;
  readonly onGoToKnowledgeBases?: (() => void) | undefined;
}) {
  const { t } = useTranslation("studio");
  const [query, setQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const selectedStoreIds = useMemo(() => new Set(props.selectedStoreIds), [props.selectedStoreIds]);
  const visibleStores = props.stores.filter((store) =>
    normalized(`${store.name} ${store.description}`).includes(normalized(query)),
  );
  const shownStores = visibleStores.slice(0, visibleLimit);

  useEffect(() => setVisibleLimit(PAGE_SIZE), [query]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [props.onClose]);

  return (
    <div
      className="expert-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <aside
        className="expert-picker-dialog context-store-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-store-picker-heading"
      >
        <header className="expert-picker-heading">
          <div>
            <h2 id="context-store-picker-heading">{t("contextStores")}</h2>
            <p>{props.description}</p>
          </div>
          <button type="button" aria-label={t("closeKnowledgeBasePicker")} onClick={props.onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        <label className="expert-picker-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">{t("searchContextStores")}</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchContextStores")}
          />
          {query ? (
            <button type="button" aria-label={t("clearSearch")} onClick={() => setQuery("")}>
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <div className="expert-picker-toolbar">
          <span>{t("selectedCount", { count: props.selectedStoreIds.length })}</span>
          {props.selectedStoreIds.length > 0 ? (
            <button type="button" onClick={() => props.onSelectedStoreIdsChange([])}>
              {t("clearSelection")}
            </button>
          ) : null}
        </div>
        <div className="expert-picker-results">
          {visibleStores.length === 0 ? (
            <div className="expert-picker-empty">
              <strong>
                {query.trim()
                  ? t("noMatchesFound")
                  : t("noAvailable", { label: t("contextStoresLower") })}
              </strong>
              {query.trim() || props.onGoToKnowledgeBases === undefined ? (
                <p>{query.trim() ? t("tryDifferentDescription") : t("goToKnowledgeBases")}</p>
              ) : (
                <button
                  className="expert-picker-empty-link"
                  type="button"
                  onClick={() => {
                    props.onClose();
                    props.onGoToKnowledgeBases?.();
                  }}
                >
                  {t("goToKnowledgeBases")}
                </button>
              )}
            </div>
          ) : (
            <div className="expert-picker-list">
              {shownStores.map((store) => {
                const selected = selectedStoreIds.has(store.id);
                return (
                  <label
                    className={`expert-picker-row${selected ? " is-selected" : ""}`}
                    key={store.id}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) =>
                        props.onSelectedStoreIdsChange(
                          event.target.checked
                            ? [...props.selectedStoreIds, store.id]
                            : props.selectedStoreIds.filter((storeId) => storeId !== store.id),
                        )
                      }
                    />
                    <span>
                      <strong>{store.name}</strong>
                      <small>{store.description || t("knowledgeBase")}</small>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {visibleStores.length > shownStores.length ? (
            <button
              className="expert-tool-load-more"
              type="button"
              onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}
            >
              {t("loadMoreResources", { count: visibleStores.length - shownStores.length })}
            </button>
          ) : null}
        </div>
        <footer className="expert-picker-actions">
          <span>{props.footerHint}</span>
          <button className="primary-button" type="button" onClick={props.onClose}>
            {t("common:actions.done")}
          </button>
        </footer>
      </aside>
    </div>
  );
}
