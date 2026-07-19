import { createHash } from "node:crypto";
import { dirname } from "node:path";

import {
  createPragma,
  ExpertAgentHumanRequestSchema,
  type Expert,
  type ExpertAgentHumanRequest,
  type ExpertSession,
  type ExpertTurn,
  type PragmaApp,
  type RuntimeResolver,
} from "@pragma/core";
import {
  loadPragmaProject,
  type PragmaAdapterHost,
  type PragmaBindingRecord,
} from "@pragma/interpreter";

import { BUILT_IN_STEWARD_REF, materializeBuiltInSteward } from "./builtin.ts";
import {
  StewardChatSnapshotSchema,
  StewardInteractionSchema,
  StewardSessionStateSchema,
  type PromptSteward,
  type RespondStewardInteraction,
  type StewardChatSnapshot,
  type StewardInteraction,
  type StewardSessionState,
} from "./contracts.ts";
import {
  mergeStewardChatEntries,
  toStewardChatEntries,
  toStewardHumanResponseEntries,
} from "./chat-history.ts";
import { toExpertHumanResponse, toStewardHumanRequest } from "./human-interaction.ts";
import type { StewardDslProjectPort, StewardStateRepository, StewardTaskPort } from "./ports.ts";
import { listAllRootSessionEvents } from "./session-events.ts";
import { createStewardTools } from "./tools.ts";

export interface StewardService {
  getState(): Promise<StewardSessionState | undefined>;
  initialize(runtimeId: string): Promise<StewardSessionState>;
  prompt(input: PromptSteward): Promise<StewardSessionState>;
  getChat(): Promise<StewardChatSnapshot>;
  listInteractions(): Promise<StewardInteraction[]>;
  respond(input: RespondStewardInteraction): Promise<void>;
  interrupt(): Promise<StewardSessionState>;
  reset(): Promise<void>;
}

export function createStewardService(options: {
  readonly pragmaHome: string;
  readonly workspace: string;
  readonly definitionStateRoot: string;
  readonly runtimes: RuntimeResolver;
  readonly project: StewardDslProjectPort;
  readonly tasks: StewardTaskPort;
  readonly state: StewardStateRepository;
  readonly app?: PragmaApp | undefined;
}): StewardService {
  const app =
    options.app ?? createPragma({ pragmaHome: options.pragmaHome, runtimes: options.runtimes });
  const tools = createStewardTools({ project: options.project, tasks: options.tasks });
  let session: ExpertSession | undefined;
  let activeTurn: ExpertTurn | undefined;
  let initialization: Promise<ExpertSession> | undefined;

  const compile = async (): Promise<Expert> => {
    const entry = await materializeBuiltInSteward(options.definitionStateRoot);
    const project = await loadPragmaProject(entry, { rootDir: dirname(entry) });
    const compiled = await project.compile<Expert>(BUILT_IN_STEWARD_REF, {
      workspace: options.workspace,
      pragmaHome: options.pragmaHome,
      environmentId: "steward",
      runtimes: options.runtimes,
      adapterHost: stewardAdapterHost(dirname(entry), tools),
    });
    return compiled.value;
  };

  const requireSession = async (): Promise<ExpertSession> => {
    if (session !== undefined) return session;
    if (initialization !== undefined) return await initialization;
    initialization = (async () => {
      const state = await options.state.get();
      if (state === undefined) throw new Error("Initialize the Steward before sending a message.");
      const expert = await compile();
      const restored = await app.experts.resumeSession(expert, { sessionId: state.sessionId });
      session = restored;
      return restored;
    })().finally(() => {
      initialization = undefined;
    });
    return await initialization;
  };

  const updateStatus = async (
    status: StewardSessionState["status"],
    modelSelection?: PromptSteward["modelSelection"],
  ): Promise<StewardSessionState> => {
    const current = await options.state.get();
    if (current === undefined) throw new Error("Steward state is unavailable.");
    const next = StewardSessionStateSchema.parse({
      ...current,
      status,
      ...(modelSelection === undefined ? {} : { modelSelection }),
      updatedAt: new Date().toISOString(),
    });
    await options.state.put(next);
    return next;
  };

  return {
    async getState() {
      const current = await options.state.get();
      if (current === undefined || session === undefined) return current;
      const core = await session.getState();
      const status =
        core.activeExecutionId === undefined
          ? core.lastStatus === "failed"
            ? "failed"
            : "idle"
          : "running";
      return status === current.status ? current : await updateStatus(status);
    },
    async initialize(runtimeId) {
      const existing = await options.state.get();
      if (existing !== undefined) {
        await requireSession();
        return existing;
      }
      const expert = await compile();
      session = await app.experts.createSession(expert, { runtime: runtimeId });
      const now = new Date().toISOString();
      const state = StewardSessionStateSchema.parse({
        schemaVersion: "pragma.steward-state/v1",
        sessionId: session.sessionId,
        runtimeId,
        status: "idle",
        workspace: options.workspace,
        createdAt: now,
        updatedAt: now,
      });
      await options.state.put(state);
      return state;
    },
    async prompt(input) {
      const currentSession = await requireSession();
      const current = await options.state.get();
      if (current?.status === "running" || current?.status === "waiting") {
        throw new Error("Wait for or interrupt the current Steward turn.");
      }
      const content =
        input.taskWorkspaceId === undefined
          ? input.content
          : [
              "[Pragma Home context]",
              `Selected task workspace: ${input.taskWorkspaceId}`,
              "[/Pragma Home context]",
              "",
              input.content,
            ].join("\n");
      activeTurn = await currentSession.prompt(content, {
        requestId: input.requestId,
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
      });
      const running = await updateStatus("running", input.modelSelection);
      void activeTurn.result.then(
        async () => {
          if (activeTurn?.requestId === input.requestId) activeTurn = undefined;
          await updateStatus("idle");
        },
        async () => {
          if (activeTurn?.requestId === input.requestId) activeTurn = undefined;
          await updateStatus("failed");
        },
      );
      return running;
    },
    async getChat() {
      const state = await options.state.get();
      if (state === undefined) return { state: null, entries: [] };
      const currentSession = await requireSession();
      const resolvedState = await this.getState();
      const [histories, events] = await Promise.all([
        currentSession.getMessageHistory({ scope: { kind: "root" } }),
        listAllRootSessionEvents(currentSession),
      ]);
      const entries = mergeStewardChatEntries(
        toStewardChatEntries(histories),
        toStewardHumanResponseEntries(events),
      );
      return StewardChatSnapshotSchema.parse({ state: resolvedState, entries });
    },
    async listInteractions() {
      const currentSession = await requireSession();
      const turns = await currentSession.listTurns();
      const interactions: StewardInteraction[] = [];
      for (const turn of turns) interactions.push(...(await pendingInteractions(turn)));
      if (interactions.length > 0) await updateStatus("waiting");
      return StewardInteractionSchema.array().parse(interactions);
    },
    async respond(input) {
      const currentSession = await requireSession();
      const turns = await currentSession.listTurns();
      for (const turn of turns.toReversed()) {
        const request = await findRequest(turn, input.interactionId);
        if (request === undefined) continue;
        await turn.respondToHumanInteraction(
          input.interactionId,
          toExpertHumanResponse(request, input.response),
          { requestId: input.requestId },
        );
        await updateStatus("running");
        return;
      }
      throw new Error(`Steward interaction not found: ${input.interactionId}`);
    },
    async interrupt() {
      const currentSession = await requireSession();
      await currentSession.abort("Interrupted by the user.");
      activeTurn = undefined;
      return await updateStatus("idle");
    },
    async reset() {
      if (session !== undefined) await session.close("Steward session reset.");
      session = undefined;
      activeTurn = undefined;
      await options.state.clear();
    },
  };
}

