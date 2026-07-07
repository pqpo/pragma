export type DesktopViewKey = "agents" | "models" | "plugins" | "workflows" | "tasks";

export type AgentCategory = "all" | "orchestrator" | "business" | "engineering" | "utility";

export interface AgentCardViewModel {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: Exclude<AgentCategory, "all">;
  readonly badge: string;
  readonly badgeTone: BadgeTone;
  readonly updatedLabel?: string;
  readonly tags: readonly string[];
  readonly defaultModel: string;
  readonly runtime: string;
  readonly plugins: readonly string[];
  readonly permissionLevel: string;
  readonly manifestPreview: string;
  readonly contextSummary: string;
}

export interface RegisteredModelViewModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly defaultUse: string;
  readonly contextWindow: string;
  readonly costTier: string;
  readonly statusLabel: string;
  readonly statusTone: BadgeTone;
  readonly lastCheckedAt: string;
}

export interface PluginCardViewModel {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly namespace: string;
  readonly tools: string;
  readonly hooks: string;
  readonly permissions: string;
  readonly tags: readonly string[];
  readonly statusLabel: string;
  readonly statusTone: BadgeTone;
}

export interface WorkflowNodeViewModel {
  readonly id: string;
  readonly label: string;
  readonly kindLabel: string;
  readonly summary: string;
  readonly binding: string;
  readonly inputContract: string;
  readonly outputContract: string;
  readonly failurePolicy: string;
  readonly humanIntervention: string;
  readonly left: number;
  readonly top: number;
}

export interface TaskBoardItemViewModel {
  readonly id: string;
  readonly title: string;
  readonly workflowName: string;
  readonly currentStep: string;
  readonly ownerAgent: string;
  readonly duration: string;
  readonly requiresHuman: boolean;
  readonly statusLabel: string;
  readonly statusTone: BadgeTone;
  readonly timeline: readonly {
    readonly id: string;
    readonly time: string;
    readonly title: string;
    readonly description: string;
  }[];
}

