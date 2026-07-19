import type { ExpertSession, SessionEventCursor, SessionEventPage } from "@pragma/core";

export async function listAllRootSessionEvents(
  session: Pick<ExpertSession, "listEvents">,
): Promise<SessionEventPage["items"]> {
  const items: Array<SessionEventPage["items"][number]> = [];
  let after: SessionEventCursor | undefined;

  do {
    const page = await session.listEvents({
      scope: { kind: "root" },
      limit: 1_000,
      ...(after === undefined ? {} : { after }),
    });
    items.push(...page.items);
    after = page.nextCursor;
  } while (after !== undefined);

  return items;
}