function stewardAdapterHost(
  projectRoot: string,
  tools: ReturnType<typeof createStewardTools>,
): PragmaAdapterHost {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        tools.map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          approval: tool.approval?.mode,
        })),
      ),
    )
    .digest("hex");
  return {
    environmentId: "steward",
    projectRoot,
    async resolveBinding(ref): Promise<PragmaBindingRecord | undefined> {
      return ref === "binding:pragma.steward-host"
        ? { ref, revision: "1", fingerprint, value: { contribution: { tools } } }
        : undefined;
    },
    async resolveArtifact(source) {
      throw new Error(`Unexpected external Steward artifact: ${JSON.stringify(source)}`);
    },
    async resolveSecret() {
      return undefined;
    },
  };
}

async function pendingInteractions(turn: ExpertTurn): Promise<StewardInteraction[]> {
  const events = (await turn.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => String((event.data as { interactionId?: unknown }).interactionId)),
  );
  return events.flatMap((event) => {
    if (event.type !== "human.requested") return [];
    const data = event.data as { interactionId?: unknown; request?: unknown };
    const interactionId = String(data.interactionId ?? "");
    if (interactionId === "" || responded.has(interactionId)) return [];
    const request = ExpertAgentHumanRequestSchema.safeParse(data.request);
    if (!request.success) return [];
    return [
      {
        interactionId,
        request: toStewardHumanRequest(request.data),
      },
    ];
  });
}

async function findRequest(
  turn: ExpertTurn,
  interactionId: string,
): Promise<ExpertAgentHumanRequest | undefined> {
  const events = (await turn.listEvents({ scope: { kind: "all" }, limit: 1_000 })).items;
  const event = events.find(
    (candidate) =>
      candidate.type === "human.requested" &&
      (candidate.data as { interactionId?: unknown }).interactionId === interactionId,
  );
  return event === undefined
    ? undefined
    : ExpertAgentHumanRequestSchema.parse((event.data as { request?: unknown }).request);
}
