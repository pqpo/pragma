import { HealthPanel } from "./health-panel";

export default function HomePage() {
  return (
    <main className="shell">
      <section className="status">
        <p className="eyebrow">Phase 0 Harness</p>
        <h1>ExpertMesh Web Ready</h1>
        <HealthPanel />
      </section>
    </main>
  );
}
