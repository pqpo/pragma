import {
  ExpertAgentHumanRequestSchema,
  type AgentMessageUsage,
  type ExecutionEvent,
  type ExecutionEventSubscription,
  type ExecutionOutputItem,
  type ExpertAgentHumanRequest,
  type ExpertAgentUserQuestion,
  type ExpertTurn,
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
  wrapTextWithAnsi,
  visibleWidth,
} from "@earendil-works/pi-tui";

export type DelegationAgentStatus =
  | "idle"
  | "queued"
  | "working"
  | "input"
  | "done"
  | "failed"
  | "cancelled";

export interface DelegationConsoleAgent {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly primary?: boolean | undefined;
}

interface AgentLogSection {
  readonly kind: "answer" | "system" | "thinking" | "tool" | "tool-output" | "user";
  text: string;
}

interface AgentPane {
  readonly definition: DelegationConsoleAgent;
  readonly sections: AgentLogSection[];
  status: DelegationAgentStatus;
}

interface ConsoleInteractionPresentation {
  readonly agentName: string;
  readonly current: number;
  readonly total: number;
  readonly header: string;
  readonly question: string;
  readonly options: ExpertAgentUserQuestion["options"];
  readonly instruction: string;
}

interface PendingConsoleInput {
  readonly presentation: ConsoleInteractionPresentation;
  readonly submit: (input: string) => string | undefined;
  readonly reject: (error: unknown) => void;
}

export type DelegationQuestionAnswerResult =
  | { readonly ok: true; readonly answer: string }
  | { readonly ok: false; readonly message: string };

type InvocationTree = Awaited<ReturnType<ExpertTurn["getTree"]>>;

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

const MAX_LOG_CHARACTERS = 200_000;

export class DelegationConsoleModel {
  readonly panes: readonly AgentPane[];
  private readonly awaitingInput = new Set<string>();
  private readonly invocationsWithAnswerDeltas = new Set<string>();
  private readonly toolOutputSnapshots = new Map<string, string>();
  private selectedIndex = 0;
  private scrollOffset = 0;
  private usage: AgentMessageUsage | undefined;

  constructor(agents: readonly DelegationConsoleAgent[]) {
    if (agents.length < 2) {
      throw new Error("Delegation console requires a primary Agent and at least one subagent.");
    }
    if (new Set(agents.map((agent) => agent.id)).size !== agents.length) {
      throw new Error("Delegation console Agent ids must be unique.");
    }
    const primaryIndexes = agents.flatMap((agent, index) =>
      agent.primary === true ? [index] : [],
    );
    if (primaryIndexes.length !== 1) {
      throw new Error("Delegation console requires exactly one primary Agent.");
    }
    this.panes = agents.map((definition) => ({ definition, sections: [], status: "idle" }));
    this.selectedIndex = primaryIndexes[0]!;
  }

  get selected(): AgentPane {
    return this.panes[this.selectedIndex]!;
  }

  get selectedAgentIndex(): number {
    return this.selectedIndex;
  }

  get selectedScrollOffset(): number {
    return this.scrollOffset;
  }

  get latestUsage(): AgentMessageUsage | undefined {
    return this.usage;
  }

  beginTurn(prompt: string): void {
    this.awaitingInput.clear();
    this.invocationsWithAnswerDeltas.clear();
    this.toolOutputSnapshots.clear();
    for (const pane of this.panes) pane.status = "idle";
    const primary = this.panes.find((pane) => pane.definition.primary === true)!;
    primary.status = "working";
    appendSection(primary, "user", prompt);
    this.scrollOffset = 0;
  }

