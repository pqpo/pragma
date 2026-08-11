import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpertAvatarPicker } from "./ExpertAvatarPicker.tsx";

describe("ExpertAvatarPicker", () => {
  it("shows every named persona with the larger picker avatar size", () => {
    const html = renderToStaticMarkup(
      <ExpertAvatarPicker
        value="pragma.avatar.expert.01"
        onChange={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html.match(/role="option"/g)).toHaveLength(27);
    expect(html.match(/pragma-avatar-picker/g)).toHaveLength(27);
    expect(html).toContain('aria-label="Choose Zara"');
    expect(html).toContain('aria-label="Choose Tom"');
  });
});
