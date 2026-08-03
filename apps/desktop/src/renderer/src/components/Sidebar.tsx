import type { Icon } from "@phosphor-icons/react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartLineUp,
  GearSix,
  House,
  Brain,
  RocketLaunch,
  TestTube,
  TerminalWindow,
} from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

import pragmaIcon from "../assets/pragma-icon.png";

export type AppView = "home" | "missions" | "studio" | "evaluations" | "memory" | "usage" | "settings";

const navigationItems: readonly {
  readonly id: AppView;
  readonly labelKey: string;
  readonly icon: Icon;
}[] = [
  { id: "home", labelKey: "navigation.home", icon: House },
  { id: "missions", labelKey: "navigation.missions", icon: RocketLaunch },
  { id: "studio", labelKey: "navigation.studio", icon: TerminalWindow },
  { id: "evaluations", labelKey: "navigation.evaluations", icon: TestTube },
  { id: "memory", labelKey: "navigation.memory", icon: Brain },
  { id: "usage", labelKey: "navigation.usage", icon: ChartLineUp },
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
            <img src={pragmaIcon} alt="" draggable={false} />
          </span>
          <span className="brand-name">Pragma</span>
        </div>
      </div>

      <nav className="navigation" aria-label={t("navigation.main")}>
        {navigationItems.map((item) => {
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
              title={label}
              onClick={() => props.onNavigate(item.id)}
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
