import { Check, GitBranch, MagnifyingGlass, User, UsersThree, X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { ExpertAvatar } from "./ExpertAvatar.tsx";

export type PragmaResourcePickerKind = "expert" | "team" | "flow";

export interface PragmaResourcePickerItem {
  readonly ref: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly searchTerms?: readonly string[] | undefined;
  readonly kind: PragmaResourcePickerKind;
  readonly avatarId?: string | undefined;
}

const PAGE_SIZE = 12;

export function filterPragmaResourcePickerItems(
  items: readonly PragmaResourcePickerItem[],
  query: string,
  kind: PragmaResourcePickerKind | "all",
  excludedRefs: ReadonlySet<string> = new Set(),
): readonly PragmaResourcePickerItem[] {
  const term = query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (excludedRefs.has(item.ref) || (kind !== "all" && item.kind !== kind)) return false;
    return (
      term === "" ||
      [item.name, item.description, item.ref, ...(item.searchTerms ?? [])].some((value) =>
        (value ?? "").toLocaleLowerCase().includes(term),
      )
    );
  });
}

export function PragmaResourcePickerDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly items: readonly PragmaResourcePickerItem[];
  readonly selectedRefs: readonly string[];
  readonly selectionMode: "single" | "multiple";
  readonly onSelectedRefsChange: (refs: readonly string[]) => void;
  readonly onClose: () => void;
  readonly excludedRefs?: ReadonlySet<string> | undefined;
  readonly footerHint?: string | undefined;
  readonly searchPlaceholder?: string | undefined;
}) {
  const { t } = useTranslation("studio");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PragmaResourcePickerKind | "all">("all");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const selected = useMemo(() => new Set(props.selectedRefs), [props.selectedRefs]);
  const availableKinds = useMemo(
    () => Array.from(new Set(props.items.map((item) => item.kind))),
    [props.items],
  );
  const visibleItems = useMemo(
    () => filterPragmaResourcePickerItems(props.items, query, kind, props.excludedRefs),
    [kind, props.excludedRefs, props.items, query],
  );
  const shownItems = visibleItems.slice(0, visibleLimit);

  useEffect(() => setVisibleLimit(PAGE_SIZE), [kind, query]);
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

  const selectItem = (item: PragmaResourcePickerItem) => {
    if (props.selectionMode === "single") {
      props.onSelectedRefsChange([item.ref]);
      props.onClose();
      return;
    }
    props.onSelectedRefsChange(
      selected.has(item.ref)
        ? props.selectedRefs.filter((ref) => ref !== item.ref)
        : [...props.selectedRefs, item.ref],
    );
  };

  return (
    <div
      className="expert-picker-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <aside
        className="expert-picker-dialog has-resource-filters"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pragma-resource-picker-heading"
      >
        <header className="expert-picker-heading">
          <div>
            <small>{t("resources")}</small>
            <h2 id="pragma-resource-picker-heading">{props.title}</h2>
            <p>{props.description}</p>
          </div>
          <button type="button" aria-label={t("closeResourcePicker")} onClick={props.onClose}>
            <X size={19} aria-hidden="true" />
          </button>
        </header>
        {availableKinds.length > 1 ? (
          <div className="expert-picker-resource-filters" role="group" aria-label={t("resources")}>
            {(["all", ...availableKinds] as const).map((candidate) => (
              <button
                type="button"
                aria-pressed={kind === candidate}
                key={candidate}
                onClick={() => setKind(candidate)}
              >
                {pickerKindLabel(candidate, t)}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <label className="expert-picker-search">
          <MagnifyingGlass size={18} aria-hidden="true" />
          <span className="sr-only">{props.searchPlaceholder ?? t("searchResources")}</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={props.searchPlaceholder ?? t("searchResources")}
          />
          {query ? (
            <button type="button" aria-label={t("clearSearch")} onClick={() => setQuery("")}>
              <X size={16} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <div className="expert-picker-toolbar">
          <span>{t("selectedCount", { count: props.selectedRefs.length })}</span>
          {props.selectedRefs.length > 0 ? (
            <button type="button" onClick={() => props.onSelectedRefsChange([])}>
              {t("clearSelection")}
            </button>
          ) : null}
        </div>
        <div className="expert-picker-results">
          {shownItems.length > 0 ? (
            <div className="expert-resource-options">
              {shownItems.map((item) => {
                const isSelected = selected.has(item.ref);
                return (
                  <button
                    className={`expert-resource-option${isSelected ? " is-selected" : ""}`}
                    type="button"
                    aria-pressed={isSelected}
                    key={item.ref}
                    onClick={() => selectItem(item)}
                  >
                    <span className="expert-resource-option-visual" aria-hidden="true">
                      <ResourceVisual item={item} />
                    </span>
                    <span className="expert-resource-option-copy">
                      <strong>{item.name}</strong>
                      <small>{item.description || item.ref}</small>
                    </span>
                    <span className="expert-resource-option-meta">
                      <span>{pickerKindLabel(item.kind, t)}</span>
                      <Check
                        className={isSelected ? "is-visible" : undefined}
                        size={18}
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="expert-picker-empty">
              <strong>
                {query.trim() ? t("noMatchesFound") : t("noAvailable", { label: t("resources") })}
              </strong>
              <p>{query.trim() ? t("tryDifferentDescription") : t("addItemsStudio")}</p>
            </div>
          )}
          {visibleItems.length > shownItems.length ? (
            <button
              className="expert-tool-load-more"
              type="button"
              onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}
            >
              {t("loadMoreResources", { count: visibleItems.length - shownItems.length })}
            </button>
          ) : null}
        </div>
        <footer className="expert-picker-actions">
          <span>{props.footerHint ?? t("changesImmediate")}</span>
          <button className="primary-button" type="button" onClick={props.onClose}>
            {t("common:actions.done")}
          </button>
        </footer>
      </aside>
    </div>
  );
}

function ResourceVisual(props: { readonly item: PragmaResourcePickerItem }) {
  if (props.item.kind === "expert" || props.item.kind === "team") {
    return (
      <ExpertAvatar avatarId={props.item.avatarId} team={props.item.kind === "team"} size="md" />
    );
  }
  const Icon =
    props.item.kind === "flow" ? GitBranch : props.item.kind === "team" ? UsersThree : User;
  return <Icon size={22} aria-hidden="true" />;
}

function pickerKindLabel(
  kind: PragmaResourcePickerKind | "all",
  t: (key: string) => string,
): string {
  return kind === "all"
    ? t("all")
    : kind === "expert"
      ? t("expert")
      : kind === "team"
        ? t("expertTeam")
        : t("flow");
}
