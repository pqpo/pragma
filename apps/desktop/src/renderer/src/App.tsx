import type { Icon } from "@phosphor-icons/react";
import {
  ArchiveTrayIcon,
  At,
  CaretDown,
  ChartBar,
  Code,
  FileText,
  GearSix,
  House,
  Plus,
  QuestionMark,
  RocketLaunch,
  TerminalWindow,
  UserCircle,
} from "@phosphor-icons/react";

const navigationItems: readonly {
  readonly label: string;
  readonly icon: Icon;
  readonly active?: boolean;
}[] = [
  { label: "Home", icon: House, active: true },
  { label: "Missions", icon: RocketLaunch },
  { label: "Studio", icon: TerminalWindow },
  { label: "Inbox", icon: ArchiveTrayIcon },
  { label: "Settings", icon: GearSix },
];

const missions = [
  {
    status: "Active",
    statusTone: "active",
    time: "10m ago",
    title: "Compile Q3 Revenue Data Synthesis",
    agent: "Data Agent",
  },
  {
    status: "Awaiting Input",
    statusTone: "waiting",
    time: "1h ago",
    title: "Refine Architecture Proposal Drafting",
    agent: "Writing Agent",
  },
  {
    status: "Idle",
    statusTone: "idle",
    time: "Yesterday",
    title: "Audit Codebase Dependencies",
    agent: "Dev Agent",
  },
] as const;

const requests = [
  {
    icon: QuestionMark,
    title: "Clarification requested on scope",
    description: "The Writing Agent encountered ambiguous requirements in section 3.",
    mission: "Refine Architecture Proposal",
  },
  {
    icon: At,
    title: "Approval needed to access external API",
    description: "Data Agent is attempting to query 'api.example.com'.",
    mission: "Compile Q3 Revenue Data",
  },
] as const;

const artifacts: readonly {
  readonly icon: Icon;
  readonly name: string;
  readonly kind: string;
}[] = [
  { icon: FileText, name: "Architecture_Draft_v2.md", kind: "Document" },
  { icon: ChartBar, name: "Q2_Revenue_Analysis.csv", kind: "Dataset" },
  { icon: Code, name: "Dependency_Graph.json", kind: "Config" },
];

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand" aria-label="Pragma">
        <span className="brand-mark" aria-hidden="true">
          P
        </span>
        <span className="brand-name">Pragma</span>
      </div>

      <button className="new-mission-button" type="button" disabled>
        <Plus size={19} weight="bold" />
        New Mission
      </button>

      <nav className="navigation" aria-label="Main navigation">
        {navigationItems.map((item) => {
          const NavigationIcon = item.icon;

          return (
            <button
              key={item.label}
              className={item.active ? "navigation-item is-active" : "navigation-item"}
              type="button"
              aria-current={item.active ? "page" : undefined}
              disabled
            >
              <NavigationIcon size={25} weight={item.active ? "fill" : "regular"} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="account">
        <UserCircle className="account-avatar" size={42} weight="thin" />
        <div className="account-details">
          <strong>Alex Chen</strong>
          <span>Acme Corp</span>
        </div>
        <CaretDown className="account-caret" size={17} weight="bold" />
      </div>
    </aside>
  );
}

function SectionHeading(props: {
  readonly title: string;
  readonly badge?: number;
  readonly action?: string;
}) {
  return (
    <header className="section-heading">
      <div className="section-title-row">
        <h2>{props.title}</h2>
        {props.badge === undefined ? null : <span className="count-badge">{props.badge}</span>}
      </div>
      {props.action === undefined ? null : (
        <button className="text-action" type="button" disabled>
          {props.action}
        </button>
      )}
    </header>
  );
}

function MissionCard(props: { readonly mission: (typeof missions)[number] }) {
  return (
    <article className={`mission-card mission-card--${props.mission.statusTone}`}>
      <div className="mission-meta">
        <span className="mission-status">
          <span className="status-dot" aria-hidden="true" />
          {props.mission.status}
        </span>
        <span>{props.mission.time}</span>
      </div>
      <h3>{props.mission.title}</h3>
      <span className="agent-tag">{props.mission.agent}</span>
    </article>
  );
}

function NeedsYou() {
  return (
    <section className="needs-you-section">
      <SectionHeading title="Needs You" badge={2} />
      <div className="request-list">
        {requests.map((request) => {
          const RequestIcon = request.icon;

          return (
            <article className="request-row" key={request.title}>
              <span className="request-icon" aria-hidden="true">
                <RequestIcon size={18} weight="regular" />
              </span>
              <div className="request-copy">
                <h3>{request.title}</h3>
                <p>{request.description}</p>
                <span className="request-mission">Mission: {request.mission}</span>
              </div>
              <button className="review-button" type="button" disabled>
                Review
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function RecentArtifacts() {
  return (
    <section className="artifacts-section">
      <SectionHeading title="Recent Artifacts" action="View all" />
      <div className="artifact-list">
        {artifacts.map((artifact) => {
          const ArtifactIcon = artifact.icon;

          return (
            <article className="artifact-card" key={artifact.name}>
              <ArtifactIcon className="artifact-icon" size={27} weight="regular" />
              <div>
                <h3>{artifact.name}</h3>
                <span>{artifact.kind}</span>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function App() {
  return (
    <main className="desktop-shell">
      <Sidebar />

      <section className="home-page">
        <section className="continue-section">
          <SectionHeading title="Continue Working" action="View all missions" />
          <div className="mission-grid">
            {missions.map((mission) => (
              <MissionCard key={mission.title} mission={mission} />
            ))}
          </div>
        </section>

        <div className="dashboard-grid">
          <NeedsYou />
          <RecentArtifacts />
        </div>
      </section>
    </main>
  );
}