export interface TaskBoardColumnViewModel {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly countLabel: string;
  readonly badgeTone: BadgeTone;
  readonly items: readonly TaskBoardItemViewModel[];
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export const desktopStatus = {
  deviceLabel: "MacBook Pro · 本地桥接未上线",
  workspaceLabel: "Workspace pending",
  connectionLabel: "Offline preview",
};

export const agentCategories = [
  { id: "all", label: "全部" },
  { id: "orchestrator", label: "调度官" },
  { id: "business", label: "业务专家" },
  { id: "engineering", label: "研发专家" },
  { id: "utility", label: "通用工具型" },
] satisfies readonly { readonly id: AgentCategory; readonly label: string }[];

export const agentTemplates: readonly AgentCardViewModel[] = [
  {
    id: "req-orchestrator",
    name: "需求分析调度官",
    summary: "拆解用户需求，分派业务与技术专家，再汇总澄清项和影响面。",
    category: "orchestrator",
    badge: "Recommended",
    badgeTone: "accent",
    updatedLabel: "最近更新",
    tags: ["Router", "Human Review", "Context Heavy"],
    defaultModel: "gpt-4.1-coder",
    runtime: "cloud-pi-agent",
    plugins: ["repo-inspector", "context-memory", "review-gate"],
    permissionLevel: "审批后可读写工作区",
    manifestPreview: "输入需求背景，输出影响面、澄清问题、风险点和专家结论摘要。",
    contextSummary: "挂载 PRD 模板、业务规则库和既有需求分析案例。",
  },
  {
    id: "order-expert",
    name: "订单业务专家",
    summary: "定位订单域规则、状态机和上下游系统影响。",
    category: "business",
    badge: "Business",
    badgeTone: "neutral",
    tags: ["Domain Rules", "Order", "Knowledge"],
    defaultModel: "claude-sonnet-4",
    runtime: "cloud-pi-agent",
    plugins: ["knowledge-retrieval", "policy-checker"],
    permissionLevel: "只读上下文与文档检索",
    manifestPreview: "输入需求和上下文，输出订单域约束、异常路径与边界条件。",
    contextSummary: "挂载订单文档、风控规则和历史事故复盘。",
  },
  {
    id: "arch-reviewer",
    name: "架构评审专家",
    summary: "从系统边界、兼容性和演进成本角度审查方案。",
    category: "engineering",
    badge: "Review Gate",
    badgeTone: "warning",
    tags: ["Architecture", "Tradeoff", "Risk"],
    defaultModel: "gemini-2.5-pro",
    runtime: "cloud-pi-agent",
    plugins: ["repo-inspector", "diagram-helper"],
    permissionLevel: "审批后可读取代码与架构文档",
    manifestPreview: "输入技术方案，输出结构性风险、兼容性问题和补充建议。",
    contextSummary: "挂载架构 ADR、边界规范和模块依赖图。",
  },
  {
    id: "artifact-writer",
    name: "方案文档生成器",
    summary: "把多专家结论压缩成标准文档和对外交付产物。",
    category: "utility",
    badge: "Utility",
    badgeTone: "success",
    tags: ["Artifact", "Formatting", "Delivery"],
    defaultModel: "gpt-4.1-mini",
    runtime: "cloud-pi-agent",
    plugins: ["document-writer", "citation-builder"],
    permissionLevel: "只写产物区",
    manifestPreview: "输入结构化结论，输出格式稳定的文档产物与引用清单。",
    contextSummary: "挂载文档模板、输出规范和报告示例。",
  },
];

export const modelProviders = [
  {
    id: "openai",
    name: "OpenAI",
    summary: "用于高复杂度编码、工作流调度和工具调用。",
    modelsCount: 6,
    region: "Global",
    statusLabel: "Healthy",
    statusTone: "success" as const,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    summary: "用于长上下文分析、评审和文本生成。",
    modelsCount: 4,
    region: "Global",
    statusLabel: "Healthy",
    statusTone: "success" as const,
  },
  {
    id: "gateway",
    name: "Custom Gateway",
    summary: "企业代理入口，统一管理鉴权与模型计费。",
    modelsCount: 12,
    region: "CN / Private",
    statusLabel: "Needs check",
    statusTone: "warning" as const,
  },
];

export const registeredModels: readonly RegisteredModelViewModel[] = [
  {
    id: "gpt-4.1-coder",
    name: "gpt-4.1-coder",
    provider: "OpenAI",
    defaultUse: "编排与代码生成",
    contextWindow: "128K",
    costTier: "High",
    statusLabel: "可用",
    statusTone: "success",
    lastCheckedAt: "2 min ago",
  },
  {
    id: "claude-sonnet-4",
    name: "claude-sonnet-4",
    provider: "Anthropic",
    defaultUse: "分析与审阅",
    contextWindow: "200K",
    costTier: "Medium",
    statusLabel: "可用",
    statusTone: "success",
    lastCheckedAt: "10 min ago",
  },
  {
    id: "gemini-2.5-pro",
    name: "gemini-2.5-pro",
    provider: "Google",
    defaultUse: "长链推理",
    contextWindow: "1M",
    costTier: "High",
    statusLabel: "未校验",
    statusTone: "warning",
    lastCheckedAt: "Pending",
  },
  {
    id: "qwen-coder-plus",
    name: "qwen-coder-plus",
    provider: "Custom Gateway",
    defaultUse: "私有化场景",
    contextWindow: "128K",
    costTier: "Low",
    statusLabel: "禁用",
    statusTone: "danger",
    lastCheckedAt: "Yesterday",
  },
];

export const pluginCatalog = {
  installed: [
    {
      id: "repo-inspector",
      name: "Repo Inspector",
      summary: "读取代码仓库结构、导出依赖图并提供变更上下文。",
      namespace: "pragma.repo-inspector",
      tools: "4 tools",
      hooks: "2 hooks",
      permissions: "workspace.read",
      tags: ["Code", "Dependency Graph", "Workspace"],
      statusLabel: "启用",
      statusTone: "success",
    },
    {
      id: "context-memory",
      name: "Context Memory",
      summary: "对接上下文存储，聚合长期知识与运行记忆。",
      namespace: "pragma.context-memory",
      tools: "3 tools",
      hooks: "1 hook",
      permissions: "context.read / context.write",
      tags: ["Memory", "Knowledge", "Retrieval"],
      statusLabel: "需升级",
      statusTone: "warning",
    },
    {
      id: "shell-ops",
      name: "Shell Ops",
      summary: "暴露受控 shell 与文件写入能力，权限敏感。",
      namespace: "pragma.shell-ops",
      tools: "6 tools",
      hooks: "0 hook",
      permissions: "workspace.write / shell.exec",
      tags: ["Shell", "Write", "Sensitive"],
      statusLabel: "权限敏感",
      statusTone: "danger",
    },
  ] satisfies readonly PluginCardViewModel[],
  market: [
    {
      id: "design-review",
      name: "Design Review Pack",
      summary: "为产品与设计工作流补充评审节点模板和文档规范。",
      namespace: "market.design-review",
      tools: "2 tools",
      hooks: "1 hook",
      permissions: "docs.read",
      tags: ["Design", "Review", "Template"],
      statusLabel: "推荐",
      statusTone: "accent",
    },
    {
      id: "governance-pack",
      name: "Governance Pack",
      summary: "补充审计、预算和审批前置能力。",
      namespace: "market.governance",
      tools: "5 tools",
      hooks: "4 hooks",
      permissions: "audit.read",
      tags: ["Governance", "Budget", "Approval"],
      statusLabel: "官方",
      statusTone: "neutral",
    },
  ] satisfies readonly PluginCardViewModel[],
};

export const workflowBlueprint = {
  name: "需求分析 Playbook",
  summary: "先调度需求分析专家，再并行调度业务专家，最后走人工审核与文档产出。",
  statusLabel: "Draft Canvas",
  library: [
    { id: "start", shortLabel: "S", label: "开始", description: "流程入口节点。" },
    { id: "expert", shortLabel: "E", label: "专家 Agent", description: "绑定具体 ExpertAgent。" },
    { id: "router", shortLabel: "R", label: "路由", description: "根据条件做分支选择。" },
    { id: "merge", shortLabel: "M", label: "合并", description: "汇总多个专家输出。" },
    { id: "review", shortLabel: "H", label: "人工审核", description: "等待人工确认或修改。" },
    { id: "tool", shortLabel: "T", label: "工具节点", description: "直接调用托管工具。" },
    { id: "eval", shortLabel: "V", label: "评测节点", description: "自动校验产出质量。" },
    { id: "artifact", shortLabel: "A", label: "产物节点", description: "生成最终文档或交付物。" },
    { id: "end", shortLabel: "E", label: "结束", description: "工作流结束。" },
  ],
  nodes: [
    {
      id: "start-node",
      label: "Start",
      kindLabel: "开始",
      summary: "接收需求背景和输入附件。",
      binding: "workflow.input",
      inputContract: "需求文本 + 业务上下文",
      outputContract: "标准化需求输入",
      failurePolicy: "阻塞并回退到输入校验",
      humanIntervention: "不需要",
      left: 10,
      top: 38,
    },
    {
      id: "dispatch-node",
      label: "需求分析调度官",
      kindLabel: "专家 Agent",
      summary: "识别领域并生成并行专家任务。",
      binding: "req-orchestrator",
      inputContract: "标准化需求输入",
      outputContract: "专家任务计划 + 澄清问题草稿",
      failurePolicy: "重试 2 次，失败则人工介入",
      humanIntervention: "当专家分派不完整时需要人工确认",
      left: 31,
      top: 22,
    },
    {
      id: "order-node",
      label: "订单业务专家",
      kindLabel: "专家 Agent",
      summary: "分析订单域规则和影响面。",
      binding: "order-expert",
      inputContract: "调度官分派任务",
      outputContract: "订单影响面结论",
      failurePolicy: "失败则降级为仅输出风险提示",
      humanIntervention: "不需要",
      left: 54,
      top: 12,
    },
    {
      id: "member-node",
      label: "会员业务专家",
      kindLabel: "专家 Agent",
      summary: "补充会员域与权益链路影响。",
      binding: "member-domain-expert",
      inputContract: "调度官分派任务",
      outputContract: "会员影响面结论",
      failurePolicy: "失败则标记缺失领域结论",
      humanIntervention: "不需要",
      left: 54,
      top: 46,
    },
    {
      id: "merge-node",
      label: "专家结论汇总",
      kindLabel: "合并",
      summary: "聚合多专家结论并消除重复。",
      binding: "state.reducer",
      inputContract: "多专家输出",
      outputContract: "影响面汇总",
      failurePolicy: "阻塞后回退到人工整理",
      humanIntervention: "当冲突结论过多时需人工确认",
      left: 73,
      top: 29,
    },
    {
      id: "review-node",
      label: "人工审核",
      kindLabel: "人工审核",
      summary: "确认澄清问题与关键风险点。",
      binding: "human.review",
      inputContract: "影响面汇总",
      outputContract: "审核结论",
      failurePolicy: "等待人工恢复",
      humanIntervention: "必须人工确认后继续",
      left: 73,
      top: 62,
    },
    {
      id: "artifact-node",
      label: "需求分析报告",
      kindLabel: "产物节点",
      summary: "生成最终报告与引用清单。",
      binding: "artifact-writer",
      inputContract: "审核结论 + 引用来源",
      outputContract: "文档产物",
      failurePolicy: "失败后允许重新运行节点",
      humanIntervention: "可选人工润色",
      left: 90,
      top: 38,
    },
  ] satisfies readonly WorkflowNodeViewModel[],
  edges: [
    { id: "e1", left: 16, top: 44, width: 12 },
    { id: "e2", left: 39, top: 28, width: 12 },
    { id: "e3", left: 39, top: 41, width: 12 },
    { id: "e4", left: 62, top: 23, width: 9 },
    { id: "e5", left: 62, top: 53, width: 9 },
    { id: "e6", left: 79, top: 44, width: 8 },
  ],
};

export const workflowLibrary = {
  metrics: [
    { label: "运行中", value: "08", description: "当前活跃 workflow runs" },
    { label: "等待人工", value: "03", description: "需要审核或接管" },
    { label: "已完成", value: "41", description: "今日成功完成" },
    { label: "失败", value: "02", description: "需要复盘和重试" },
    { label: "今日新增", value: "14", description: "新发起任务数" },
  ],
};

export const taskBoardColumns: readonly TaskBoardColumnViewModel[] = [
  {
    id: "queued",
    label: "排队中",
    description: "已创建，等待调度。",
    countLabel: "2 tasks",
    badgeTone: "neutral" as const,
    items: [
      {
        id: "task-queued-1",
        title: "会员活动方案复盘",
        workflowName: "复盘报告 Playbook",
        currentStep: "等待 Worker 调度",
        ownerAgent: "scheduler",
        duration: "01m",
        requiresHuman: false,
        statusLabel: "Queued",
        statusTone: "neutral",
        timeline: [
          { id: "t1", time: "09:12", title: "任务创建", description: "已写入 workflow run，等待调度。" },
        ],
      },
    ],
  },
  {
    id: "running",
    label: "运行中",
    description: "正在执行专家或工具节点。",
    countLabel: "3 tasks",
    badgeTone: "accent" as const,
    items: [
      {
        id: "task-running-1",
        title: "订单系统改造需求分析",
        workflowName: "需求分析 Playbook",
        currentStep: "专家结论汇总",
        ownerAgent: "需求分析调度官",
        duration: "18m",
        requiresHuman: false,
        statusLabel: "Running",
        statusTone: "accent",
        timeline: [
          { id: "r1", time: "10:02", title: "任务启动", description: "输入需求背景并创建 workflow run。" },
          { id: "r2", time: "10:07", title: "并行专家完成", description: "订单和会员专家已返回领域结论。" },
          { id: "r3", time: "10:18", title: "汇总中", description: "正在合并冲突项与风险点。" },
        ],
      },
    ],
  },
  {
    id: "waiting",
    label: "等待人工",
    description: "运行被 review gate 或审批节点阻塞。",
    countLabel: "3 tasks",
    badgeTone: "warning" as const,
    items: [
      {
        id: "task-waiting-1",
        title: "支付链路技术方案审阅",
        workflowName: "技术方案生成",
        currentStep: "人工审核",
        ownerAgent: "架构评审专家",
        duration: "36m",
        requiresHuman: true,
        statusLabel: "Waiting",
        statusTone: "warning",
        timeline: [
          { id: "w1", time: "08:41", title: "方案已生成", description: "架构方案已生成，等待审核。" },
          { id: "w2", time: "08:55", title: "触发人工节点", description: "检测到跨系统 breaking change，需要审批。" },
        ],
      },
    ],
  },
  {
    id: "done",
    label: "已完成",
    description: "产物已生成，可查看 trace。",
    countLabel: "1 today",
    badgeTone: "success" as const,
    items: [
      {
        id: "task-done-1",
        title: "文档可信度校验",
        workflowName: "知识治理 Playbook",
        currentStep: "完成",
        ownerAgent: "治理校验专家",
        duration: "09m",
        requiresHuman: false,
        statusLabel: "Succeeded",
        statusTone: "success",
        timeline: [
          { id: "d1", time: "07:22", title: "校验完成", description: "文档已评分并产出治理建议。" },
        ],
      },
    ],
  },
];
