import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MissionExecutorOption } from "../../../shared/contracts/index.ts";
import { DateTimePicker } from "./DateTimePicker.tsx";
import { MissionExecutorPicker } from "./MissionExecutorPicker.tsx";
import { Switch } from "./Switch.tsx";

const flow: MissionExecutorOption = {
  kind: "flow",
  ref: "flow:3sfd30h5017wd17d",
  name: "Issue review",
  description: "Reviews an issue",
  origin: "project",
  readOnly: false,
  customized: false,
};

describe("Automation controls", () => {
  it("keeps the executor picker empty until the user selects a resource", () => {
    const html = renderToStaticMarkup(
      <MissionExecutorPicker executors={[flow]} value="" onChange={() => undefined} />,
    );

    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("Choose an expert, team, or flow");
    expect(html).not.toContain("Issue review");
  });

  it("renders selected executor copy in the shared trigger", () => {
    const html = renderToStaticMarkup(
      <MissionExecutorPicker executors={[flow]} value={flow.ref} onChange={() => undefined} />,
    );

    expect(html).toContain("Issue review");
    expect(html).toContain("Flow · Reviews an issue");
  });

  it("uses product controls instead of native date-time and checkbox UI", () => {
    const html = renderToStaticMarkup(
      <>
        <DateTimePicker label="Run at" value="2026-07-24T09:30" onChange={() => undefined} />
        <Switch checked ariaLabel="Enabled" onChange={() => undefined} />
      </>,
    );

    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('type="datetime-local"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
  });
});
