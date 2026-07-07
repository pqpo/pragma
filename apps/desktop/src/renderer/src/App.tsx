import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

import {
  agentCategories,
  agentTemplates,
  desktopStatus,
  modelProviders,
  pluginCatalog,
  registeredModels,
  taskBoardColumns,
  workflowBlueprint,
  workflowLibrary,
} from "./mock-data.ts";
import type {
  AgentCardViewModel,
  AgentCategory,
  DesktopViewKey,
  PluginCardViewModel,
  TaskBoardItemViewModel,
  WorkflowNodeViewModel,
} from "./mock-data.ts";
import { Drawer, Panel, SectionHeader, Sidebar, StatusBadge, Topbar } from "./ui.tsx";

const viewContent = {
  agents: {
    eyebrow: "Expert Agent Control",
    title: "Agent 广场",
    description: "创建、浏览并组合面向不同领域的专家 Agent 模板。",
    actionLabel: "创建 Agent",
  },
  models: {
    eyebrow: "Runtime Registry",
    title: "模型管理",
    description: "注册底层模型、设置 Provider 连接和默认执行策略。",
    actionLabel: "注册模型",
  },
  plugins: {
    eyebrow: "Extension Hub",
    title: "插件市场",
    description: "管理插件安装状态、权限声明与导入入口。",
    actionLabel: "导入插件",
  },
  workflows: {
    eyebrow: "Playbook Studio",
    title: "工作流编排",
    description: "以可视化画布方式组织专家、人工审核和产物节点。",
    actionLabel: "新建工作流",
  },
  tasks: {
    eyebrow: "Operations Board",
    title: "任务看板",
    description: "查看运行状态、等待人工介入的任务，并发起新的工作流任务。",
    actionLabel: "发起任务",
  },
} satisfies Record<
  DesktopViewKey,
  {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
    readonly actionLabel: string;
  }
>;

type DrawerState =
  | { readonly kind: "create-agent" }
  | { readonly kind: "register-model" }
  | { readonly kind: "import-plugin" }
  | { readonly kind: "create-workflow" }
  | { readonly kind: "launch-task" }
  | null;

export interface AppProps {
  readonly initialView?: DesktopViewKey;
  readonly initialAgentCategory?: AgentCategory;
  readonly initialSelectedAgentId?: string;
  readonly initialSelectedPluginId?: string;
  readonly initialSelectedWorkflowNodeId?: string;
  readonly initialSelectedTaskId?: string;
  readonly initialDrawerKind?: NonNullable<DrawerState>["kind"];
}

