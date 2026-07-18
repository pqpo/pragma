import type { Icon } from "@phosphor-icons/react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  GearSix,
  House,
  RocketLaunch,
  TerminalWindow,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

export type AppView = "missions" | "studio" | "settings";

const navigationItems: readonly {
  readonly id: AppView | "home";
  readonly labelKey: string;
  readonly icon: Icon;
}[] = [
  { id: "home", labelKey: "navigation.home", icon: House },
  { id: "missions", labelKey: "navigation.missions", icon: RocketLaunch },
  { id: "studio", labelKey: "navigation.studio", icon: TerminalWindow },
  { id: "settings", labelKey: "navigation.settings", icon: GearSix },
];

export function Sidebar(props: {
  readonly activeView: AppView;
  readonly collapsed: boolean;
  readonly onNavigate: (view: AppView) => void;
  readonly onToggle: () => void;
}) {
  const { t } = useTranslation("common");

  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <div className="brand" aria-label="Pragma">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span className="brand-name">Pragma</span>
        </div>
      </div>

      <nav className="navigation" aria-label={t("navigation.main")}>
        {navigationItems.map((item) => {
          const NavigationIcon = item.icon;
          const targetView: AppView | null = item.id === "home" ? null : item.id;
          const label = t(item.labelKey);
          const isActive = targetView !== null && props.activeView === targetView;
          const isAvailable = targetView !== null;

          return (
            <button
              key={item.id}
              className={isActive ? "navigation-item is-active" : "navigation-item"}
              type="button"
              aria-current={isActive ? "page" : undefined}
              aria-label={label}
              title={label}
              disabled={!isAvailable}
              onClick={() => targetView !== null && props.onNavigate(targetView)}
            >
              <NavigationIcon size={22} aria-hidden="true" />
              <span>{label}</span>
            </button>
          );
        })}
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