  consume(item: ExecutionOutputItem): void {
    if (item.executorId === undefined) return;
    const pane = this.panes.find((candidate) => candidate.definition.id === item.executorId);
    if (pane === undefined) return;
    if (pane.status === "idle" || pane.status === "queued") pane.status = "working";

    switch (item.channel) {
      case "thought": {
        const text = item.delta ?? formatValue(item.value);
        if (text !== undefined) appendSection(pane, "thinking", text, item.delta !== undefined);
        break;
      }
      case "message": {
        if (item.delta !== undefined) {
          this.invocationsWithAnswerDeltas.add(item.invocationId);
          appendSection(pane, "answer", item.delta, true);
        } else if (!this.invocationsWithAnswerDeltas.has(item.invocationId)) {
          const text = readCompletedMessageText(item.value);
          if (text !== undefined) appendSection(pane, "answer", text);
        }
        break;
      }
      case "tool":
        consumeToolOutput(pane, item, this.toolOutputSnapshots);
        break;
      case "progress": {
        const payload = asRecord(item.value);
        const stage = readString(payload, "stage");
        if (!isRoutineProgress(stage)) {
          const message = readString(payload, "message");
          appendSection(pane, "system", `${stage}${message === "" ? "" : ` — ${message}`}`);
        }
        break;
      }
      case "result": {
        const text = formatValue(item.value);
        if (text !== undefined && !this.invocationsWithAnswerDeltas.has(item.invocationId)) {
          appendSection(pane, "answer", text);
        }
        break;
      }
    }

    trimPane(pane);
    if (this.selected.definition.id === pane.definition.id) this.scrollOffset = 0;
  }

  syncTree(tree: InvocationTree): void {
    const statuses = new Map<string, DelegationAgentStatus[]>();
    visitTree(tree, (executorId, status) => {
      const values = statuses.get(executorId) ?? [];
      values.push(mapInvocationStatus(status));
      statuses.set(executorId, values);
    });
    for (const pane of this.panes) {
      const values = statuses.get(pane.definition.id);
      if (values !== undefined) pane.status = aggregateStatuses(values);
      if (this.awaitingInput.has(pane.definition.id)) pane.status = "input";
    }
  }

  setAwaitingInput(executorId: string | undefined, awaiting: boolean): void {
    if (executorId === undefined) return;
    if (awaiting) this.awaitingInput.add(executorId);
    else this.awaitingInput.delete(executorId);
    const pane = this.panes.find((candidate) => candidate.definition.id === executorId);
    if (pane !== undefined) pane.status = awaiting ? "input" : "working";
  }

  completeTurn(usage: AgentMessageUsage | undefined, error?: unknown): void {
    this.awaitingInput.clear();
    this.usage = usage;
    for (const pane of this.panes) {
      if (pane.status === "working" || pane.status === "queued" || pane.status === "input") {
        pane.status = "done";
      }
    }
    if (error !== undefined) {
      const primary = this.panes.find((pane) => pane.definition.primary === true)!;
      primary.status = "failed";
      appendSection(primary, "system", error instanceof Error ? error.message : String(error));
    }
  }

  cycleSelection(direction: 1 | -1): void {
    this.selectedIndex = (this.selectedIndex + direction + this.panes.length) % this.panes.length;
    this.scrollOffset = 0;
  }

  select(index: number): void {
    if (index < 0 || index >= this.panes.length) return;
    this.selectedIndex = index;
    this.scrollOffset = 0;
  }

  selectPrimary(): void {
    this.select(this.panes.findIndex((pane) => pane.definition.primary === true));
  }

  scroll(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + lines);
  }
}

export interface DelegationConsoleTuiOptions {
  readonly agents: readonly DelegationConsoleAgent[];
  readonly sessionId: string;
  readonly title: string;
  readonly examplePrompt: string;
  readonly onPrompt: (prompt: string, ui: DelegationConsoleTui) => Promise<void>;
  readonly onExit: () => Promise<void>;
  readonly terminal?: Terminal | undefined;
}

export class DelegationConsoleTui {
  readonly model: DelegationConsoleModel;
  private readonly terminal: Terminal;
  private readonly tui: TUI;
  private readonly view: DelegationConsoleView;
  private readonly options: DelegationConsoleTuiOptions;
  private promptTask: Promise<void> | undefined;
  private pendingInput: PendingConsoleInput | undefined;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private exiting = false;

