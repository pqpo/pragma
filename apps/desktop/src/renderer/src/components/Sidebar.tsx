import type { Icon } from "@phosphor-icons/react";
import {
  CaretDoubleLeft,
  CaretDoubleRight,
  GearSix,
  House,
  RocketLaunch,
  TerminalWindow,
} from "@phosphor-icons/react";

export type AppView = "missions" | "studio" | "settings";

const navigationItems: readonly {
  readonly label: string;
  readonly icon: Icon;
}[] = [
  { label: "Home", icon: House },
  { label: "Missions", icon: RocketLaunch },
  { label: "Studio", icon: TerminalWindow },
  { label: "Settings", icon: GearSix },
];

export function Sidebar(props: {
  readonly activeView: AppView;
  readonly collapsed: boolean;
  readonly onNavigate: (view: AppView) => void;
  readonly onToggle: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand-row">
        <div className="brand" aria-label="Pragma">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span className="brand-name">Pragma</span>
        </div>
        <button
          className="sidebar-collapse-toggle"
          type="button"
          aria-label={props.collapsed ? "Expand navigation" : "Collapse navigation"}
          title={props.collapsed ? "Expand navigation" : "Collapse navigation"}
          onClick={props.onToggle}
        >
          {props.collapsed ? (
            <CaretDoubleRight size={18} weight="bold" aria-hidden="true" />
          ) : (
            <CaretDoubleLeft size={18} weight="bold" aria-hidden="true" />
          )}
        </button>
      </div>

      <nav className="navigation" aria-label="Main navigation">
        {navigationItems.map((item) => {
          const NavigationIcon = item.icon;
          const targetView: AppView | null =
            item.label === "Missions"
              ? "missions"
              : item.label === "Studio"
                ? "studio"
                : item.label === "Settings"
                  ? "settings"
                  : null;
          const isActive = targetView !== null && props.activeView === targetView;
          const isAvailable = targetView !== null;

          return (
            <button
              key={item.label}
              className={isActive ? "navigation-item is-active" : "navigation-item"}
              type="button"
              aria-current={isActive ? "page" : undefined}
              aria-label={item.label}
              title={item.label}
              disabled={!isAvailable}
              onClick={() => targetView !== null && props.onNavigate(targetView)}
            >
              <NavigationIcon size={24} weight={isActive ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
