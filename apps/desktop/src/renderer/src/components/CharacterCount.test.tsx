import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CharacterCount } from "./CharacterCount.tsx";

describe("CharacterCount", () => {
  it("shows the trimmed Unicode character count and limit", () => {
    expect(renderToStaticMarkup(<CharacterCount value="  知😀  " max={50} />)).toContain(
      ">2/50</small>",
    );
  });
});
