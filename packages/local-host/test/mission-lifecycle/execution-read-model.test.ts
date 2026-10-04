import { RuntimeContextCompactionNotNeededError, type ExpertSession } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";
import {
  compactExpertSessionContext,
  listPendingHumanInteractions,
  mergeMissionExecutorMetadata,
  missionProjectionAddsUserVisibleOutput,
  toDesktopHumanRequest,
} from "../../src/missions/execution-service.ts";

describe("Local Host execution read model", () => {
  it("does not project the first askUserQuestion item into prompt for a multi-question request", () => {
    const request = toDesktopHumanRequest({
      kind: "user_question",
      toolName: "askUserQuestion",
      questions: Array.from({ length: 5 }, (_, index) => ({
        header: `Question ${index + 1}`,
        question: `What should we decide for question ${index + 1}?`,
        kind: "single_choice" as const,
        options: [{ label: "Continue", description: "Continue with this choice." }],
      })),
    });

    expect(request).toMatchObject({ kind: "question", questions: expect.any(Array) });
    expect(request.questions).toHaveLength(5);
    expect(request.title).toBeUndefined();
    expect(request.prompt).toBeUndefined();
  });

  it("does not return a pending human request that raced with a terminal transition", async () => {
    const getState = vi
      .fn()
      .mockResolvedValueOnce({ status: "waiting" })
      .mockResolvedValueOnce({ status: "interrupted" });
    const request = {
      kind: "user_question" as const,
      toolName: "askUserQuestion" as const,
      toolCallId: "racing-question",
      questions: [
        {
          question: "Continue?",
          header: "Continue",
          kind: "single_choice" as const,
          options: [{ label: "yes", description: "Continue." }],
        },
      ],
    };

    await expect(
      listPendingHumanInteractions({
        getState: getState as never,
        listEvents: (async () => ({
          items: [
            {
              type: "human.requested",
              data: { interactionId: "pending-question", request },
            } as never,
          ],
        })) as never,
      }),
    ).resolves.toEqual([]);
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it("merges system Expert names and avatars into Mission presentation metadata", () => {
    const metadata = mergeMissionExecutorMetadata(
      {
        names: new Map([["project-expert", "Project Expert"]]),
        avatarIds: new Map([["project-expert", "pragma.avatar.expert.01"]]),
      },
      [
        {
          id: "0000000000st0rev",
          name: "Store Revision Agent",
          avatarId: "pragma.avatar.expert.22",
        },
      ],
    );

    expect(metadata.names.get("0000000000st0rev")).toBe("Store Revision Agent");
    expect(metadata.avatarIds.get("0000000000st0rev")).toBe("pragma.avatar.expert.22");
    expect(metadata.names.get("project-expert")).toBe("Project Expert");
  });

  it("marks projection invalidations only when repair reveals new visible output", () => {
    const answer = {
      id: "answer",
      kind: "assistant" as const,
      content: "Answer",
      streaming: true,
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    const thinking = {
      id: "thinking",
      kind: "thinking" as const,
      content: "Reasoning",
      streaming: false,
      createdAt: "2026-08-24T00:00:01.000Z",
    };

    expect(
      missionProjectionAddsUserVisibleOutput(
        [answer, thinking],
        [thinking, { ...answer, streaming: false }],
      ),
    ).toBe(false);
    expect(missionProjectionAddsUserVisibleOutput([answer], [answer, thinking])).toBe(true);
    expect(
      missionProjectionAddsUserVisibleOutput(
        [answer],
        [{ ...answer, content: "Answer with recovered suffix" }],
      ),
    ).toBe(true);
  });

  it("treats a restored Runtime with no compactable history as a normal no-op", async () => {
    const session = {
      canCompactRootContext: vi.fn(async () => undefined),
      compactRootContext: vi.fn(async () => {
        throw new RuntimeContextCompactionNotNeededError();
      }),
    } satisfies Pick<ExpertSession, "canCompactRootContext" | "compactRootContext">;

    await expect(compactExpertSessionContext(session)).resolves.toEqual({
      outcome: "not_needed",
    });
    expect(session.compactRootContext).toHaveBeenCalledOnce();
  });
});
