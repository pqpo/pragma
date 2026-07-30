import type { PostCompactHookInput, PreCompactHookInput } from "@qoder-ai/qoder-agent-sdk";
import { describe, expect, it, vi } from "vitest";

import { createQoderCompactionHooks } from "../src/session.ts";

describe("Qoder compaction hooks", () => {
  it("reports both automatic compaction lifecycle boundaries", async () => {
    const onPreCompact = vi.fn();
    const onPostCompact = vi.fn();
    const hooks = createQoderCompactionHooks({ onPreCompact, onPostCompact });
    const before = {
      hook_event_name: "PreCompact",
      trigger: "auto",
    } as PreCompactHookInput;
    const after = {
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "summary",
    } as PostCompactHookInput;

    await hooks.PreCompact[0]!.hooks[0]!(before);
    await hooks.PostCompact[0]!.hooks[0]!(after);

    expect(onPreCompact).toHaveBeenCalledWith(before);
    expect(onPostCompact).toHaveBeenCalledWith(after);
  });
});
