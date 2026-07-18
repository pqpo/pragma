import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StewardInteractionCard, stewardAnswerValid } from "./StewardInteractionCard.tsx";

describe("StewardInteractionCard", () => {
  it("renders an askUserQuestion choice with its descriptions", () => {
    const html = renderToStaticMarkup(
      <StewardInteractionCard
        interaction={{
          interactionId: "interaction-1",
          request: {
            kind: "question",
            title: "Expert details",
            prompt: "I need one decision before preparing the DSL.",
            questions: [
              {
                header: "Role",
                question: "Which Expert should I create?",
                kind: "single_choice",
                options: [
                  { label: "Researcher", description: "Research and synthesize" },
                  { label: "Reviewer", description: "Review existing work" },
                ],
              },
            ],
          },
        }}
        responding={false}
        onRespond={() => undefined}
      />,
    );

    expect(html).toContain("Your input is needed");
    expect(html).toContain("Which Expert should I create?");
    expect(html).toContain("Research and synthesize");
    expect(html).toContain("Submit response");
  });

  it("requires meaningful answers for every supported question kind", () => {
    const base: {
      header: string;
      options: { label: string; description: string }[];
    } = { header: "Question", options: [] };
    expect(
      stewardAnswerValid({ ...base, question: "Text?", kind: "text" }, "  useful answer  "),
    ).toBe(true);
    expect(stewardAnswerValid({ ...base, question: "Text?", kind: "text" }, "  ")).toBe(false);
    expect(
      stewardAnswerValid(
        {
          ...base,
          question: "Choose?",
          kind: "multiple_choice",
          options: [{ label: "One", description: "" }],
        },
        ["One"],
      ),
    ).toBe(true);
    expect(stewardAnswerValid({ ...base, question: "Choose?", kind: "multiple_choice" }, [])).toBe(
      false,
    );
  });
});
