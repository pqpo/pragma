import {
  ExpertAgentHumanRequestSchema,
  type AgentMessageUsage,
  type ExecutionEvent,
  type ExecutionEventSubscription,
  type ExecutionOutputItem,
  type ExpertAgentHumanRequest,
  type ExpertAgentUserQuestion,
  type Flow,
  type FlowExecution,
  type FlowSpec,
  type InvocationMessageHistory,
} from "@pragma/core";
import {
  Input,
  Key,
  matchesKey,
  ProcessTerminal,
  truncateToWidth,
  TUI,
  type Component,
  type Focusable,
  type Terminal,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

type InvocationTree = Awaited<ReturnType<FlowExecution["getTree"]>>;
type Invocation = InvocationTree["invocation"];

export type FlowConsoleStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting-human"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

export type FlowConsoleViewMode = "activity" | "input" | "output";

export interface FlowConsoleActivity {
  readonly kind: "answer" | "progress" | "thinking" | "tool" | "tool-output";
  readonly source?: string | undefined;
  text: string;
}

export interface FlowConsoleVisit {
  readonly invocationId: string;
  readonly activity: FlowConsoleActivity[];
  agentId?: string | undefined;
  contextId?: string | undefined;
  resolver?: string | undefined;
  disposition?: "created" | "reused" | undefined;
  status: FlowConsoleStatus;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  usage?: AgentMessageUsage | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface FlowConsoleNode {
  readonly key: string;
  readonly nodeId?: string | undefined;
  readonly parentKey?: string | undefined;
  readonly kind: string;
  readonly label: string;
  readonly branchLabels: readonly string[];
  readonly children: string[];
  readonly activity: FlowConsoleActivity[];
  readonly visits: FlowConsoleVisit[];
  status: FlowConsoleStatus;
  expanded: boolean;
  invocationId?: string | undefined;
  agentId?: string | undefined;
  contextId?: string | undefined;
  resolver?: string | undefined;
  disposition?: "created" | "reused" | undefined;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  usage?: AgentMessageUsage | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  magenta: "\u001B[35m",
  inverse: "\u001B[7m",
} as const;

const MAX_ACTIVITY_CHARACTERS = 200_000;
const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const MIN_TERMINAL_WIDTH = 70;
const MIN_TERMINAL_HEIGHT = 20;

export class FlowConsoleModel {
  readonly flow: Flow;
  readonly nodes = new Map<string, FlowConsoleNode>();
  readonly stepOrder: readonly string[];
  executionId: string | undefined;
  executionStatus: FlowConsoleStatus = "pending";
  usage: AgentMessageUsage | undefined;
  viewMode: FlowConsoleViewMode = "activity";
  scrollOffset = 0;
  notice: string | undefined;
  private selectedKey: string;
  private readonly invocationKeys = new Map<string, Set<string>>();
  private readonly invocationVisitByNode = new Map<string, Map<string, string>>();
  private readonly toolSnapshots = new Map<string, string>();
  private readonly invocationsWithAnswerDeltas = new Set<string>();

  constructor(definition: FlowSpec | Flow) {
    this.flow = "compile" in definition ? definition.compile() : definition;
    const branchLabels = collectBranchLabels(this.flow);
    this.stepOrder = [...this.flow.steps.keys()].map((nodeId) => stepKey(nodeId));
    for (const step of this.flow.steps.values()) {
      const key = stepKey(step.id);
      this.nodes.set(key, {
        key,
        nodeId: step.id,
        kind: definitionKind(step.definition),
        label: definitionLabel(step.definition, step.id),
        branchLabels: branchLabels.get(step.id) ?? [],
        children: [],
        activity: [],
        visits: [],
        status: "pending",
        expanded: definitionKind(step.definition) === "expert-team",
      });
    }
    this.selectedKey = stepKey(this.flow.startStepId);
  }

  get selected(): FlowConsoleNode {
    return this.nodes.get(this.selectedKey) ?? this.nodes.get(this.stepOrder[0]!)!;
  }

  get visibleNodes(): readonly FlowConsoleNode[] {
    const result: FlowConsoleNode[] = [];
    const visit = (key: string) => {
      const node = this.nodes.get(key);
      if (node === undefined) return;
      result.push(node);
      if (node.expanded) for (const child of node.children) visit(child);
    };
    for (const key of this.stepOrder) visit(key);
    return result;
  }

  setExecution(executionId: string): void {
    this.executionId = executionId;
  }

  syncTree(tree: InvocationTree): void {
    for (const child of tree.children) this.syncInvocationTree(child, undefined);
    this.markSkippedRoutes();
  }

  syncExecution(input: {
    readonly status: Invocation["status"];
    readonly usage?: AgentMessageUsage | undefined;
  }): void {
    this.executionStatus = mapStatus(input.status);
    this.usage = input.usage;
    if (isTerminalStatus(this.executionStatus)) {
      for (const node of this.nodes.values()) {
        if (node.parentKey === undefined && node.status === "pending") node.status = "skipped";
      }
    }
  }

  consumeOutput(item: ExecutionOutputItem): void {
    const keys = this.invocationKeys.get(item.invocationId);
    if (keys === undefined) return;
    for (const key of keys) {
      const node = this.nodes.get(key);
      if (node === undefined) continue;
      switch (item.channel) {
        case "thought": {
          const text = item.delta ?? formatValue(item.value);
          if (text !== undefined)
            this.append(
              node,
              "thinking",
              text,
              true,
              item.executorId,
              this.visitId(item.invocationId, key),
            );
          break;
        }
        case "message": {
          if (item.delta !== undefined) {
            this.invocationsWithAnswerDeltas.add(item.invocationId);
            this.append(
              node,
              "answer",
              item.delta,
              true,
              item.executorId,
              this.visitId(item.invocationId, key),
            );
          } else if (!this.invocationsWithAnswerDeltas.has(item.invocationId)) {
            const text = readCompletedMessageText(item.value);
            if (text !== undefined)
              this.append(
                node,
                "answer",
                text,
                false,
                item.executorId,
                this.visitId(item.invocationId, key),
              );
          }
          break;
        }
        case "tool":
          this.consumeTool(node, item, item.executorId, this.visitId(item.invocationId, key));
          break;
        case "progress": {
          const text = formatProgress(item.value);
          if (text !== undefined)
            this.append(
              node,
              "progress",
              text,
              false,
              item.executorId,
              this.visitId(item.invocationId, key),
            );
          break;
        }
        case "result": {
          const text = formatValue(item.value);
          if (text !== undefined && !this.invocationsWithAnswerDeltas.has(item.invocationId)) {
            this.append(
              node,
              "answer",
              text,
              false,
              item.executorId,
              this.visitId(item.invocationId, key),
            );
          }
          break;
        }
      }
    }
    this.scrollOffset = 0;
  }

  consumeEvent(event: ExecutionEvent): void {
    if (event.type === "invocation.progress") {
      const keys = this.invocationKeys.get(event.invocationId);
      const text = formatProgress(asRecord(event.data)["value"]);
      if (keys !== undefined && text !== undefined) {
        for (const key of keys) {
          const node = this.nodes.get(key);
          if (node !== undefined)
            this.append(
              node,
              "progress",
              text,
              false,
              undefined,
              this.visitId(event.invocationId, key),
            );
        }
      }
    }
    if (event.type === "human.requested") this.markWaitingHuman(event.invocationId, true);
  }

  hydrateMessageHistory(histories: readonly InvocationMessageHistory[]): void {
    for (const history of histories) {
      const keys = this.invocationKeys.get(history.invocationId);
      if (keys === undefined) continue;
      for (const key of keys) {
        const node = this.nodes.get(key);
        if (node === undefined) continue;
        const visitId = this.visitId(history.invocationId, key);
        const visit = node.visits.find((candidate) => candidate.invocationId === visitId);
        const hasActivity = (kind: FlowConsoleActivity["kind"]): boolean =>
          (visit?.activity ?? node.activity).some(
            (item) => item.kind === kind && item.source === history.executorId,
          );
        for (const record of history.messages) {
          const message = record.message;
          if (message.role === "assistant") {
            for (const content of message.content) {
              if (content.type === "thinking" && !hasActivity("thinking")) {
                this.append(node, "thinking", content.thinking, false, history.executorId, visitId);
              } else if (content.type === "text" && !hasActivity("answer")) {
                this.append(node, "answer", content.text, false, history.executorId, visitId);
              } else if (content.type === "toolCall" && !hasActivity("tool")) {
                this.append(
                  node,
                  "tool",
                  `→ ${content.name}\n${JSON.stringify(content.arguments, null, 2)}`,
                  false,
                  history.executorId,
                  visitId,
                );
              }
            }
          } else if (message.role === "toolResult" && !hasActivity("tool-output")) {
            const text = message.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n");
            if (text !== "") {
              this.append(node, "tool-output", text, false, history.executorId, visitId);
            }
          }
        }
      }
    }
  }

  markWaitingHuman(invocationId: string, waiting: boolean): void {
    for (const key of this.invocationKeys.get(invocationId) ?? []) {
      const node = this.nodes.get(key);
      if (node !== undefined) {
        node.status = waiting ? "waiting-human" : "running";
        const visitId = this.visitId(invocationId, key);
        const visit = node.visits.find((candidate) => candidate.invocationId === visitId);
        if (visit !== undefined) visit.status = node.status;
      }
    }
  }

  focusInvocation(invocationId: string): void {
    const key = [...(this.invocationKeys.get(invocationId) ?? [])].find(
      (candidate) => this.nodes.get(candidate)?.parentKey === undefined,
    );
    if (key === undefined) return;
    this.selectedKey = key;
    this.viewMode = "input";
    this.scrollOffset = 0;
  }

  moveSelection(direction: 1 | -1): void {
    const visible = this.visibleNodes;
    const current = Math.max(
      0,
      visible.findIndex((node) => node.key === this.selectedKey),
    );
    const next = Math.max(0, Math.min(visible.length - 1, current + direction));
    this.selectedKey = visible[next]?.key ?? this.selectedKey;
    this.scrollOffset = 0;
  }

  toggleSelected(): void {
    if (this.selected.children.length === 0) return;
    this.selected.expanded = !this.selected.expanded;
  }

  cycleView(direction: 1 | -1): void {
    const modes: readonly FlowConsoleViewMode[] = ["activity", "input", "output"];
    const current = modes.indexOf(this.viewMode);
    this.viewMode = modes[(current + direction + modes.length) % modes.length]!;
    this.scrollOffset = 0;
  }

  scroll(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + lines);
  }

  fail(error: unknown): void {
    this.executionStatus = "failed";
    this.notice = error instanceof Error ? error.message : String(error);
  }

  private syncInvocationTree(tree: InvocationTree, parentKey: string | undefined): void {
    const invocation = tree.invocation;
    const staticKey = invocation.nodeId === undefined ? undefined : stepKey(invocation.nodeId);
    let key = staticKey !== undefined && this.nodes.has(staticKey) ? staticKey : undefined;
    if (key === undefined) key = this.ensureDynamicNode(invocation, parentKey);
    const node = this.nodes.get(key)!;
    this.applyInvocation(node, invocation);

    let childrenParentKey = key;
    if (invocation.definition.kind === "expert-team" && staticKey !== undefined) {
      const coordinatorKey = `${staticKey}:coordinator`;
      let coordinator = this.nodes.get(coordinatorKey);
      if (coordinator === undefined) {
        coordinator = {
          key: coordinatorKey,
          parentKey: staticKey,
          kind: "coordinator",
          label: invocation.executorId ?? invocation.definition.id,
          branchLabels: [],
          children: [],
          activity: [],
          visits: [],
          status: "pending",
          expanded: true,
        };
        this.nodes.set(coordinatorKey, coordinator);
        node.children.unshift(coordinatorKey);
      }
      this.applyInvocation(coordinator, invocation);
      this.bindInvocation(invocation.invocationId, coordinatorKey, invocation.invocationId);
      childrenParentKey = staticKey;
    }
    this.bindInvocation(invocation.invocationId, key, invocation.invocationId);
    if (parentKey !== undefined && this.nodes.get(parentKey)?.kind === "expert-team") {
      this.bindInvocation(
        invocation.invocationId,
        parentKey,
        this.nodes.get(parentKey)?.invocationId ?? invocation.invocationId,
      );
    }
    for (const child of tree.children) this.syncInvocationTree(child, childrenParentKey);
  }

  private ensureDynamicNode(invocation: Invocation, parentKey: string | undefined): string {
    const key = `invocation:${invocation.invocationId}`;
    if (!this.nodes.has(key)) {
      const node: FlowConsoleNode = {
        key,
        parentKey,
        kind: invocation.definition.kind === "expert" ? "team-member" : invocation.definition.kind,
        label: invocation.executorId ?? invocation.definition.id,
        branchLabels: [],
        children: [],
        activity: [],
        visits: [],
        status: "pending",
        expanded: true,
      };
      this.nodes.set(key, node);
      const parent = parentKey === undefined ? undefined : this.nodes.get(parentKey);
      if (parent !== undefined && !parent.children.includes(key)) parent.children.push(key);
    }
    return key;
  }

  private applyInvocation(node: FlowConsoleNode, invocation: Invocation): void {
    let visit = node.visits.find((candidate) => candidate.invocationId === invocation.invocationId);
    if (visit === undefined) {
      visit = {
        invocationId: invocation.invocationId,
        activity: [],
        status: mapStatus(invocation.status),
      };
      node.visits.push(visit);
    }
    visit.status = mapStatus(invocation.status);
    visit.agentId = invocation.agentId;
    visit.contextId = invocation.contextId;
    visit.resolver = invocation.contextResolution
      ? `${invocation.contextResolution.resolver.id}@${invocation.contextResolution.resolver.version}`
      : undefined;
    visit.disposition = invocation.contextResolution?.disposition;
    visit.input = invocation.input;
    visit.output = invocation.output;
    visit.error = invocation.error;
    visit.usage = invocation.usage;
    visit.createdAt = invocation.createdAt;
    visit.updatedAt = invocation.updatedAt;
    node.invocationId = invocation.invocationId;
    node.agentId = invocation.agentId;
    node.contextId = invocation.contextId;
    node.resolver = visit.resolver;
    node.disposition = visit.disposition;
    node.status = node.status === "waiting-human" ? "waiting-human" : mapStatus(invocation.status);
    node.input = invocation.input;
    node.output = invocation.output;
    node.error = invocation.error;
    node.usage = invocation.usage;
    node.createdAt = invocation.createdAt;
    node.updatedAt = invocation.updatedAt;
  }

  private bindInvocation(invocationId: string, key: string, visitId: string): void {
    const keys = this.invocationKeys.get(invocationId) ?? new Set<string>();
    keys.add(key);
    this.invocationKeys.set(invocationId, keys);
    const visits = this.invocationVisitByNode.get(invocationId) ?? new Map<string, string>();
    visits.set(key, visitId);
    this.invocationVisitByNode.set(invocationId, visits);
  }

  private visitId(invocationId: string, key: string): string {
    return this.invocationVisitByNode.get(invocationId)?.get(key) ?? invocationId;
  }

  private append(
    node: FlowConsoleNode,
    kind: FlowConsoleActivity["kind"],
    text: string,
    append = false,
    source?: string,
    visitId?: string,
  ): void {
    if (text === "") return;
    appendActivity(node.activity, node.kind, kind, text, append, source);
    const visit = node.visits.find((candidate) => candidate.invocationId === visitId);
    if (visit !== undefined) {
      appendActivity(visit.activity, node.kind, kind, text, append, source);
    }
  }

  private consumeTool(
    node: FlowConsoleNode,
    item: ExecutionOutputItem,
    source: string | undefined,
    visitId: string,
  ): void {
    const payload = asRecord(item.value);
    const toolName = readString(payload, "toolName") || "tool";
    const toolCallId = readString(payload, "toolCallId") || item.invocationId;
    const snapshotKey = `${node.key}:${toolCallId}`;
    if (item.delta !== undefined) {
      const increment = readToolIncrement(this.toolSnapshots, snapshotKey, item.delta);
      if (increment !== undefined)
        this.append(node, "tool-output", increment, true, source, visitId);
      return;
    }
    if (payload["message"] !== undefined) {
      this.append(
        node,
        "tool",
        `× ${toolName}: ${readString(payload, "message")}`,
        false,
        source,
        visitId,
      );
    } else if (payload["approvalId"] !== undefined) {
      this.append(node, "tool", `! ${toolName} requires approval`, false, source, visitId);
    } else if (payload["outputPreview"] !== undefined) {
      this.append(node, "tool", `✓ ${toolName} completed`, false, source, visitId);
      const preview = formatPreview(payload["outputPreview"]);
      if (preview !== undefined) this.append(node, "tool-output", preview, false, source, visitId);
    } else {
      const preview = formatPreview(payload["inputPreview"]);
      this.append(
        node,
        "tool",
        `→ ${toolName}${preview === undefined ? "" : `\n${preview}`}`,
        false,
        source,
        visitId,
      );
    }
  }

  private markSkippedRoutes(): void {
    for (const [nodeId, transition] of this.flow.transitions) {
      if (transition.type !== "route") continue;
      const node = this.nodes.get(stepKey(nodeId));
      if (node?.status !== "succeeded") {
        for (const target of transition.cases.values()) {
          if ("type" in target) continue;
          const candidate = this.nodes.get(stepKey(target.id));
          if (candidate?.status === "skipped" && candidate.invocationId === undefined) {
            candidate.status = "pending";
          }
        }
        continue;
      }
      const output = asRecord(node?.output);
      const selected = transition.cases.get(String(output[transition.field]));
      for (const target of transition.cases.values()) {
        if (target === selected || "type" in target) continue;
        const skipped = this.nodes.get(stepKey(target.id));
        if (skipped?.status === "pending") skipped.status = "skipped";
      }
    }
  }
}

interface QueuedInteraction {
  readonly interactionId: string;
  readonly invocationId: string;
  readonly request: ExpertAgentHumanRequest;
  readonly questions: readonly ExpertAgentUserQuestion[];
  readonly answers: Record<string, string>;
  questionIndex: number;
  optionIndex: number;
  selectedOptions: Set<number>;
  completion?: CompletedInteraction | undefined;
}

interface CompletedInteraction {
  readonly interactionId: string;
  readonly invocationId: string;
  readonly response: unknown;
}

export class FlowInteractionQueue {
  private readonly items: QueuedInteraction[] = [];

  get active(): QueuedInteraction | undefined {
    return this.items[0];
  }

  get size(): number {
    return this.items.length;
  }

  enqueue(input: {
    readonly interactionId: string;
    readonly invocationId: string;
    readonly request: ExpertAgentHumanRequest;
  }): void {
    if (this.items.some((item) => item.interactionId === input.interactionId)) return;
    const questions =
      input.request.kind === "user_question"
        ? input.request.questions
        : [
            {
              header: "Tool approval",
              question: `${input.request.toolName}: ${input.request.reason ?? "Allow this tool?"}`,
              kind: "single_choice" as const,
              options: [
                { label: "Yes", description: "Allow execution" },
                { label: "No", description: "Reject execution" },
              ],
            },
          ];
    this.items.push({
      ...input,
      questions,
      answers: {},
      questionIndex: 0,
      optionIndex: 0,
      selectedOptions: new Set(),
    });
  }

  remove(interactionId: string): string | undefined {
    const index = this.items.findIndex((item) => item.interactionId === interactionId);
    if (index < 0) return undefined;
    return this.items.splice(index, 1)[0]?.invocationId;
  }

  moveOption(direction: 1 | -1): void {
    const active = this.active;
    const question = active?.questions[active.questionIndex];
    if (active === undefined || question === undefined || question.options.length === 0) return;
    active.optionIndex =
      (active.optionIndex + direction + question.options.length) % question.options.length;
  }

  selectNumber(number: number): void {
    const active = this.active;
    const question = active?.questions[active.questionIndex];
    if (
      active === undefined ||
      question === undefined ||
      number < 1 ||
      number > question.options.length
    )
      return;
    active.optionIndex = number - 1;
  }

  toggleOption(): void {
    const active = this.active;
    const question = active?.questions[active.questionIndex];
    if (active === undefined || question?.kind !== "multiple_choice") return;
    if (active.selectedOptions.has(active.optionIndex))
      active.selectedOptions.delete(active.optionIndex);
    else active.selectedOptions.add(active.optionIndex);
  }

  submit(text = ""): CompletedInteraction | string | undefined {
    const active = this.active;
    if (active?.completion !== undefined) return active.completion;
    const question = active?.questions[active.questionIndex];
    if (active === undefined || question === undefined) return undefined;
    let answer: string;
    if (question.kind === "text") {
      answer = text.trim();
      if (answer === "") return "请输入回答后再提交。";
    } else if (question.kind === "multiple_choice") {
      const indexes = [...active.selectedOptions].sort((left, right) => left - right);
      if (indexes.length === 0) return "请至少选择一个选项。";
      answer = indexes.map((index) => question.options[index]!.label).join(", ");
    } else {
      answer = question.options[active.optionIndex]?.label ?? "";
      if (answer === "") return "请选择一个选项。";
    }
    active.answers[question.question] = answer;
    active.questionIndex += 1;
    active.optionIndex = 0;
    active.selectedOptions.clear();
    if (active.questionIndex < active.questions.length) return undefined;
    active.completion = {
      interactionId: active.interactionId,
      invocationId: active.invocationId,
      response:
        active.request.kind === "tool_approval"
          ? {
              kind: "tool_approval",
              approved: answer.toLocaleLowerCase() === "yes",
              reason: answer.toLocaleLowerCase() === "yes" ? "User approved." : "User rejected.",
            }
          : { kind: "user_question", answered: true, answers: active.answers },
    };
    return active.completion;
  }
}

export interface FlowConsoleTuiOptions {
  readonly definition: FlowSpec | Flow;
  readonly title: string;
  readonly start: () => Promise<FlowExecution>;
  readonly terminal?: Terminal | undefined;
}

export class FlowConsoleTui {
  readonly model: FlowConsoleModel;
  readonly interactions = new FlowInteractionQueue();
  private readonly options: FlowConsoleTuiOptions;
  private readonly terminal: Terminal;
  private readonly tui: TUI;
  private readonly view: FlowConsoleView;
  private readonly handledInteractions = new Set<string>();
  private readonly processedEventIds = new Set<string>();
  private readonly submittingInteractions = new Set<string>();
  private execution: FlowExecution | undefined;
  private events: ExecutionEventSubscription | undefined;
  private output: Awaited<ReturnType<FlowExecution["subscribeOutput"]>> | undefined;
  private followTask: Promise<void> | undefined;
  private exiting = false;
  private resolveExit!: () => void;
  private readonly exitPromise: Promise<void>;

  constructor(options: FlowConsoleTuiOptions) {
    this.options = options;
    this.model = new FlowConsoleModel(options.definition);
    this.terminal = options.terminal ?? new ProcessTerminal();
    this.tui = new TUI(this.terminal, true);
    this.view = new FlowConsoleView({
      model: this.model,
      interactions: this.interactions,
      terminal: this.terminal,
      title: options.title,
      requestRender: () => this.tui.requestRender(),
      handleInput: (data, input) => this.handleInput(data, input),
    });
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  async run(): Promise<void> {
    this.tui.addChild(this.view);
    this.tui.setFocus(this.view);
    this.terminal.setTitle(this.options.title);
    this.tui.start();
    this.followTask = this.startAndFollow();
    return await this.exitPromise;
  }

  private async startAndFollow(): Promise<void> {
    try {
      this.execution = await this.options.start();
      // Startup performs several asynchronous hydration steps before awaiting the result. Observe
      // it immediately so an early failure or cancellation cannot become an unhandled rejection.
      void this.execution.result.catch(() => undefined);
      this.model.setExecution(this.execution.executionId);
      if (this.exiting) {
        await this.execution.cancel("Flow console closed before startup completed.");
        return;
      }
      this.output = await this.execution.subscribeOutput({ scope: { kind: "all" } });
      this.events = await this.execution.subscribeEvents({ scope: { kind: "all" } });
      await this.refresh();
      await this.hydrateEventHistory();
      this.model.hydrateMessageHistory(
        await this.execution.getMessageHistory({ scope: { kind: "all" } }),
      );
      this.tui.requestRender();
      const outputTask = this.followOutput(this.output);
      const eventTask = this.followEvents(this.events);
      const observerTask = Promise.all([outputTask, eventTask]).catch(async (error: unknown) => {
        await this.execution?.cancel("Flow console observer failed.").catch(() => undefined);
        throw error;
      });
      const [result] = await Promise.all([this.execution.result, observerTask]);
      await this.refresh();
      this.model.hydrateMessageHistory(
        await this.execution.getMessageHistory({ scope: { kind: "all" } }),
      );
      this.model.notice = `Flow completed: ${formatPreview(result) ?? "success"}`;
    } catch (error) {
      await this.execution?.cancel("Flow console failed.").catch(() => undefined);
      this.model.fail(error);
    } finally {
      await Promise.all([this.output?.close(), this.events?.close()]);
      this.tui.requestRender();
    }
  }

  private async followOutput(output: NonNullable<FlowConsoleTui["output"]>): Promise<void> {
    for await (const item of output) {
      this.model.consumeOutput(item);
      this.tui.requestRender();
    }
  }

  private async followEvents(events: ExecutionEventSubscription): Promise<void> {
    for await (const event of events) {
      await this.handleEvent(event, true);
    }
  }

  private async hydrateEventHistory(): Promise<void> {
    if (this.execution === undefined) return;
    const history: ExecutionEvent[] = [];
    let after: ExecutionEvent["cursor"] | undefined;
    do {
      const page = await this.execution.listEvents({
        scope: { kind: "all" },
        limit: 1_000,
        ...(after === undefined ? {} : { after }),
      });
      history.push(...page.items);
      after = page.nextCursor;
    } while (after !== undefined);

    const pendingRequestEventIds = new Set(
      findPendingHumanRequestEvents(history).map((event) => event.eventId),
    );
    for (const event of history) {
      if (event.type === "human.requested" && !pendingRequestEventIds.has(event.eventId)) {
        this.processedEventIds.add(event.eventId);
        continue;
      }
      await this.handleEvent(event, false);
    }
  }

  private async handleEvent(event: ExecutionEvent, refresh: boolean): Promise<void> {
    if (this.processedEventIds.has(event.eventId)) return;
    this.processedEventIds.add(event.eventId);
    this.model.consumeEvent(event);
    if (refresh && (event.type.startsWith("invocation.") || event.type.startsWith("execution."))) {
      await this.refresh();
    }
    if (event.type === "human.requested") await this.enqueueInteraction(event);
    if (event.type === "human.responded") {
      const invocationId = this.interactions.remove(
        readString(asRecord(event.data), "interactionId"),
      );
      if (invocationId !== undefined) this.model.markWaitingHuman(invocationId, false);
    }
    this.tui.requestRender();
  }

  private async enqueueInteraction(event: ExecutionEvent): Promise<void> {
    const payload = asRecord(event.data);
    const interactionId = readString(payload, "interactionId");
    if (interactionId === "" || this.handledInteractions.has(interactionId)) return;
    this.handledInteractions.add(interactionId);
    this.interactions.enqueue({
      interactionId,
      invocationId: event.invocationId,
      request: ExpertAgentHumanRequestSchema.parse(payload["request"]),
    });
    this.model.focusInvocation(event.invocationId);
  }

  private handleInput(data: string, input: Input): void {
    if (
      matchesKey(data, Key.ctrl("c")) ||
      (matchesKey(data, "q") && this.interactions.active === undefined)
    ) {
      void this.exit();
      return;
    }
    const interaction = this.interactions.active;
    if (interaction !== undefined) {
      const question = interaction.questions[interaction.questionIndex];
      if (question?.kind !== "text") {
        if (matchesKey(data, Key.up)) this.interactions.moveOption(-1);
        else if (matchesKey(data, Key.down)) this.interactions.moveOption(1);
        else if (matchesKey(data, Key.space)) this.interactions.toggleOption();
        else if (NUMBER_KEYS.some((key) => matchesKey(data, key))) {
          this.interactions.selectNumber(NUMBER_KEYS.findIndex((key) => matchesKey(data, key)) + 1);
        } else if (matchesKey(data, "y") && interaction.request.kind === "tool_approval") {
          this.interactions.selectNumber(1);
          void this.submitInteraction(input);
        } else if (matchesKey(data, "n") && interaction.request.kind === "tool_approval") {
          this.interactions.selectNumber(2);
          void this.submitInteraction(input);
        } else if (matchesKey(data, Key.enter)) void this.submitInteraction(input);
      } else if (matchesKey(data, Key.enter)) {
        void this.submitInteraction(input);
      } else {
        input.handleInput(data);
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up)) this.model.moveSelection(-1);
    else if (matchesKey(data, Key.down)) this.model.moveSelection(1);
    else if (matchesKey(data, Key.left)) this.model.cycleView(-1);
    else if (matchesKey(data, Key.right)) this.model.cycleView(1);
    else if (matchesKey(data, Key.enter)) this.model.toggleSelected();
    else if (matchesKey(data, Key.pageUp))
      this.model.scroll(Math.max(4, Math.floor(this.terminal.rows / 2)));
    else if (matchesKey(data, Key.pageDown))
      this.model.scroll(-Math.max(4, Math.floor(this.terminal.rows / 2)));
    this.tui.requestRender();
  }

  private async submitInteraction(input: Input): Promise<void> {
    const text = input.getValue();
    const result = this.interactions.submit(text);
    if (typeof result === "string") {
      this.model.notice = result;
      return;
    }
    input.setValue("");
    if (result === undefined) return;
    if (this.submittingInteractions.has(result.interactionId)) return;
    this.submittingInteractions.add(result.interactionId);
    this.model.notice = "Submitting response…";
    try {
      await this.execution?.respondToHumanInteraction(result.interactionId, result.response, {
        requestId: `flow-console-${result.interactionId}`,
      });
      this.interactions.remove(result.interactionId);
      this.model.markWaitingHuman(result.invocationId, false);
      this.model.notice = "Response submitted; Flow is continuing.";
    } catch (error) {
      this.model.notice = `Response failed; press Enter to retry: ${errorMessage(error)}`;
    } finally {
      this.submittingInteractions.delete(result.interactionId);
      this.tui.requestRender();
    }
  }

  private async refresh(): Promise<void> {
    if (this.execution === undefined) return;
    const [tree, state] = await Promise.all([this.execution.getTree(), this.execution.getState()]);
    this.model.syncTree(tree);
    this.model.syncExecution(state);
  }

  private async exit(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    if (
      this.execution !== undefined &&
      !["succeeded", "failed", "cancelled"].includes(this.model.executionStatus)
    ) {
      await this.execution.cancel("Flow console closed.").catch(() => undefined);
    }
    await Promise.all([this.output?.close(), this.events?.close()]);
    await this.followTask?.catch(() => undefined);
    this.tui.stop();
    await this.terminal.drainInput(250, 25).catch(() => undefined);
    this.resolveExit();
  }
}

export function findPendingHumanRequestEvents(
  events: readonly ExecutionEvent[],
): readonly ExecutionEvent[] {
  const responded = new Set(
    events
      .filter((event) => event.type === "human.responded")
      .map((event) => readString(asRecord(event.data), "interactionId"))
      .filter((interactionId) => interactionId !== ""),
  );
  return events.filter(
    (event) =>
      event.type === "human.requested" &&
      !responded.has(readString(asRecord(event.data), "interactionId")),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class FlowConsoleView implements Component, Focusable {
  readonly input = new Input();
  private _focused = false;

  constructor(
    private readonly options: {
      readonly model: FlowConsoleModel;
      readonly interactions: FlowInteractionQueue;
      readonly terminal: Terminal;
      readonly title: string;
      readonly requestRender: () => void;
      readonly handleInput: (data: string, input: Input) => void;
    },
  ) {}

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  invalidate(): void {
    this.input.invalidate();
  }

  handleInput(data: string): void {
    this.options.handleInput(data, this.input);
  }

  render(width: number): string[] {
    return renderFlowConsole({
      model: this.options.model,
      interactions: this.options.interactions,
      input: this.input,
      title: this.options.title,
      width,
      height: this.options.terminal.rows,
      color: process.env["NO_COLOR"] === undefined,
    });
  }
}

export function renderFlowConsole(options: {
  readonly model: FlowConsoleModel;
  readonly interactions: FlowInteractionQueue;
  readonly input?: Input | undefined;
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly color?: boolean | undefined;
}): string[] {
  const { model, interactions, title } = options;
  const width = Math.max(1, options.width);
  const height = Math.max(1, options.height);
  const color = options.color ?? false;
  if (width < MIN_TERMINAL_WIDTH || height < MIN_TERMINAL_HEIGHT) {
    const message = `Terminal too small: ${width}x${height}. Resize to at least ${MIN_TERMINAL_WIDTH}x${MIN_TERMINAL_HEIGHT}.`;
    return wrapTextWithAnsi(message, width)
      .slice(0, height)
      .map((line) => truncateToWidth(line, width));
  }
  const interactionLines = renderHumanInteraction(interactions, options.input, width, color).slice(
    0,
    Math.max(4, Math.floor(height * 0.45)),
  );
  const header = [
    truncateToWidth(
      `${paint("Pragma", ANSI.bold, color)} · ${title}  ${paint(`Execution ${shortId(model.executionId ?? "starting")}`, ANSI.dim, color)}`,
      width,
    ),
    truncateToWidth(
      `${statusLabel(model.executionStatus, color)}  ${formatUsage(model.usage)}  ${model.notice ?? ""}`,
      width,
    ),
  ];
  const footer = truncateToWidth(
    interactions.active === undefined
      ? "↑/↓ node · ←/→ Activity/Input/Output · Enter expand · PgUp/PgDn scroll · q/Ctrl+C exit"
      : "Human input has focus · Ctrl+C cancels the Flow",
    width,
  );
  const bodyHeight = Math.max(4, height - header.length - interactionLines.length - 2);
  const body =
    width >= 110
      ? renderWideBody(model, width, bodyHeight, color)
      : renderStackedBody(model, width, bodyHeight, color);
  return [
    ...header,
    separator(width),
    ...body,
    ...interactionLines,
    paint(footer, ANSI.dim, color),
  ];
}

function renderWideBody(
  model: FlowConsoleModel,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const leftWidth = Math.min(44, Math.max(34, Math.floor(width * 0.36)));
  const rightWidth = width - leftWidth - 3;
  const graph = renderGraph(model, leftWidth, height, color);
  const details = renderDetails(model, rightWidth, height, color);
  return Array.from({ length: height }, (_, index) => {
    const left = padToWidth(graph[index] ?? "", leftWidth);
    const right = details[index] ?? "";
    return `${left} │ ${truncateToWidth(right, rightWidth)}`;
  });
}

function renderStackedBody(
  model: FlowConsoleModel,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const graphHeight = Math.max(5, Math.min(10, Math.floor(height * 0.4)));
  const detailsHeight = Math.max(3, height - graphHeight - 1);
  return [
    ...renderGraph(model, width, graphHeight, color),
    separator(width),
    ...renderDetails(model, width, detailsHeight, color),
  ].slice(0, height);
}

function renderGraph(
  model: FlowConsoleModel,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const nodes = model.visibleNodes;
  const selectedIndex = Math.max(
    0,
    nodes.findIndex((node) => node.key === model.selected.key),
  );
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(height / 2), nodes.length - height),
  );
  const visible = nodes.slice(start, start + height);
  const lines = visible.map((node) => {
    const depth = nodeDepth(model, node);
    const branch = node.branchLabels.length === 0 ? "" : `[${node.branchLabels.join("|")}] `;
    const expandable = node.children.length === 0 ? " " : node.expanded ? "▾" : "▸";
    const rounds = node.visits.length > 1 ? ` ×${node.visits.length}` : "";
    const text = `${"  ".repeat(depth)}${expandable} ${statusIcon(node.status)} ${branch}${node.label}${rounds} · ${node.kind}`;
    const styled =
      node.key === model.selected.key
        ? paint(` ${text} `, ANSI.inverse, color)
        : statusColor(text, node.status, color);
    return truncateToWidth(styled, width);
  });
  while (lines.length < height) lines.push("");
  return lines;
}

function nodeDepth(model: FlowConsoleModel, node: FlowConsoleNode): number {
  let depth = 0;
  let parentKey = node.parentKey;
  while (parentKey !== undefined) {
    depth += 1;
    parentKey = model.nodes.get(parentKey)?.parentKey;
  }
  return depth;
}

function renderDetails(
  model: FlowConsoleModel,
  width: number,
  height: number,
  color: boolean,
): string[] {
  const node = model.selected;
  const tabs = (["activity", "input", "output"] as const)
    .map((mode) =>
      mode === model.viewMode
        ? paint(` ${capitalize(mode)} `, ANSI.inverse, color)
        : ` ${capitalize(mode)} `,
    )
    .join(" ");
  const identity = formatContextIdentity(node);
  const meta = `${node.label}  ${statusLabel(node.status, color)}${formatDuration(node)}${identity}`;
  const detail = renderDetailContent(node, model.viewMode, width, color);
  const content = detail.lines;
  const contentHeight = Math.max(1, height - 2);
  let visible: string[];
  if (detail.pinToBottom) {
    const end = Math.max(0, content.length - model.scrollOffset);
    visible = content.slice(Math.max(0, end - contentHeight), end);
    while (visible.length < contentHeight) visible.unshift("");
  } else {
    visible = content.slice(0, contentHeight);
    while (visible.length < contentHeight) visible.push("");
  }
  return [truncateToWidth(meta, width), truncateToWidth(tabs, width), ...visible];
}

function renderDetailContent(
  node: FlowConsoleNode,
  mode: FlowConsoleViewMode,
  width: number,
  color: boolean,
): { readonly lines: string[]; readonly pinToBottom: boolean } {
  if (node.status === "skipped" && node.visits.length === 0) {
    const routes = node.branchLabels.map((label) => `"${label}"`).join(", ");
    const routeMessage =
      routes === ""
        ? "This node was skipped."
        : `Route ${routes} was not selected. Conditional branches are mutually exclusive.`;
    return {
      lines: wrapTextWithAnsi(
        `${paint("Not executed", ANSI.bold, color)}\n${routeMessage}\nNo Activity, Input, or Output was produced.`,
        width,
      ),
      pinToBottom: false,
    };
  }
  if (mode === "activity") {
    const lines =
      node.visits.length > 1
        ? node.visits.flatMap((visit, index) => [
            roundHeader(index, visit, color),
            ...renderActivityItems(visit.activity, width, color),
          ])
        : renderActivityItems(node.activity, width, color);
    return {
      lines,
      pinToBottom: node.activity.length > 0,
    };
  }
  const value = mode === "input" ? node.input : node.output;
  if (node.visits.length > 1) {
    return {
      lines: node.visits.flatMap((visit, index) => {
        const visitValue = mode === "input" ? visit.input : visit.output;
        return [
          roundHeader(index, visit, color),
          ...wrapTextWithAnsi(
            formatValue(visitValue) ?? `No ${mode === "input" ? "input" : "output"} recorded.`,
            width,
          ),
        ];
      }),
      pinToBottom: true,
    };
  }
  return {
    lines: wrapTextWithAnsi(
      formatValue(value) ?? `No ${mode === "input" ? "input" : "output"} recorded.`,
      width,
    ),
    pinToBottom: value !== undefined,
  };
}

function roundHeader(index: number, visit: FlowConsoleVisit, color: boolean): string {
  return paint(
    `── Round ${index + 1} · ${visit.status}${formatContextIdentity(visit)} ──`,
    ANSI.bold,
    color,
  );
}

function formatContextIdentity(value: {
  readonly agentId?: string | undefined;
  readonly contextId?: string | undefined;
  readonly resolver?: string | undefined;
  readonly disposition?: "created" | "reused" | undefined;
}): string {
  const parts = [
    value.agentId === undefined ? undefined : `agent ${value.agentId}`,
    value.contextId === undefined ? undefined : `context ${value.contextId}`,
    value.resolver === undefined ? undefined : `resolver ${value.resolver}`,
    value.disposition,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "" : ` · ${parts.join(" · ")}`;
}

function renderActivityItems(
  activity: readonly FlowConsoleActivity[],
  width: number,
  color: boolean,
): string[] {
  if (activity.length === 0) return [paint("No activity recorded.", ANSI.dim, color)];
  return activity.flatMap((item) => {
    const label: Record<FlowConsoleActivity["kind"], string> = {
      answer: "Answer",
      progress: "Progress",
      thinking: "Thinking",
      tool: "Tool",
      "tool-output": "Tool output",
    };
    const body =
      item.kind === "thinking" || item.kind === "tool-output"
        ? paint(item.text, ANSI.dim, color)
        : item.text;
    return wrapTextWithAnsi(`${paint(label[item.kind], ANSI.bold, color)}\n${body}`, width);
  });
}

function findAppendTarget(
  activity: readonly FlowConsoleActivity[],
  kind: FlowConsoleActivity["kind"],
  source: string | undefined,
): FlowConsoleActivity | undefined {
  for (let index = activity.length - 1; index >= 0; index -= 1) {
    const candidate = activity[index]!;
    if (candidate.source !== source) continue;
    return candidate.kind === kind ? candidate : undefined;
  }
  return undefined;
}

function appendActivity(
  activity: FlowConsoleActivity[],
  nodeKind: string,
  kind: FlowConsoleActivity["kind"],
  text: string,
  append: boolean,
  source: string | undefined,
): void {
  const current = append ? findAppendTarget(activity, kind, source) : undefined;
  if (current !== undefined) current.text += text;
  else {
    const prefix = nodeKind === "expert-team" ? agentPrefix(source) : "";
    activity.push({ kind, text: `${prefix}${text}`, source });
  }
  let total = activity.reduce((sum, item) => sum + item.text.length, 0);
  while (total > MAX_ACTIVITY_CHARACTERS && activity.length > 1) {
    total -= activity.shift()!.text.length;
  }
}

function renderHumanInteraction(
  interactions: FlowInteractionQueue,
  input: Input | undefined,
  width: number,
  color: boolean,
): string[] {
  const active = interactions.active;
  const question = active?.questions[active.questionIndex];
  if (active === undefined || question === undefined) return [];
  const lines = [
    separator(width),
    truncateToWidth(
      `${paint("? Human input", ANSI.bold, color)} · ${question.header} · ${active.questionIndex + 1}/${active.questions.length}${interactions.size > 1 ? ` · ${interactions.size - 1} queued` : ""}`,
      width,
    ),
    ...wrapTextWithAnsi(question.question, width).slice(0, 2),
  ];
  if (question.kind === "text") {
    lines.push(`> ${input?.render(Math.max(1, width - 2))[0] ?? ""}`);
    lines.push(paint("Type an answer and press Enter.", ANSI.dim, color));
    return lines;
  }
  for (const [index, option] of question.options.entries()) {
    const cursor = active.optionIndex === index;
    const selected = active.selectedOptions.has(index);
    const marker =
      question.kind === "multiple_choice"
        ? `${cursor ? paint("›", ANSI.cyan, color) : " "} [${selected ? "x" : " "}]`
        : cursor
          ? paint("›", ANSI.cyan, color)
          : " ";
    lines.push(
      truncateToWidth(
        `${marker} ${index + 1}. ${option.label}${option.description === "" ? "" : ` — ${option.description}`}`,
        width,
      ),
    );
  }
  lines.push(
    paint(
      question.kind === "multiple_choice"
        ? "↑/↓ move · Space toggle · Enter submit"
        : "↑/↓ move · Enter submit · number selects",
      ANSI.dim,
      color,
    ),
  );
  return lines;
}

function collectBranchLabels(flow: Flow): Map<string, readonly string[]> {
  const labels = new Map<string, string[]>();
  for (const transition of flow.transitions.values()) {
    if (transition.type !== "route") continue;
    for (const [label, target] of transition.cases) {
      if ("type" in target) continue;
      const values = labels.get(target.id) ?? [];
      values.push(label);
      labels.set(target.id, values);
    }
  }
  return labels;
}

function definitionKind(
  definition: Flow["steps"] extends ReadonlyMap<string, infer T>
    ? T extends { definition: infer D }
      ? D
      : never
    : never,
): string {
  return "kind" in definition ? String(definition.kind) : "expert";
}

function definitionLabel(
  definition: Flow["steps"] extends ReadonlyMap<string, infer T>
    ? T extends { definition: infer D }
      ? D
      : never
    : never,
  fallback: string,
): string {
  return "name" in definition && typeof definition.name === "string" ? definition.name : fallback;
}

function stepKey(nodeId: string): string {
  return `step:${nodeId}`;
}

function mapStatus(status: Invocation["status"]): FlowConsoleStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "waiting":
      return "waiting-human";
    case "succeeded":
      return "succeeded";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function isTerminalStatus(status: FlowConsoleStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function statusIcon(status: FlowConsoleStatus): string {
  switch (status) {
    case "pending":
      return "○";
    case "queued":
      return "◷";
    case "running":
      return "●";
    case "waiting-human":
      return "?";
    case "succeeded":
      return "✓";
    case "failed":
      return "×";
    case "cancelled":
      return "–";
    case "skipped":
      return "↷";
  }
}

function statusLabel(status: FlowConsoleStatus, color: boolean): string {
  return statusColor(`${statusIcon(status)} ${status}`, status, color);
}

function statusColor(text: string, status: FlowConsoleStatus, color: boolean): string {
  if (status === "waiting-human") return paint(text, ANSI.cyan, color);
  if (status === "queued" || status === "running") return paint(text, ANSI.yellow, color);
  if (status === "succeeded") return paint(text, ANSI.green, color);
  if (status === "failed") return paint(text, ANSI.red, color);
  return paint(text, ANSI.dim, color);
}

function formatDuration(node: FlowConsoleNode): string {
  if (node.createdAt === undefined || node.updatedAt === undefined) return "";
  const duration = Math.max(0, Date.parse(node.updatedAt) - Date.parse(node.createdAt));
  return `  ${(duration / 1_000).toFixed(1)}s`;
}

function formatUsage(usage: AgentMessageUsage | undefined): string {
  if (usage === undefined) return "";
  return `tokens ${(usage.totalTokens ?? usage.input + usage.output).toLocaleString("en-US")}`;
}

function formatProgress(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  const record = asRecord(value);
  const stage = readString(record, "stage");
  const message = readString(record, "message");
  if (stage !== "" || message !== "")
    return `${stage}${stage !== "" && message !== "" ? " — " : ""}${message}`;
  return formatValue(value);
}

function readCompletedMessageText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const content = asRecord(value)["content"];
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) => {
      const record = asRecord(item);
      return record["type"] === "text" ? readString(record, "text") : "";
    })
    .join("");
  return text === "" ? undefined : text;
}

function readToolIncrement(
  snapshots: Map<string, string>,
  key: string,
  next: string,
): string | undefined {
  const previous = snapshots.get(key);
  if (previous === undefined) {
    snapshots.set(key, next);
    return next;
  }
  if (next === previous) return undefined;
  if (next.startsWith(previous)) {
    snapshots.set(key, next);
    return next.slice(previous.length);
  }
  snapshots.set(key, `${previous}${next}`);
  return next;
}

function agentPrefix(executorId: string | undefined): string {
  return executorId === undefined ? "" : `[${executorId}] `;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] : "";
}

function formatValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

function formatPreview(value: unknown): string | undefined {
  const text = formatValue(value);
  if (text === undefined) return undefined;
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toLocaleUpperCase()}${value.slice(1)}`;
}

function paint(text: string, style: string, color: boolean): string {
  return color ? `${style}${text}${ANSI.reset}` : text;
}

function separator(width: number): string {
  return "─".repeat(width);
}

function padToWidth(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