  constructor(options: DelegationConsoleTuiOptions) {
    this.options = options;
    this.model = new DelegationConsoleModel(options.agents);
    this.terminal = options.terminal ?? new ProcessTerminal();
    this.tui = new TUI(this.terminal, true);
    this.view = new DelegationConsoleView({
      model: this.model,
      terminal: this.terminal,
      sessionId: options.sessionId,
      title: options.title,
      examplePrompt: options.examplePrompt,
      requestRender: () => this.tui.requestRender(),
      submit: (prompt) => this.submit(prompt),
      exit: () => void this.exit(),
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
    return await this.exitPromise;
  }

  consume(item: ExecutionOutputItem): void {
    this.model.consume(item);
    this.tui.requestRender();
  }

  async followTurn(turn: ExpertTurn): Promise<unknown> {
    const output = await turn.subscribeOutput({ scope: { kind: "all" } });
    const events = await turn.subscribeEvents({ scope: { kind: "all" } });
    const interactionTask = this.followHumanInteractions(turn, events);
    const poll = setInterval(() => {
      void turn
        .getTree()
        .then((tree) => {
          this.model.syncTree(tree);
          this.tui.requestRender();
        })
        .catch(() => undefined);
    }, 250);
    poll.unref();

    try {
      const outputTask = (async () => {
        for await (const item of output) this.consume(item);
      })();
      const [result] = await Promise.all([turn.result, outputTask, interactionTask]);
      this.model.syncTree(await turn.getTree());
      this.model.completeTurn(await turn.usage);
      this.tui.requestRender();
      return result;
    } catch (error) {
      this.rejectPendingInput(error);
      await interactionTask.catch(() => undefined);
      await turn.cancel("Delegation console interaction failed.").catch(() => undefined);
      this.model.completeTurn(await turn.usage.catch(() => undefined), error);
      this.tui.requestRender();
      throw error;
    } finally {
      clearInterval(poll);
      await Promise.all([output.close(), events.close()]);
    }
  }

  private submit(input: string): void {
    if (this.exiting) return;
    if (this.pendingInput !== undefined) {
      const error = this.pendingInput.submit(input);
      if (error !== undefined) {
        this.view.notice = error;
      } else {
        this.pendingInput = undefined;
        this.view.interaction = undefined;
        this.view.notice = "回答已提交，Agent 继续执行。";
      }
      this.tui.requestRender();
      return;
    }
    if (this.promptTask !== undefined) return;
    const normalized = input.trim();
    if (normalized === "") return;
    if (normalized === "/exit") {
      void this.exit();
      return;
    }
    this.model.beginTurn(normalized);
    this.view.busy = true;
    this.view.notice = undefined;
    this.tui.requestRender();
    this.promptTask = this.options
      .onPrompt(normalized, this)
      .catch(() => undefined)
      .finally(() => {
        this.promptTask = undefined;
        this.view.busy = false;
        if (this.view.notice === "回答已提交，Agent 继续执行。") {
          this.view.notice = undefined;
        }
        this.tui.requestRender();
      });
  }

  private async exit(): Promise<void> {
    if (this.exiting) return;
    this.exiting = true;
    this.view.notice = "正在关闭 Agent Session…";
    this.tui.requestRender();
    await this.options.onExit().catch(() => undefined);
    this.rejectPendingInput(new Error("Agent console closed."));
    await this.promptTask?.catch(() => undefined);
    this.tui.stop();
    await this.terminal.drainInput(250, 25).catch(() => undefined);
    this.resolveExit();
  }

  private async followHumanInteractions(
    turn: ExpertTurn,
    events: ExecutionEventSubscription,
  ): Promise<void> {
    const handled = new Set<string>();
    const handle = async (event: ExecutionEvent): Promise<void> => {
      if (event.type !== "human.requested") return;
      const interaction = readHumanInteraction(event);
      if (handled.has(interaction.interactionId)) return;
      handled.add(interaction.interactionId);
      await this.respondToHumanInteraction(turn, event, interaction);
    };

    const history = await turn.listEvents({ scope: { kind: "all" }, limit: 1_000 });
    for (const event of history.items) await handle(event);
    for await (const event of events) await handle(event);
  }

  private async respondToHumanInteraction(
    turn: ExpertTurn,
    event: ExecutionEvent,
    interaction: {
      readonly interactionId: string;
      readonly request: ExpertAgentHumanRequest;
    },
  ): Promise<void> {
    const invocation = await turn.getInvocation(event.invocationId);
    const executorId = invocation?.executorId;
    const agentName =
      this.options.agents.find((agent) => agent.id === executorId)?.name ?? executorId ?? "Agent";
    this.model.setAwaitingInput(executorId, true);

    try {
      const response =
        interaction.request.kind === "user_question"
          ? await this.answerUserQuestions(agentName, interaction.request.questions)
          : await this.answerToolApproval(agentName, interaction.request);
      await turn.respondToHumanInteraction(interaction.interactionId, response, {
        requestId: `console-response-${interaction.interactionId}`,
      });
    } finally {
      this.model.setAwaitingInput(executorId, false);
      this.tui.requestRender();
    }
  }

  private async answerUserQuestions(
    agentName: string,
    questions: readonly ExpertAgentUserQuestion[],
  ): Promise<{
    readonly kind: "user_question";
    readonly answered: true;
    readonly answers: unknown;
  }> {
    const answers: Record<string, string> = {};
    for (const [index, question] of questions.entries()) {
      answers[question.question] = await this.requestInput(
        {
          agentName,
          current: index + 1,
          total: questions.length,
          header: question.header,
          question: question.question,
          options: question.options,
          instruction: questionInstruction(question),
        },
        (input) => {
          const result = parseDelegationQuestionAnswer(question, input);
          return result.ok
            ? { ok: true, value: result.answer }
            : { ok: false, message: result.message };
        },
      );
    }
    return { kind: "user_question", answered: true, answers };
  }

  private async answerToolApproval(
    agentName: string,
    request: Extract<ExpertAgentHumanRequest, { readonly kind: "tool_approval" }>,
  ): Promise<{
    readonly kind: "tool_approval";
    readonly approved: boolean;
    readonly reason: string;
  }> {
    const approved = await this.requestInput(
      {
        agentName,
        current: 1,
        total: 1,
        header: "Tool approval",
        question: `${request.toolName}: ${request.reason ?? "是否允许执行此工具？"}`,
        options: [
          { label: "Yes", description: "允许执行" },
          { label: "No", description: "拒绝执行" },
        ],
        instruction: "输入 y/yes 或 n/no 后回车。",
      },
      parseApprovalAnswer,
    );
    return {
      kind: "tool_approval",
      approved,
      reason: approved ? "用户批准。" : "用户拒绝。",
    };
  }

  private requestInput<T>(
    presentation: ConsoleInteractionPresentation,
    parse: (
      input: string,
    ) =>
      | { readonly ok: true; readonly value: T }
      | { readonly ok: false; readonly message: string },
  ): Promise<T> {
    if (this.pendingInput !== undefined) {
      throw new Error("Another human interaction is already awaiting console input.");
    }
    return new Promise<T>((resolve, reject) => {
      this.pendingInput = {
        presentation,
        submit: (input) => {
          const result = parse(input);
          if (!result.ok) return result.message;
          resolve(result.value);
          return undefined;
        },
        reject,
      };
      this.view.interaction = presentation;
      this.view.notice = undefined;
      this.tui.requestRender();
    });
  }

  private rejectPendingInput(error: unknown): void {
    const pending = this.pendingInput;
    if (pending === undefined) return;
    this.pendingInput = undefined;
    this.view.interaction = undefined;
    pending.reject(error);
  }
}

class DelegationConsoleView implements Component, Focusable {
  readonly model: DelegationConsoleModel;
  readonly terminal: Terminal;
  readonly sessionId: string;
  readonly title: string;
  readonly examplePrompt: string;
  readonly input = new Input();
  readonly requestRender: () => void;
  readonly submit: (prompt: string) => void;
  readonly exit: () => void;
  busy = false;
  notice: string | undefined;
  interaction: ConsoleInteractionPresentation | undefined;
  private _focused = false;

  constructor(options: {
    readonly model: DelegationConsoleModel;
    readonly terminal: Terminal;
    readonly sessionId: string;
    readonly title: string;
    readonly examplePrompt: string;
    readonly requestRender: () => void;
    readonly submit: (prompt: string) => void;
    readonly exit: () => void;
  }) {
    this.model = options.model;
    this.terminal = options.terminal;
    this.sessionId = options.sessionId;
    this.title = options.title;
    this.examplePrompt = options.examplePrompt;
    this.requestRender = options.requestRender;
    this.submit = options.submit;
    this.exit = options.exit;
    this.input.onSubmit = (value) => {
      this.input.setValue("");
      this.submit(value);
      this.requestRender();
    };
  }

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
    if (matchesKey(data, Key.ctrl("c"))) {
      this.exit();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.model.cycleSelection(1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.shift(Key.tab))) {
      this.model.cycleSelection(-1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.model.selectPrimary();
      this.requestRender();
      return;
    }
    const functionKeys = [Key.f1, Key.f2, Key.f3, Key.f4];
    const selected = functionKeys.findIndex((key) => matchesKey(data, key));
    if (selected >= 0) {
      this.model.select(selected);
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.model.scroll(Math.max(4, Math.floor(this.terminal.rows / 2)));
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.model.scroll(-Math.max(4, Math.floor(this.terminal.rows / 2)));
      this.requestRender();
      return;
    }
    if (this.busy && this.interaction === undefined) {
      this.notice = "当前 Turn 尚未结束；可先切换 Agent 查看工作进度。";
      this.requestRender();
      return;
    }
    this.notice = undefined;
    this.input.handleInput(data);
    this.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const color = process.env["NO_COLOR"] === undefined;
    const selected = this.model.selected;
    const header = truncateToWidth(
      `${paint("Pragma", ANSI.bold, color)} · ${this.title}  ${paint(`Session ${shortId(this.sessionId)}`, ANSI.dim, color)}`,
      safeWidth,
    );
    const tabs = renderAgentTabs(this.model, safeWidth, color);
    const selectedTitle = truncateToWidth(
      `${paint(selected.definition.name, ANSI.bold, color)}  ${statusLabel(selected.status, color)}${selected.definition.primary === true ? paint("  MAIN", ANSI.cyan, color) : ""}`,
      safeWidth,
    );
    const interactionLines = renderInteraction(this.interaction, safeWidth, color);
    const fixedRows = 8 + tabs.length + interactionLines.length;
    const contentHeight = Math.max(3, this.terminal.rows - fixedRows);
    const logLines = renderLog(selected, safeWidth, color);
    const end = Math.max(0, logLines.length - this.model.selectedScrollOffset);
    const visibleLog = logLines.slice(Math.max(0, end - contentHeight), end);
    while (visibleLog.length < contentHeight) visibleLog.unshift("");

    const inputLine =
      this.interaction !== undefined
        ? `回答 ${this.input.render(Math.max(1, safeWidth - 5))[0] ?? ""}`
        : this.busy
          ? paint("● Agents 正在工作；Tab 切换 Agent 查看实时过程", ANSI.yellow, color)
          : `你 ${this.input.render(Math.max(1, safeWidth - 3))[0] ?? ""}`;
    const usage = formatUsage(this.model.latestUsage);
    const directKeyHint = `F1-F${Math.min(4, this.model.panes.length)} 直达`;
    const hint =
      this.notice ??
      this.interaction?.instruction ??
      (this.model.selected.sections.length === 0
        ? `示例：${this.examplePrompt}`
        : `Tab/Shift+Tab 切换 · ${directKeyHint} · Esc 回主 Agent · PgUp/PgDn 滚动 · Ctrl+C 退出`);

    return [
      header,
      ...tabs,
      separator(safeWidth),
      selectedTitle,
      separator(safeWidth),
      ...visibleLog.map((line) => truncateToWidth(line, safeWidth)),
      separator(safeWidth),
      ...interactionLines,
      truncateToWidth(inputLine, safeWidth),
      truncateToWidth(
        `${paint(hint, ANSI.dim, color)}${usage === "" ? "" : `  ${usage}`}`,
        safeWidth,
      ),
    ];
  }
}

function renderAgentTabs(model: DelegationConsoleModel, width: number, color: boolean): string[] {
  const tabs = model.panes.map((pane, index) => {
    const icon = statusIcon(pane.status);
    const text = `${index + 1}:${icon} ${pane.definition.shortName}`;
    return index === model.selectedAgentIndex
      ? paint(` ${text} `, ANSI.inverse, color)
      : ` ${statusColor(text, pane.status, color)} `;
  });
  const lines: string[] = [];
  let line = "";
  for (const tab of tabs) {
    const candidate = line === "" ? tab : `${line} ${tab}`;
    if (visibleWidth(candidate) > width && line !== "") {
      lines.push(line);
      line = tab;
    } else line = candidate;
  }
  if (line !== "") lines.push(line);
  return lines;
}

function renderLog(pane: AgentPane, width: number, color: boolean): string[] {
  if (pane.sections.length === 0) {
    return [paint("尚未参与当前对话。主 Agent 会在任务需要该能力时自动委派。", ANSI.dim, color)];
  }
  return pane.sections.flatMap((section) => {
    const label = sectionLabel(section.kind, pane.definition, color);
    return wrapTextWithAnsi(`${label}\n${styleSection(section.kind, section.text, color)}`, width);
  });
}

function renderInteraction(
  interaction: ConsoleInteractionPresentation | undefined,
  width: number,
  color: boolean,
): string[] {
  if (interaction === undefined) return [];
  const heading = `${paint("? User input", ANSI.bold, color)} · ${interaction.agentName} · ${interaction.current}/${interaction.total}`;
  const question = wrapTextWithAnsi(
    `${paint(interaction.header, ANSI.cyan, color)}: ${interaction.question}`,
    width,
  ).slice(0, 3);
  const options = interaction.options
    .slice(0, 6)
    .map((option, index) =>
      truncateToWidth(
        `  ${index + 1}. ${option.label}${option.description === "" ? "" : ` — ${option.description}`}`,
        width,
      ),
    );
  return [truncateToWidth(heading, width), ...question, ...options];
}

function consumeToolOutput(
  pane: AgentPane,
  item: ExecutionOutputItem,
  snapshots: Map<string, string>,
): void {
  if (item.delta !== undefined) {
    const normalized = normalizeToolDelta(item.delta);
    const text =
      normalized === undefined
        ? undefined
        : readToolOutputIncrement(item.invocationId, normalized, snapshots);
    if (text !== undefined) appendSection(pane, "tool-output", text, true);
    return;
  }
  const payload = asRecord(item.value);
  const name = readString(payload, "toolName") || "tool";
  const started =
    payload["message"] === undefined &&
    payload["approvalId"] === undefined &&
    payload["outputPreview"] === undefined;
  if (started) snapshots.delete(item.invocationId);
  if (payload["message"] !== undefined) {
    appendSection(pane, "tool", `× ${name}: ${readString(payload, "message")}`);
  } else if (payload["approvalId"] !== undefined) {
    appendSection(pane, "tool", `! ${name} requires approval`);
  } else if (payload["outputPreview"] !== undefined) {
    appendSection(pane, "tool", `✓ ${name} completed`);
  } else if (payload["toolName"] !== undefined) {
    const preview = formatPreview(payload["inputPreview"]);
    appendSection(pane, "tool", `→ ${name}${preview === undefined ? "" : `\n${preview}`}`);
  }
  if (!started) snapshots.delete(item.invocationId);
}

function readToolOutputIncrement(
  invocationId: string,
  next: string,
  snapshots: Map<string, string>,
): string | undefined {
  const previous = snapshots.get(invocationId);
  if (previous === undefined) {
    snapshots.set(invocationId, next);
    return next;
  }
  if (next === previous) return undefined;
  if (next.startsWith(previous)) {
    snapshots.set(invocationId, next);
    return next.slice(previous.length) || undefined;
  }
  snapshots.set(invocationId, `${previous}${next}`);
  return next;
}

function appendSection(
  pane: AgentPane,
  kind: AgentLogSection["kind"],
  text: string,
  append = false,
): void {
  if (text === "") return;
  const current = pane.sections.at(-1);
  if (append && current?.kind === kind) current.text += text;
  else pane.sections.push({ kind, text });
}

function trimPane(pane: AgentPane): void {
  let total = pane.sections.reduce((sum, section) => sum + section.text.length, 0);
  while (total > MAX_LOG_CHARACTERS && pane.sections.length > 1) {
    total -= pane.sections.shift()!.text.length;
  }
}

function visitTree(
  tree: InvocationTree,
  visit: (executorId: string, status: InvocationTree["invocation"]["status"]) => void,
): void {
  if (tree.invocation.executorId !== undefined) {
    visit(tree.invocation.executorId, tree.invocation.status);
  }
  for (const child of tree.children) visitTree(child, visit);
}

function mapInvocationStatus(
  status: InvocationTree["invocation"]["status"],
): DelegationAgentStatus {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
    case "waiting":
      return "working";
    case "succeeded":
      return "done";
    case "failed":
    case "interrupted":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function aggregateStatuses(statuses: readonly DelegationAgentStatus[]): DelegationAgentStatus {
  const priority: readonly DelegationAgentStatus[] = [
    "failed",
    "input",
    "working",
    "queued",
    "cancelled",
    "done",
    "idle",
  ];
  return priority.find((status) => statuses.includes(status)) ?? "idle";
}

function statusIcon(status: DelegationAgentStatus): string {
  switch (status) {
    case "idle":
      return "○";
    case "queued":
      return "◷";
    case "working":
      return "●";
    case "input":
      return "?";
    case "done":
      return "✓";
    case "failed":
      return "×";
    case "cancelled":
      return "–";
  }
}

function statusLabel(status: DelegationAgentStatus, color: boolean): string {
  const labels: Record<DelegationAgentStatus, string> = {
    idle: "idle",
    queued: "queued",
    working: "working",
    input: "input",
    done: "done",
    failed: "failed",
    cancelled: "cancelled",
  };
  return statusColor(`${statusIcon(status)} ${labels[status]}`, status, color);
}

function statusColor(text: string, status: DelegationAgentStatus, color: boolean): string {
  if (status === "input") return paint(text, ANSI.cyan, color);
  if (status === "working" || status === "queued") return paint(text, ANSI.yellow, color);
  if (status === "done") return paint(text, ANSI.green, color);
  if (status === "failed") return paint(text, ANSI.red, color);
  return paint(text, ANSI.dim, color);
}

function sectionLabel(
  kind: AgentLogSection["kind"],
  agent: DelegationConsoleAgent,
  color: boolean,
): string {
  switch (kind) {
    case "user":
      return paint("You", ANSI.bold, color);
    case "thinking":
      return paint("Thinking", ANSI.magenta, color);
    case "answer":
      return paint(agent.name, ANSI.cyan, color);
    case "tool":
      return paint("Tool", ANSI.yellow, color);
    case "tool-output":
      return paint("Tool output", ANSI.dim, color);
    case "system":
      return paint("Status", ANSI.red, color);
  }
}

function styleSection(kind: AgentLogSection["kind"], text: string, color: boolean): string {
  return kind === "thinking" || kind === "tool-output" ? paint(text, ANSI.dim, color) : text;
}

function paint(text: string, style: string, color: boolean): string {
  return color ? `${style}${text}${ANSI.reset}` : text;
}

function separator(width: number): string {
  return "─".repeat(width);
}

function shortId(value: string): string {
  return value.length <= 8 ? value : value.slice(0, 8);
}

function formatUsage(usage: AgentMessageUsage | undefined): string {
  if (usage === undefined) return "";
  const total = usage.totalTokens ?? usage.input + usage.output;
  return `tokens ${total.toLocaleString("en-US")}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function readHumanInteraction(event: ExecutionEvent): {
  readonly interactionId: string;
  readonly request: ExpertAgentHumanRequest;
} {
  const payload = asRecord(event.data);
  const interactionId = readString(payload, "interactionId");
  if (interactionId === "") throw new Error("human.requested event is missing interactionId.");
  return {
    interactionId,
    request: ExpertAgentHumanRequestSchema.parse(payload["request"]),
  };
}

export function parseDelegationQuestionAnswer(
  question: ExpertAgentUserQuestion,
  input: string,
): DelegationQuestionAnswerResult {
  const normalized = input.trim();
  if (normalized === "") return { ok: false, message: "请输入回答后再按回车。" };
  if (question.kind === "text") return { ok: true, answer: normalized };

  const tokens =
    question.kind === "multiple_choice"
      ? normalized
          .split(/[,，]/u)
          .map((token) => token.trim())
          .filter((token) => token !== "")
      : [normalized];
  const selected: string[] = [];
  for (const token of tokens) {
    const option = readSelectedOption(question.options, token);
    if (option === undefined) {
      return {
        ok: false,
        message: `无法识别选项“${token}”；请输入编号或完整选项名称。`,
      };
    }
    if (!selected.includes(option.label)) selected.push(option.label);
  }
  if (question.kind === "single_choice" && selected.length !== 1) {
    return { ok: false, message: "单选题只能选择一个选项。" };
  }
  return { ok: true, answer: selected.join(", ") };
}

function readSelectedOption(
  options: ExpertAgentUserQuestion["options"],
  token: string,
): ExpertAgentUserQuestion["options"][number] | undefined {
  const numeric = Number(token);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }
  const normalized = token.toLocaleLowerCase();
  return options.find((option) => option.label.toLocaleLowerCase() === normalized);
}

function questionInstruction(question: ExpertAgentUserQuestion): string {
  switch (question.kind) {
    case "text":
      return "输入回答后回车；Ctrl+C 可取消整个 Turn。";
    case "single_choice":
      return "输入一个选项编号或名称后回车；Ctrl+C 可取消整个 Turn。";
    case "multiple_choice":
      return "输入多个编号或名称并用逗号分隔；Ctrl+C 可取消整个 Turn。";
  }
}

function parseApprovalAnswer(
  input: string,
):
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly message: string } {
  const normalized = input.trim().toLocaleLowerCase();
  if (normalized === "y" || normalized === "yes" || normalized === "1") {
    return { ok: true, value: true };
  }
  if (normalized === "n" || normalized === "no" || normalized === "2") {
    return { ok: true, value: false };
  }
  return { ok: false, message: "请输入 y/yes 或 n/no。" };
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

function formatValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

function formatPreview(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (Array.isArray(value) && value.length === 0) return undefined;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(asRecord(value)).length === 0
  ) {
    return undefined;
  }
  const text = formatValue(value);
  if (text === undefined) return undefined;
  return text.length <= 800 ? text : `${text.slice(0, 799)}…`;
}

function normalizeToolDelta(delta: string): string | undefined {
  try {
    const parsed = JSON.parse(delta) as unknown;
    const content = asRecord(parsed)["content"];
    if (Array.isArray(content)) {
      const text = content.map((item) => readString(asRecord(item), "text")).join("\n");
      return text === "" ? undefined : text;
    }
    return formatPreview(parsed);
  } catch {
    return delta;
  }
}

function isRoutineProgress(stage: string): boolean {
  return stage === "" || stage === "turn.start" || stage === "turn.end" || stage === "queue.update";
}