export function App(props: AppProps = {}) {
  const initialSelectedTask =
    taskBoardColumns
      .flatMap((column) => column.items)
      .find((task) => task.id === props.initialSelectedTaskId) ?? taskBoardColumns[1]?.items[0];

  const [activeView, setActiveView] = useState<DesktopViewKey>(props.initialView ?? "agents");
  const [selectedAgentCategory, setSelectedAgentCategory] = useState<AgentCategory>(
    props.initialAgentCategory ?? "all",
  );
  const [selectedAgent, setSelectedAgent] = useState<AgentCardViewModel>(
    agentTemplates.find((agent) => agent.id === props.initialSelectedAgentId) ?? requireValue(agentTemplates[0]),
  );
  const [selectedPlugin, setSelectedPlugin] = useState<PluginCardViewModel>(
    pluginCatalog.installed.find((plugin) => plugin.id === props.initialSelectedPluginId) ??
      requireValue(pluginCatalog.installed[0]),
  );
  const [selectedWorkflowNode, setSelectedWorkflowNode] = useState<WorkflowNodeViewModel>(
    workflowBlueprint.nodes.find((node) => node.id === props.initialSelectedWorkflowNodeId) ??
      requireValue(workflowBlueprint.nodes[1]),
  );
  const [selectedTask, setSelectedTask] = useState<TaskBoardItemViewModel>(
    requireValue(initialSelectedTask),
  );
  const [drawerState, setDrawerState] = useState<DrawerState>(
    props.initialDrawerKind === undefined ? null : { kind: props.initialDrawerKind },
  );

  const activeMeta = viewContent[activeView];

  const filteredAgents = useMemo(() => {
    if (selectedAgentCategory === "all") {
      return agentTemplates;
    }

    return agentTemplates.filter((agent) => agent.category === selectedAgentCategory);
  }, [selectedAgentCategory]);

  function openPrimaryAction(): void {
    switch (activeView) {
      case "agents":
        setDrawerState({ kind: "create-agent" });
        break;
      case "models":
        setDrawerState({ kind: "register-model" });
        break;
      case "plugins":
        setDrawerState({ kind: "import-plugin" });
        break;
      case "workflows":
        setDrawerState({ kind: "create-workflow" });
        break;
      case "tasks":
        setDrawerState({ kind: "launch-task" });
        break;
    }
  }

  return (
    <>
      <main className="workbench-shell">
        <Sidebar activeView={activeView} onSelectView={setActiveView} status={desktopStatus} />

        <section className="workbench-main">
          <Topbar
            eyebrow={activeMeta.eyebrow}
            title={activeMeta.title}
            description={activeMeta.description}
            actionLabel={activeMeta.actionLabel}
            onAction={openPrimaryAction}
          />

          <div className="page-scroll">
            {activeView === "agents" ? (
              <section className="page-grid page-grid--agents">
                <Panel>
                  <SectionHeader
                    title="创建入口"
                    description="从模板启动新的专家 Agent，并预览其能力边界。"
                    action={
                      <div className="chip-row">
                        {agentCategories.map((category) => (
                          <button
                            key={category.id}
                            type="button"
                            className={category.id === selectedAgentCategory ? "chip is-active" : "chip"}
                            onClick={() => setSelectedAgentCategory(category.id)}
                          >
                            {category.label}
                          </button>
                        ))}
                      </div>
                    }
                  />

                  <div className="card-grid">
                    {filteredAgents.map((agent) => (
                      <button
                        key={agent.id}
                        type="button"
                        className={agent.id === selectedAgent.id ? "surface-card is-selected" : "surface-card"}
                        onClick={() => setSelectedAgent(agent)}
                      >
                        <div className="surface-card__topline">
                          <StatusBadge tone={agent.badgeTone}>{agent.badge}</StatusBadge>
                          {agent.updatedLabel === undefined ? null : (
                            <span className="surface-card__meta">{agent.updatedLabel}</span>
                          )}
                        </div>
                        <strong>{agent.name}</strong>
                        <p>{agent.summary}</p>
                        <div className="tag-row">
                          {agent.tags.map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))}
                  </div>
                </Panel>

                <Panel>
                  <SectionHeader
                    title={selectedAgent.name}
                    description={selectedAgent.summary}
                    action={<StatusBadge tone={selectedAgent.badgeTone}>{selectedAgent.badge}</StatusBadge>}
                  />

                  <dl className="detail-list">
                    <div>
                      <dt>默认模型</dt>
                      <dd>{selectedAgent.defaultModel}</dd>
                    </div>
                    <div>
                      <dt>运行时</dt>
                      <dd>{selectedAgent.runtime}</dd>
                    </div>
                    <div>
                      <dt>插件组合</dt>
                      <dd>{selectedAgent.plugins.join(" / ")}</dd>
                    </div>
                    <div>
                      <dt>权限级别</dt>
                      <dd>{selectedAgent.permissionLevel}</dd>
                    </div>
                  </dl>

                  <div className="stack-list">
                    <Panel inset>
                      <h3>Manifest 预览</h3>
                      <p>{selectedAgent.manifestPreview}</p>
                    </Panel>
                    <Panel inset>
                      <h3>技能与上下文</h3>
                      <p>{selectedAgent.contextSummary}</p>
                    </Panel>
                  </div>
                </Panel>
              </section>
            ) : null}

            {activeView === "models" ? (
              <section className="stack-layout">
                <Panel>
                  <SectionHeader
                    title="Provider 概览"
                    description="系统可以同时挂载多个模型来源，并为不同场景设定默认策略。"
                  />

                  <div className="provider-grid">
                    {modelProviders.map((provider) => (
                      <article key={provider.id} className="provider-card">
                        <div className="provider-card__header">
                          <strong>{provider.name}</strong>
                          <StatusBadge tone={provider.statusTone}>{provider.statusLabel}</StatusBadge>
                        </div>
                        <p>{provider.summary}</p>
                        <div className="provider-card__metrics">
                          <span>{provider.modelsCount} models</span>
                          <span>{provider.region}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </Panel>

                <section className="page-grid page-grid--models">
                  <Panel>
                    <SectionHeader title="已注册模型" description="聚合查看名称、用途、成本等级与连通状态。" />

                    <div className="table-shell">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>模型</th>
                            <th>Provider</th>
                            <th>用途</th>
                            <th>上下文</th>
                            <th>成本</th>
                            <th>状态</th>
                            <th>最后检查</th>
                          </tr>
                        </thead>
                        <tbody>
                          {registeredModels.map((model) => (
                            <tr key={model.id}>
                              <td>
                                <strong>{model.name}</strong>
                              </td>
                              <td>{model.provider}</td>
                              <td>{model.defaultUse}</td>
                              <td>{model.contextWindow}</td>
                              <td>{model.costTier}</td>
                              <td>
                                <StatusBadge tone={model.statusTone}>{model.statusLabel}</StatusBadge>
                              </td>
                              <td>{model.lastCheckedAt}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>

                  <Panel>
                    <SectionHeader title="默认执行模型" description="工作台会优先把默认模型暴露给 Agent 创建和流程运行。" />
                    <article className="hero-card">
                      <div className="hero-card__eyebrow">Primary Runtime</div>
                      <h3>gpt-4.1-coder</h3>
                      <p>默认用于编排调度、代码生成与高复杂度工作流节点。</p>
                      <div className="tag-row">
                        <span className="tag">OpenAI</span>
                        <span className="tag">128K context</span>
                        <span className="tag">Tool calling</span>
                      </div>
                    </article>
                  </Panel>
                </section>
              </section>
            ) : null}

            {activeView === "plugins" ? (
              <section className="page-grid page-grid--plugins">
                <Panel>
                  <SectionHeader title="已安装插件" description="查看当前启用状态、兼容版本和权限敏感性。" />

                  <div className="stack-list">
                    {pluginCatalog.installed.map((plugin) => (
                      <button
                        key={plugin.id}
                        type="button"
                        className={plugin.id === selectedPlugin.id ? "surface-card is-selected" : "surface-card"}
                        onClick={() => setSelectedPlugin(plugin)}
                      >
                        <div className="surface-card__topline">
                          <strong>{plugin.name}</strong>
                          <StatusBadge tone={plugin.statusTone}>{plugin.statusLabel}</StatusBadge>
                        </div>
                        <p>{plugin.summary}</p>
                        <div className="tag-row">
                          {plugin.tags.map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))}
                  </div>
                </Panel>

                <Panel>
                  <SectionHeader title="插件清单预览" description="聚焦 manifest、权限声明与扩展能力。" />

                  <dl className="detail-list">
                    <div>
                      <dt>Namespace</dt>
                      <dd>{selectedPlugin.namespace}</dd>
                    </div>
                    <div>
                      <dt>Tools</dt>
                      <dd>{selectedPlugin.tools}</dd>
                    </div>
                    <div>
                      <dt>Hooks</dt>
                      <dd>{selectedPlugin.hooks}</dd>
                    </div>
                    <div>
                      <dt>Permissions</dt>
                      <dd>{selectedPlugin.permissions}</dd>
                    </div>
                  </dl>

                  <Panel inset>
                    <h3>导入入口</h3>
                    <div className="option-grid">
                      <article className="option-card">
                        <strong>本地目录导入</strong>
                        <p>选择本地插件目录，预览 manifest 与能力声明。</p>
                      </article>
                      <article className="option-card">
                        <strong>压缩包导入</strong>
                        <p>导入 zip 包并展示兼容性和权限风险。</p>
                      </article>
                      <article className="option-card">
                        <strong>清单预审</strong>
                        <p>先读取 plugin.json，确认 namespace 和导出能力。</p>
                      </article>
                    </div>
                  </Panel>
                </Panel>

                <Panel>
                  <SectionHeader title="市场推荐" description="未来可以从官方和团队市场安装能力包。" />
                  <div className="card-grid">
                    {pluginCatalog.market.map((plugin) => (
                      <article key={plugin.id} className="surface-card is-readonly">
                        <div className="surface-card__topline">
                          <strong>{plugin.name}</strong>
                          <StatusBadge tone={plugin.statusTone}>{plugin.statusLabel}</StatusBadge>
                        </div>
                        <p>{plugin.summary}</p>
                        <div className="tag-row">
                          {plugin.tags.map((tag) => (
                            <span key={tag} className="tag">
                              {tag}
                            </span>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </Panel>
              </section>
            ) : null}

            {activeView === "workflows" ? (
              <section className="workflow-studio">
                <div className="workflow-toolbar">
                  <div className="workflow-toolbar__group">
                    <button type="button" className="toolbar-button">
                      新建
                    </button>
                    <button type="button" className="toolbar-button">
                      保存草稿
                    </button>
                    <button type="button" className="toolbar-button toolbar-button--accent">
                      测试运行
                    </button>
                    <button type="button" className="toolbar-button">
                      发布
                    </button>
                  </div>
                  <div className="workflow-toolbar__group">
                    <span className="toolbar-pill">100%</span>
                    <span className="toolbar-pill">Grid View</span>
                  </div>
                </div>

                <div className="workflow-layout">
                  <Panel>
                    <SectionHeader title="节点库" description="当前版本先表达低码工作流的核心节点类型。" />
                    <div className="node-library">
                      {workflowBlueprint.library.map((nodeType) => (
                        <button key={nodeType.id} type="button" className="node-library__item">
                          <span className="node-chip">{nodeType.shortLabel}</span>
                          <div>
                            <strong>{nodeType.label}</strong>
                            <p>{nodeType.description}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  </Panel>

                  <Panel>
                    <SectionHeader
                      title={workflowBlueprint.name}
                      description={workflowBlueprint.summary}
                      action={<StatusBadge tone="accent">{workflowBlueprint.statusLabel}</StatusBadge>}
                    />

                    <div className="canvas-shell" aria-label="workflow canvas">
                      {workflowBlueprint.edges.map((edge) => (
                        <span
                          key={edge.id}
                          className="canvas-edge"
                          style={
                            {
                              "--edge-left": `${edge.left}%`,
                              "--edge-top": `${edge.top}%`,
                              "--edge-width": `${edge.width}%`,
                            } as CSSProperties
                          }
                        />
                      ))}

                      {workflowBlueprint.nodes.map((node) => (
                        <button
                          key={node.id}
                          type="button"
                          className={node.id === selectedWorkflowNode.id ? "canvas-node is-selected" : "canvas-node"}
                          style={{ left: `${node.left}%`, top: `${node.top}%` }}
                          onClick={() => setSelectedWorkflowNode(node)}
                        >
                          <span className="canvas-node__type">{node.kindLabel}</span>
                          <strong>{node.label}</strong>
                          <p>{node.summary}</p>
                        </button>
                      ))}

                      <button type="button" className="canvas-insert">
                        + 插入节点
                      </button>
                    </div>
                  </Panel>

                  <Panel>
                    <SectionHeader title="节点属性" description="当前选中节点的输入、输出与人工介入配置。" />

                    <dl className="detail-list">
                      <div>
                        <dt>节点类型</dt>
                        <dd>{selectedWorkflowNode.kindLabel}</dd>
                      </div>
                      <div>
                        <dt>绑定对象</dt>
                        <dd>{selectedWorkflowNode.binding}</dd>
                      </div>
                      <div>
                        <dt>输入契约</dt>
                        <dd>{selectedWorkflowNode.inputContract}</dd>
                      </div>
                      <div>
                        <dt>失败策略</dt>
                        <dd>{selectedWorkflowNode.failurePolicy}</dd>
                      </div>
                    </dl>

                    <div className="stack-list">
                      <Panel inset>
                        <h3>输出结果</h3>
                        <p>{selectedWorkflowNode.outputContract}</p>
                      </Panel>
                      <Panel inset>
                        <h3>人工介入策略</h3>
                        <p>{selectedWorkflowNode.humanIntervention}</p>
                      </Panel>
                    </div>
                  </Panel>
                </div>
              </section>
            ) : null}

            {activeView === "tasks" ? (
              <section className="stack-layout">
                <div className="metric-grid">
                  {workflowLibrary.metrics.map((metric) => (
                    <Panel key={metric.label} inset>
                      <div className="metric-card">
                        <span>{metric.label}</span>
                        <strong>{metric.value}</strong>
                        <p>{metric.description}</p>
                      </div>
                    </Panel>
                  ))}
                </div>

                <section className="page-grid page-grid--tasks">
                  <div className="kanban-shell">
                    {taskBoardColumns.map((column) => (
                      <Panel key={column.id}>
                        <SectionHeader
                          title={column.label}
                          description={column.description}
                          action={<StatusBadge tone={column.badgeTone}>{column.countLabel}</StatusBadge>}
                        />

                        <div className="kanban-column">
                          {column.items.map((task) => (
                            <button
                              key={task.id}
                              type="button"
                              className={task.id === selectedTask.id ? "task-card is-selected" : "task-card"}
                              onClick={() => setSelectedTask(task)}
                            >
                              <div className="surface-card__topline">
                                <strong>{task.title}</strong>
                                <StatusBadge tone={task.statusTone}>{task.statusLabel}</StatusBadge>
                              </div>
                              <p>{task.workflowName}</p>
                              <div className="task-card__meta">
                                <span>{task.currentStep}</span>
                                <span>{task.duration}</span>
                              </div>
                              {task.requiresHuman ? (
                                <span className="task-card__alert">需要人工接入</span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </Panel>
                    ))}
                  </div>

                  <Panel>
                    <SectionHeader
                      title={selectedTask.title}
                      description={selectedTask.workflowName}
                      action={<StatusBadge tone={selectedTask.statusTone}>{selectedTask.statusLabel}</StatusBadge>}
                    />

                    <dl className="detail-list">
                      <div>
                        <dt>当前步骤</dt>
                        <dd>{selectedTask.currentStep}</dd>
                      </div>
                      <div>
                        <dt>责任 Agent</dt>
                        <dd>{selectedTask.ownerAgent}</dd>
                      </div>
                      <div>
                        <dt>耗时</dt>
                        <dd>{selectedTask.duration}</dd>
                      </div>
                      <div>
                        <dt>人工接入</dt>
                        <dd>{selectedTask.requiresHuman ? "Required" : "Not needed"}</dd>
                      </div>
                    </dl>

                    <div className="timeline">
                      {selectedTask.timeline.map((event) => (
                        <article key={event.id} className="timeline__item">
                          <span className="timeline__time">{event.time}</span>
                          <div>
                            <strong>{event.title}</strong>
                            <p>{event.description}</p>
                          </div>
                        </article>
                      ))}
                    </div>

                    <div className="action-row">
                      <button type="button" className="toolbar-button toolbar-button--accent">
                        接管任务
                      </button>
                      <button type="button" className="toolbar-button">
                        继续观察
                      </button>
                      <button type="button" className="toolbar-button">
                        重新运行
                      </button>
                    </div>
                  </Panel>
                </section>
              </section>
            ) : null}
          </div>
        </section>
      </main>

      <Drawer
        open={drawerState !== null}
        title={resolveDrawerTitle(drawerState)}
        description={resolveDrawerDescription(drawerState)}
        onClose={() => setDrawerState(null)}
      >
        {drawerState?.kind === "create-agent" ? (
          <div className="form-layout">
            <label>
              Agent 名称
              <input type="text" value="需求分析调度官" readOnly />
            </label>
            <label>
              角色定位
              <textarea readOnly value="负责拆解需求、调度业务专家并汇总关键结论。" />
            </label>
            <label>
              默认模型
              <input type="text" value="gpt-4.1-coder" readOnly />
            </label>
            <label>
              运行时
              <input type="text" value="cloud-pi-agent" readOnly />
            </label>
            <label>
              插件组合
              <input type="text" value="repo-inspector / context-memory / reviewer" readOnly />
            </label>
            <label>
              权限级别
              <input type="text" value="requires approval for shell + write" readOnly />
            </label>
          </div>
        ) : null}

        {drawerState?.kind === "register-model" ? (
          <div className="form-layout">
            <label>
              Provider
              <input type="text" value="OpenAI" readOnly />
            </label>
            <label>
              Base URL
              <input type="text" value="https://api.openai.com/v1" readOnly />
            </label>
            <label>
              API Key
              <input type="password" value="sk-********************************" readOnly />
            </label>
            <label>
              模型 ID
              <input type="text" value="gpt-4.1-coder" readOnly />
            </label>
            <label>
              能力标签
              <input type="text" value="tool-calling, long-context, code" readOnly />
            </label>
          </div>
        ) : null}

        {drawerState?.kind === "import-plugin" ? (
          <div className="form-layout">
            <label>
              导入方式
              <input type="text" value="本地目录 / 压缩包 / 清单预审" readOnly />
            </label>
            <label>
              插件路径
              <input type="text" value="/plugins/repo-inspector" readOnly />
            </label>
            <label>
              Manifest 预览
              <textarea
                readOnly
                value={`namespace: repo-inspector\nhooks: 2\ntools: 4\npermissions: workspace.read`}
              />
            </label>
          </div>
        ) : null}

        {drawerState?.kind === "create-workflow" ? (
          <div className="form-layout">
            <label>
              工作流名称
              <input type="text" value="技术方案生成" readOnly />
            </label>
            <label>
              流程类型
              <input type="text" value="可视化画布 Playbook" readOnly />
            </label>
            <label>
              发布策略
              <input type="text" value="草稿 / 测试运行 / 发布" readOnly />
            </label>
            <label>
              人工审核节点
              <textarea readOnly value="架构评审后进入人工审核，再生成最终方案文档。" />
            </label>
          </div>
        ) : null}

        {drawerState?.kind === "launch-task" ? (
          <div className="form-layout">
            <label>
              选择工作流
              <input type="text" value="需求分析 Playbook" readOnly />
            </label>
            <label>
              任务标题
              <input type="text" value="订单系统改造需求分析" readOnly />
            </label>
            <label>
              输入摘要
              <textarea readOnly value="用户提交了改造目标、上下游系统与预期产物，等待执行。" />
            </label>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

function resolveDrawerTitle(drawerState: DrawerState): string {
  switch (drawerState?.kind) {
    case "create-agent":
      return "创建 Agent";
    case "register-model":
      return "注册模型";
    case "import-plugin":
      return "导入插件";
    case "create-workflow":
      return "新建工作流";
    case "launch-task":
      return "发起任务";
    default:
      return "";
  }
}

function resolveDrawerDescription(drawerState: DrawerState): string {
  switch (drawerState?.kind) {
    case "create-agent":
      return "这里只展示 Agent 创建表单的工作台交互，不提交任何数据。";
    case "register-model":
      return "这里只展示模型注册面板，不执行真实 Provider 校验。";
    case "import-plugin":
      return "这里只展示插件导入和 manifest 预览交互，不做安装。";
    case "create-workflow":
      return "这里只展示工作流新建入口，不保存画布状态。";
    case "launch-task":
      return "这里只展示发起任务面板，不启动真实 workflow run。";
    default:
      return "";
  }
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected static desktop mock data to be present.");
  }

  return value;
}
