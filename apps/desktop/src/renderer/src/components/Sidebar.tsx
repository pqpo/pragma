import type { Icon } from "@phosphor-icons/react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartLineUp,
  DotsThree,
  PushPin,
  PushPinSlash,
  GearSix,
  House,
  Brain,
  RocketLaunch,
  TestTube,
  Storefront,
  TerminalWindow,
} from "@phosphor-icons/react";
import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import pragmaIcon from "../assets/pragma-icon.png";
import { readPinnedNavigation, writePinnedNavigation } from "../lib/sidebar-preference.ts";

export type AppView =
  "home" | "missions" | "studio" | "market" | "evaluations" | "memory" | "usage" | "settings";

const navigationItems: readonly {
  readonly id: AppView;
  readonly labelKey: string;
  readonly icon: Icon;
}[] = [
  { id: "home", labelKey: "navigation.home", icon: House },
  { id: "missions", labelKey: "navigation.missions", icon: RocketLaunch },
  { id: "studio", labelKey: "navigation.studio", icon: TerminalWindow },
  { id: "memory", labelKey: "navigation.memory", icon: Brain },
];

const moreNavigationItems = [
  { id: "market", labelKey: "navigation.market", icon: Storefront },
  { id: "evaluations", labelKey: "navigation.evaluations", icon: TestTube },
  { id: "usage", labelKey: "navigation.usage", icon: ChartLineUp },
  { id: "settings", labelKey: "navigation.settings", icon: GearSix },
] as const;

export function Sidebar(props: {
  readonly activeView: AppView;
  readonly collapsed: boolean;
  readonly memoryEnabled: boolean;
  readonly onNavigate: (view: AppView) => void;
  readonly onToggle: () => void;
}) {
  const { t } = useTranslation("common");
  const [pinnedItems, setPinnedItems] = useState(() => readPinnedNavigation());
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const moreButton = useRef<HTMLButtonElement>(null);
  const visibleNavigationItems = [
    ...navigationItems,
    ...moreNavigationItems.filter((item) => pinnedItems.includes(item.id)),
  ].filter((item) => item.id !== "memory" || props.memoryEnabled);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <div className="brand" aria-label="Pragma">
          <span className="brand-mark" aria-hidden="true">
            <img src={pragmaIcon} alt="" draggable={false} />
          </span>
          <span className="brand-name">Pragma</span>
        </div>
      </div>

      <nav className="navigation" aria-label={t("navigation.main")}>
        {visibleNavigationItems.map((item) => {
          const NavigationIcon = item.icon;
          const label = t(item.labelKey);
          const isActive = props.activeView === item.id;

          return (
            <button
              key={item.id}
              className={isActive ? "navigation-item is-active" : "navigation-item"}
              type="button"
              aria-current={isActive ? "page" : undefined}
              aria-label={label}
              title={props.collapsed ? undefined : label}
              onClick={() => props.onNavigate(item.id)}
            >
              <NavigationIcon size={22} aria-hidden="true" />
              <span
                className={props.collapsed ? "navigation-tooltip" : "navigation-label"}
                role={props.collapsed ? "tooltip" : undefined}
              >
                {label}
              </span>
            </button>
          );
        })}
        <div
          className="navigation-more"
          onMouseEnter={() => setMoreOpen(true)}
          onMouseLeave={() => setMoreOpen(false)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMoreOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setMoreOpen(false);
              moreButton.current?.focus();
            }
          }}
        >
          <button
            ref={moreButton}
            className={
              moreNavigationItems.some(
                (item) => item.id === props.activeView && !pinnedItems.includes(item.id),
              )
                ? "navigation-item is-active"
                : "navigation-item"
            }
            type="button"
            aria-label={t("navigation.more")}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            aria-haspopup="dialog"
            onClick={() => setMoreOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMoreOpen(true);
              }
            }}
          >
            <DotsThree size={22} aria-hidden="true" />
            <span className="navigation-label">{t("navigation.more")}</span>
          </button>
          {moreOpen && (
            <div className="navigation-more-popover">
              <div
                id={moreId}
                className="navigation-more-panel"
                role="dialog"
                aria-label={t("navigation.more")}
              >
                {moreNavigationItems.map((item) => {
                  const NavigationIcon = item.icon;
                  const pinned = pinnedItems.includes(item.id);
                  const label = t(item.labelKey);
                  const pinLabel = t(pinned ? "navigation.unpin" : "navigation.pin", {
                    name: label,
                  });
                  return (
                    <div key={item.id} className="navigation-more-row">
                      <button
                        type="button"
                        className={
                          props.activeView === item.id
                            ? "navigation-more-link is-active"
                            : "navigation-more-link"
                        }
                        aria-current={props.activeView === item.id ? "page" : undefined}
                        onClick={() => {
                          props.onNavigate(item.id);
                          setMoreOpen(false);
                          moreButton.current?.focus();
                        }}
                      >
                        <NavigationIcon size={20} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                      <button
                        type="button"
                        className="navigation-pin"
                        aria-label={pinLabel}
                        title={pinLabel}
                        aria-pressed={pinned}
                        onClick={() => {
                          const next = pinned
                            ? pinnedItems.filter((id) => id !== item.id)
                            : [...pinnedItems, item.id];
                          setPinnedItems(next);
                          writePinnedNavigation(next);
                        }}
                      >
                        {pinned ? (
                          <PushPinSlash size={16} aria-hidden="true" />
                        ) : (
                          <PushPin size={16} aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </nav>

      <div className="sidebar-footer">
        <button
          className="sidebar-collapse-toggle"
          type="button"
          aria-label={props.collapsed ? t("navigation.expand") : t("navigation.collapse")}
          title={props.collapsed ? t("navigation.expand") : t("navigation.collapse")}
          onClick={props.onToggle}
        >
          {props.collapsed ? (
            <CaretDoubleRight size={17} aria-hidden="true" />
          ) : (
            <CaretDoubleLeft size={17} aria-hidden="true" />
          )}
        </button>
      </div>
    </aside>
  );
}
