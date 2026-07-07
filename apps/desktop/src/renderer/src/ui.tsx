import type { PropsWithChildren, ReactNode } from "react";

import type { DesktopViewKey } from "./mock-data.ts";

const navItems: readonly {
  readonly id: DesktopViewKey;
  readonly label: string;
  readonly hint: string;
  readonly short: string;
}[] = [
  { id: "agents", label: "Agent 广场", hint: "创建专家", short: "AG" },
  { id: "models", label: "模型管理", hint: "注册模型", short: "MO" },
  { id: "plugins", label: "插件市场", hint: "导入插件", short: "PL" },
  { id: "workflows", label: "工作流编排", hint: "低码画布", short: "WF" },
  { id: "tasks", label: "任务看板", hint: "运行监控", short: "TK" },
];

export function Sidebar(props: {
  readonly activeView: DesktopViewKey;
  readonly onSelectView: (view: DesktopViewKey) => void;
  readonly status: {
    readonly deviceLabel: string;
    readonly workspaceLabel: string;
    readonly connectionLabel: string;
  };
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar__rail">
        <button type="button" className="rail-mark">
          P
        </button>
        <div className="rail-icons">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === props.activeView ? "rail-icon is-active" : "rail-icon"}
              onClick={() => props.onSelectView(item.id)}
              aria-label={item.label}
            >
              {item.short}
            </button>
          ))}
        </div>
        <div className="rail-footer">
          <span className="rail-icon rail-icon--static">WS</span>
          <span className="rail-icon rail-icon--static">ST</span>
        </div>
      </div>

      <div className="sidebar__menu">
        <div className="sidebar__brand">
          <div>
            <p className="eyebrow">Pragma</p>
            <h1>任务工作台</h1>
          </div>
        </div>

        <nav className="sidebar__nav" aria-label="Desktop navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === props.activeView ? "nav-item is-active" : "nav-item"}
              onClick={() => props.onSelectView(item.id)}
            >
              <div className="nav-item__title">
                <strong>{item.label}</strong>
                <span>{item.hint}</span>
              </div>
            </button>
          ))}
        </nav>

        <div className="sidebar__status">
          <div>
            <span className="sidebar__status-label">Device</span>
            <strong>{props.status.deviceLabel}</strong>
          </div>
          <div>
            <span className="sidebar__status-label">Workspace</span>
            <strong>{props.status.workspaceLabel}</strong>
          </div>
          <div>
            <span className="sidebar__status-label">Gateway</span>
            <strong>{props.status.connectionLabel}</strong>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function Topbar(props: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar__title">
        <span className="topbar__section">{props.eyebrow}</span>
        <h2>{props.title}</h2>
        <p className="topbar__description">{props.description}</p>
      </div>

      <div className="topbar__actions">
        <label className="search-shell">
          <input type="text" value="" readOnly placeholder="搜索 Agent、模型、工作流、任务..." />
        </label>
        <span className="topbar__context">default / ws_local</span>
        <button type="button" className="primary-button" onClick={props.onAction}>
          {props.actionLabel}
        </button>
      </div>
    </header>
  );
}

export function Panel(props: PropsWithChildren<{ readonly inset?: boolean }>) {
  return <section className={props.inset ? "panel panel--inset" : "panel"}>{props.children}</section>;
}

export function SectionHeader(props: {
  readonly title: string;
  readonly description: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        <h3>{props.title}</h3>
        <p>{props.description}</p>
      </div>
      {props.action === undefined ? null : <div className="section-header__action">{props.action}</div>}
    </div>
  );
}

export function StatusBadge(props: PropsWithChildren<{ readonly tone: "neutral" | "accent" | "success" | "warning" | "danger" }>) {
  return <span className={`status-badge status-badge--${props.tone}`}>{props.children}</span>;
}

export function Drawer(props: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  return (
    <div className={props.open ? "drawer-backdrop is-open" : "drawer-backdrop"} aria-hidden={!props.open}>
      <aside className={props.open ? "drawer is-open" : "drawer"}>
        <div className="drawer__header">
          <div>
            <h3>{props.title}</h3>
            <p>{props.description}</p>
          </div>
          <button type="button" className="drawer__close" onClick={props.onClose} aria-label="Close drawer">
            ×
          </button>
        </div>
        <div className="drawer__content">{props.children}</div>
      </aside>
    </div>
  );
}
