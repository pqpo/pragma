import type { MissionCommand } from "@pragma/shared/integration";

export type MissionCommandKind = MissionCommand["payload"]["kind"];

export type MissionCommandOfKind<Kind extends MissionCommandKind> = Omit<
  MissionCommand,
  "kind" | "payload"
> & {
  readonly kind: Kind;
  readonly payload: Extract<MissionCommand["payload"], { readonly kind: Kind }>;
};

export type MissionCommandHandler<Kind extends MissionCommandKind> = (
  command: MissionCommandOfKind<Kind>,
) => Promise<Record<string, unknown>>;

export type MissionCommandHandlers = {
  readonly [Kind in MissionCommandKind]: MissionCommandHandler<Kind>;
};

/**
 * The only dispatch table for durable Mission commands. Hosts implement the
 * lower-level operations but cannot choose a different routing rule based on
 * which process currently owns the Mission lease.
 */
export async function dispatchMissionCommand(
  command: MissionCommand,
  handlers: MissionCommandHandlers,
): Promise<Record<string, unknown>> {
  const kind = command.payload.kind;
  const handler = handlers[kind] as MissionCommandHandler<typeof kind>;
  return await handler(command as MissionCommandOfKind<typeof kind>);
}
