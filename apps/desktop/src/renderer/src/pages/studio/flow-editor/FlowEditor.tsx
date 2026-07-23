import {
  ArrowLeft,
  ArrowsOut,
  Brain,
  CheckCircle,
  CirclesFour,
  Code,
  GitBranch,
  Hand,
  Path,
  Plus,
  Robot,
  Sparkle,
  Trash,
  UserFocus,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import type {
  PragmaFlowPrompt,
  PragmaFlowVariable,
  PragmaFlowDestination,
  PragmaFlowResource,
  PragmaFlowTransition,
  PragmaJsonSchema,
  PragmaResource,
} from "@pragma/interpreter/ast";
import {
  analyzePragmaFlowNodeAvailability,
  canonicalPragmaResourceRef,
  PragmaRuntimeProfileConfigSchema,
  PragmaRuntimeProfileResourceSchema,
} from "@pragma/interpreter/ast";
import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnMoveEnd,
  type Viewport,
} from "@xyflow/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { stringify } from "yaml";

import type {
  DesktopRuntimeAvailability,
  DesktopRuntimeModel,
  PragmaProjectSnapshot,
  WorkflowLayout,
} from "../../../../../shared/desktop-api.ts";
import { errorMessage } from "../../../lib/errors.ts";
import { desktopApi } from "../studio-model.ts";
import {
  SchemaFieldsEditor,
  fieldsToObjectSchema,
  objectSchemaToFields,
  type SchemaFieldDraft,
} from "../JsonSchemaFieldsEditor.tsx";
import {
  createEmptyFlow,
  deleteFlowStep,
  destinationTarget,
  flowStepKind,
  flowStepTarget,
  isFlowStepKind,
  renameFlowStep,
  transitionMode,
  validateFlowDraft,
  type FlowStep,
  type FlowStepKind,
  type FlowValidationIssue,
} from "./flow-model.ts";
import "@xyflow/react/dist/style.css";

export const START_NODE_ID = "__pragma_canvas_start__";
export const END_NODE_ID = "__pragma_canvas_end__";
export const FAIL_NODE_ID = "__pragma_canvas_fail__";
const NODE_WIDTH = 238;
const NODE_HEIGHT = 104;
const TERMINAL_NODE_WIDTH = 112;
const TERMINAL_HORIZONTAL_GAP = 180;
const NODE_HORIZONTAL_GAP = 36;
const NODE_VERTICAL_GAP = 28;

interface StepNodeData extends Record<string, unknown> {
  readonly kind: FlowStepKind;
  readonly label: string;
  readonly subtitle: string;
  readonly outputs: readonly { readonly id: string; readonly label: string }[];
  readonly invalid: boolean;
}

interface TerminalNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly tone: "start" | "end" | "fail";
}

type StepCanvasNode = Node<StepNodeData, "step">;
type TerminalCanvasNode = Node<TerminalNodeData, "terminal">;
type WorkflowCanvasNode = StepCanvasNode | TerminalCanvasNode;

interface EditorSnapshot {
  readonly flow: PragmaFlowResource;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
}

interface NodeContextMenuState {
  readonly stepId: string;
  readonly x: number;
  readonly y: number;
}

export function FlowEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly runtimes?: readonly DesktopRuntimeAvailability[] | undefined;
  readonly initial?: PragmaFlowResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (
    resource: PragmaFlowResource,
    supportingResources: readonly PragmaResource[],
  ) => Promise<boolean>;
}) {
  return (
    <ReactFlowProvider>
      <FlowEditorCanvas {...props} runtimes={props.runtimes ?? []} />
    </ReactFlowProvider>
  );
}

function FlowEditorCanvas(props: {
  readonly project: PragmaProjectSnapshot;
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly initial?: PragmaFlowResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (
    resource: PragmaFlowResource,
    supportingResources: readonly PragmaResource[],
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation("studio");
  const initialFlow = useMemo(
    () => props.initial ?? createEmptyFlow(nextFlowResourceId(props.project.resources)),
    [props.initial, props.project.resources],
  );
  const baselineRef = useRef(JSON.stringify(initialFlow));
  const [flow, setFlow] = useState<PragmaFlowResource>(initialFlow);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasNode>(
    buildCanvasNodes(initialFlow, {}),
  );
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [candidateIssues, setCandidateIssues] = useState<readonly string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [supportingResources, setSupportingResources] = useState<readonly PragmaResource[]>([]);
  const [layoutStatus, setLayoutStatus] = useState<"saved" | "saving" | "unsaved">("saved");
  const historyRef = useRef<EditorSnapshot[]>([]);
  const futureRef = useRef<EditorSnapshot[]>([]);
  const dragSnapshotRef = useRef<EditorSnapshot | null>(null);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const { fitView, getViewport, screenToFlowPosition, setViewport } = useReactFlow<
    WorkflowCanvasNode,
    Edge
  >();

  const semanticDirty = JSON.stringify(flow) !== baselineRef.current;
  const editorResources = useMemo(
    () => mergePragmaResources(props.project.resources, supportingResources),
    [props.project.resources, supportingResources],
  );
  const localIssues = useMemo(
    () => [...validateFlowDraft(flow), ...validateFlowRuntimeSelections(flow, editorResources)],
    [editorResources, flow],
  );
  const invalidStepIds = useMemo(
    () => new Set(localIssues.map((issue) => issue.stepId).filter((id): id is string => !!id)),
    [localIssues],
  );
  const targets = useMemo(
    () => resourceTargets(props.project.resources, flow.metadata.id),
    [flow.metadata.id, props.project.resources],
  );

  const positions = useCallback(() => canvasPositions(nodes), [nodes]);
  const snapshot = useCallback(
    (): EditorSnapshot => ({ flow: structuredClone(flow), positions: positions() }),
    [flow, positions],
  );

  const commitFlow = useCallback(
    (
      next: PragmaFlowResource,
      nextPositions?: Readonly<Record<string, { x: number; y: number }>>,
      nextSelectedStepId = selectedStepId,
    ) => {
      if (JSON.stringify(next) === JSON.stringify(flow) && nextPositions === undefined) return;
      historyRef.current.push(snapshot());
      futureRef.current = [];
      setFlow(next);
      if (nextPositions !== undefined) {
        setNodes(buildCanvasNodes(next, nextPositions, invalidStepIds, nextSelectedStepId));
      }
    },
    [flow, invalidStepIds, selectedStepId, setNodes, snapshot],
  );

  const restoreSnapshot = useCallback(
    (next: EditorSnapshot) => {
      const nextSelectedStepId =
        selectedStepId !== null && next.flow.spec.graph.steps[selectedStepId] !== undefined
          ? selectedStepId
          : null;
      setFlow(structuredClone(next.flow));
      setNodes(buildCanvasNodes(next.flow, next.positions, new Set(), nextSelectedStepId));
      setSelectedStepId(nextSelectedStepId);
      setLayoutStatus("unsaved");
    },
    [selectedStepId, setNodes],
  );

  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (previous === undefined) return;
    futureRef.current.push(snapshot());
    restoreSnapshot(previous);
  }, [restoreSnapshot, snapshot]);

  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (next === undefined) return;
    historyRef.current.push(snapshot());
    restoreSnapshot(next);
  }, [restoreSnapshot, snapshot]);

  const persistLayout = useCallback(
    async (force = false) => {
      const api = desktopApi();
      if (api === undefined || flow.metadata.id.trim() === "" || (semanticDirty && !force)) {
        setLayoutStatus("unsaved");
        return false;
      }
      setLayoutStatus("saving");
      try {
        await api.saveWorkflowLayout({
          schemaVersion: "pragma.desktop-flow-layout/v1",
          projectId: props.project.projectId,
          flowId: flow.metadata.id,
          flowVersion: flow.metadata.version,
          nodes: positions(),
          viewport: getViewport(),
          updatedAt: new Date().toISOString(),
        });
        setLayoutStatus("saved");
        return true;
      } catch (cause) {
        setLocalError(`Flow is published, but the layout was not saved: ${errorMessage(cause)}`);
        setLayoutStatus("unsaved");
        return false;
      }
    },
    [
      flow.metadata.id,
      flow.metadata.version,
      getViewport,
      positions,
      props.project.projectId,
      semanticDirty,
    ],
  );

  const scheduleLayoutSave = useCallback(() => {
    setLayoutStatus("unsaved");
    if (layoutTimerRef.current !== null) clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = setTimeout(() => void persistLayout(), 500);
  }, [persistLayout]);

  useEffect(() => {
    let cancelled = false;
    const api = desktopApi();
    if (api === undefined || initialFlow.metadata.id.trim() === "") return;
    void api
      .getWorkflowLayout({ projectId: props.project.projectId, flowId: initialFlow.metadata.id })
      .then((layout) => {
        if (cancelled) return;
        setNodes(buildCanvasNodes(initialFlow, layout?.nodes ?? {}));
        if (layout !== null) void setViewport(layout.viewport, { duration: 0 });
        else
          requestAnimationFrame(
            () => void fitView({ padding: 0.08, minZoom: 0.55, maxZoom: 1, duration: 240 }),
          );
      })
      .catch((cause: unknown) => {
        if (!cancelled) setLocalError(`Layout could not be loaded: ${errorMessage(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [fitView, initialFlow, props.project.projectId, setNodes, setViewport]);

  useEffect(() => {
    setNodes((current) => {
      const selectedStep = current.find((node) => node.type === "step" && node.selected);
      return buildCanvasNodes(
        flow,
        canvasPositions(current),
        invalidStepIds,
        selectedStep?.id ?? null,
      );
    });
  }, [flow, invalidStepIds, setNodes]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      )
        return;
      const modifier = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        setNodeContextMenu(null);
      } else if (modifier && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void publish();
      } else if (modifier && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (modifier && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedStepId !== null) {
        event.preventDefault();
        removeStep(selectedStepId);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  const patchFlow = (mutator: (copy: PragmaFlowResource) => void) => {
    const copy = structuredClone(flow);
    mutator(copy);
    commitFlow(copy);
  };

  const addStep = (kind: FlowStepKind, position?: { x: number; y: number }) => {
    const id = nextStepId(flow, kind);
    const copy = structuredClone(flow);
    copy.spec.graph.steps[id] = defaultStep(kind, targets);
    if (Object.keys(copy.spec.graph.steps).length === 1) copy.spec.graph.start = id;
    const currentPositions = positions();
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    const viewportCenter =
      canvasBounds === undefined
        ? { x: 180 + NODE_WIDTH / 2, y: 180 + NODE_HEIGHT / 2 }
        : screenToFlowPosition({
            x: canvasBounds.left + canvasBounds.width / 2,
            y: canvasBounds.top + canvasBounds.height / 2,
          });
    const nextPosition =
      position ??
      nextAvailableNodePosition(currentPositions, {
        x: viewportCenter.x - NODE_WIDTH / 2,
        y: viewportCenter.y - NODE_HEIGHT / 2,
      });
    commitFlow(copy, { ...currentPositions, [id]: nextPosition }, id);
    setSelectedStepId(id);
    setInspectorOpen(true);
  };

  const removeStep = (stepId: string) => {
    commitFlow(deleteFlowStep(flow, stepId));
    setSelectedStepId(null);
    setNodeContextMenu(null);
  };

  const setConnection = (connection: Connection) => {
    if (connection.target === null || connection.source === null) return;
    const destination = connectionDestination(connection.target);
    if (connection.source === START_NODE_ID) {
      if (destination !== null && typeof destination === "object" && "goto" in destination) {
        patchFlow((copy) => {
          copy.spec.graph.start = destination.goto;
        });
      }
      return;
    }
    if (flow.spec.graph.steps[connection.source] === undefined || destination === null) return;
    patchFlow((copy) => applyConnection(copy, connection, destination));
  };

  const reconnect = (edge: Edge, connection: Connection) => {
    if (connection.target === null || connection.source === null) return;
    const destination = connectionDestination(connection.target);
    if (destination === null) return;
    const copy = structuredClone(flow);
    removeEdgeFromFlow(copy, edge);
    applyConnection(copy, connection, destination);
    commitFlow(copy);
  };

  const disconnect = (deletedEdges: readonly Edge[]) => {
    const copy = structuredClone(flow);
    for (const edge of deletedEdges) removeEdgeFromFlow(copy, edge);
    commitFlow(copy);
  };

  const edges = useMemo(() => buildCanvasEdges(flow), [flow]);

  const publish = async () => {
    const api = desktopApi();
    if (api === undefined || saving) return;
    setCandidateIssues([]);
    setLocalError(null);
    if (localIssues.length > 0) {
      setValidationOpen(true);
      return;
    }
    setSaving(true);
    try {
      const result = await api.validatePragmaProjectChanges({
        expectedRevision: props.project.revision,
        upserts: [...supportingResources, flow],
        removals: [],
      });
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        setCandidateIssues(errors.map((diagnostic) => diagnostic.message));
        setValidationOpen(true);
        return;
      }
      if (!(await props.onSave(flow, supportingResources))) return;
      baselineRef.current = JSON.stringify(flow);
      if (await persistLayout(true)) props.onCancel();
    } catch (cause) {
      setLocalError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    if ((semanticDirty || layoutStatus === "unsaved") && !window.confirm(t("discardFlowChanges")))
      return;
    props.onCancel();
  };

  const handleMoveEnd: OnMoveEnd = () => scheduleLayoutSave();

  return (
    <section className="flow-editor-shell" aria-label={t("flowEditor")}>
      <header className="flow-editor-toolbar">
        <div className="flow-editor-title">
          <button type="button" aria-label={t("backFlows")} onClick={handleBack}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <strong>{flow.metadata.name || t("untitledFlow")}</strong>
            <span>
              {semanticDirty ? t("unpublishedChanges") : t("published")} ·{" "}
              {t("layoutStatus", { status: layoutStatus })}
            </span>
          </div>
        </div>
        <div className="flow-editor-toolbar-actions">
          <button type="button" disabled={historyRef.current.length === 0} onClick={undo}>
            {t("undo")}
          </button>
          <button type="button" disabled={futureRef.current.length === 0} onClick={redo}>
            {t("redo")}
          </button>
          <button
            type="button"
            onClick={() => {
              const arranged = automaticPositions(flow);
              historyRef.current.push(snapshot());
              futureRef.current = [];
              setNodes(buildCanvasNodes(flow, arranged, invalidStepIds, selectedStepId));
              scheduleLayoutSave();
            }}
          >
            <CirclesFour size={16} /> {t("autoArrange")}
          </button>
          <button type="button" onClick={() => void fitView({ padding: 0.08, duration: 220 })}>
            <ArrowsOut size={16} /> {t("fit")}
          </button>
          <button
            className="flow-validate-button"
            type="button"
            onClick={() => setValidationOpen(!validationOpen)}
          >
            <CheckCircle size={16} />
            {localIssues.length + candidateIssues.length > 0
              ? t("issueCount", { count: localIssues.length + candidateIssues.length })
              : t("check")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => void publish()}
          >
            {saving ? t("validating") : t("validatePublish")}
          </button>
        </div>
      </header>

      <div className="flow-editor-workspace">
        <aside className={paletteOpen ? "flow-node-palette" : "flow-node-palette is-collapsed"}>
          <button
            className="flow-panel-toggle"
            type="button"
            aria-label={paletteOpen ? t("collapseNodePalette") : t("openNodePalette")}
            onClick={() => setPaletteOpen(!paletteOpen)}
          >
            <Plus size={17} /> <span>{t("addNode")}</span>
          </button>
          {paletteOpen ? (
            <div className="flow-palette-content">
              <p>{t("dragNode")}</p>
              <div className="flow-palette-group">
                <strong>{t("executors")}</strong>
                <PaletteItem kind="expert" icon={<Robot />} label={t("expert")} />
                <PaletteItem kind="team" icon={<UsersThree />} label={t("expertTeam")} />
                <PaletteItem kind="flow" icon={<GitBranch />} label={t("subFlow")} />
              </div>
              <div className="flow-palette-group">
                <strong>{t("control")}</strong>
                <PaletteItem kind="human" icon={<UserFocus />} label={t("humanInput")} />
              </div>
            </div>
          ) : null}
        </aside>

        <div
          ref={canvasRef}
          className="flow-canvas"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const kind = event.dataTransfer.getData("application/pragma-flow-node");
            if (!isFlowStepKind(kind)) return;
            addStep(kind, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
          }}
        >
          <ReactFlow<WorkflowCanvasNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onConnect={setConnection}
            onReconnect={reconnect}
            onEdgesDelete={disconnect}
            onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
              const selectedNode = selectedEdges.length === 0 ? selectedNodes[0] : undefined;
              setSelectedStepId(selectedNode?.type === "step" ? selectedNode.id : null);
            }}
            onNodeClick={(_event, node) => {
              setNodeContextMenu(null);
              if (node.type === "step") {
                setSelectedStepId(node.id);
                setInspectorOpen(true);
              } else setSelectedStepId(null);
            }}
            onEdgeClick={() => {
              setSelectedStepId(null);
              setNodeContextMenu(null);
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              if (node.type !== "step") {
                setNodeContextMenu(null);
                return;
              }
              const bounds = canvasRef.current?.getBoundingClientRect();
              if (bounds === undefined) return;
              setSelectedStepId(node.id);
              setNodeContextMenu({
                stepId: node.id,
                x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 154)),
                y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 52)),
              });
            }}
            onPaneClick={() => {
              setSelectedStepId(null);
              setNodeContextMenu(null);
            }}
            onNodeDragStart={() => {
              setNodeContextMenu(null);
              dragSnapshotRef.current = snapshot();
            }}
            onNodeDragStop={() => {
              if (dragSnapshotRef.current !== null)
                historyRef.current.push(dragSnapshotRef.current);
              dragSnapshotRef.current = null;
              futureRef.current = [];
              scheduleLayoutSave();
            }}
            onMoveEnd={handleMoveEnd}
            minZoom={0.25}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.08, minZoom: 0.55, maxZoom: 1 }}
            deleteKeyCode={["Backspace", "Delete"]}
            nodesFocusable
            edgesFocusable
            connectionRadius={24}
            defaultEdgeOptions={{ type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed } }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.3} color="#c8d1ca" />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              className="flow-minimap"
              nodeColor={(node) => (node.type === "terminal" ? "#87938b" : "#5e806f")}
            />
            <Panel position="bottom-left" className="flow-canvas-hint">
              <Hand size={15} /> {t("canvasHint")}
            </Panel>
          </ReactFlow>
          {nodeContextMenu !== null ? (
            <div
              className="flow-node-context-menu"
              role="menu"
              aria-label={`${nodeContextMenu.stepId} actions`}
              style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => removeStep(nodeContextMenu.stepId)}
              >
                <Trash size={15} /> {t("deleteNode")}
              </button>
            </div>
          ) : null}
        </div>

        <aside className={inspectorOpen ? "flow-inspector" : "flow-inspector is-collapsed"}>
          <button
            className="flow-panel-toggle"
            type="button"
            aria-label={inspectorOpen ? t("collapseInspector") : t("openInspector")}
            onClick={() => setInspectorOpen(!inspectorOpen)}
          >
            <Path size={17} /> <span>{t("inspector")}</span>
          </button>
          {inspectorOpen ? (
            selectedStepId === null ? (
              <FlowSettings flow={flow} lockId={props.initial !== undefined} onPatch={patchFlow} />
            ) : (
              <StepInspector
                flow={flow}
                stepId={selectedStepId}
                targets={targets}
                runtimes={props.runtimes}
                resources={editorResources}
                onSupportingResource={(resource) =>
                  setSupportingResources((current) => mergePragmaResources(current, [resource]))
                }
                onPatch={patchFlow}
                onRename={(nextId) => {
                  const next = renameFlowStep(flow, selectedStepId, nextId);
                  if (next === flow) return;
                  const nextPositions = { ...positions(), [nextId]: positions()[selectedStepId]! };
                  delete nextPositions[selectedStepId];
                  commitFlow(next, nextPositions);
                  setSelectedStepId(nextId);
                }}
                onDelete={() => removeStep(selectedStepId)}
              />
            )
          ) : null}
        </aside>
      </div>

      {validationOpen ? (
        <aside className="flow-validation-panel">
          <header>
            <strong>{t("validation")}</strong>
            <button type="button" onClick={() => setValidationOpen(false)}>
              {t("close")}
            </button>
          </header>
          {localIssues.length === 0 && candidateIssues.length === 0 ? (
            <p className="flow-validation-success">
              <CheckCircle size={17} /> {t("flowValid")}
            </p>
          ) : (
            <ul>
              {localIssues.map((issue, index) => (
                <li key={`${issue.message}-${index}`}>
                  <button
                    type="button"
                    onClick={() => issue.stepId && setSelectedStepId(issue.stepId)}
                  >
                    {issue.message}
                  </button>
                </li>
              ))}
              {candidateIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </aside>
      ) : null}
      {(localError ?? props.error) ? (
        <p className="flow-editor-error" role="alert">
          {localError ?? props.error}
        </p>
      ) : null}
    </section>
  );
}

function PaletteItem(props: {
  readonly kind: FlowStepKind;
  readonly label: string;
  readonly icon: ReactNode;
}) {
  const { t } = useTranslation("studio");
  return (
    <div
      className={`flow-palette-item is-${props.kind}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/pragma-flow-node", props.kind);
      }}
      aria-label={t("dragNamedCanvas", { name: props.label })}
    >
      <span>{props.icon}</span>
      <div>
        <strong>{props.label}</strong>
        <small>{t("dragCanvas")}</small>
      </div>
    </div>
  );
}

function StepNode(props: NodeProps<StepCanvasNode>) {
  const { t } = useTranslation("studio");
  const Icon =
    props.data.kind === "expert"
      ? Robot
      : props.data.kind === "team"
        ? UsersThree
        : props.data.kind === "flow"
          ? GitBranch
          : props.data.kind === "action"
            ? Sparkle
            : UserFocus;
  const singleOutput =
    props.data.outputs.length === 1 && props.data.outputs[0]?.id === "default"
      ? props.data.outputs[0]
      : undefined;
  return (
    <article
      className={`flow-step-node is-${props.data.kind}${props.selected ? " is-selected" : ""}${props.data.invalid ? " is-invalid" : ""}`}
    >
      <Handle type="target" id="target" position={Position.Left} />
      <span className="flow-step-kind">{props.data.kind}</span>
      <div className="flow-step-main">
        <span className="flow-step-icon">
          <Icon size={18} />
        </span>
        <div>
          <strong>{props.data.label}</strong>
          <small>{props.data.subtitle || t("notConfigured")}</small>
        </div>
      </div>
      {singleOutput === undefined ? (
        <div className="flow-step-outputs">
          {props.data.outputs.map((output) => (
            <span key={output.id}>
              {output.label}
              <Handle
                type="source"
                id={output.id}
                position={Position.Right}
                className="flow-step-add-handle"
                aria-label={`Connect ${props.data.label} via ${output.label}`}
                title={`Drag to connect ${output.label}`}
              >
                <Plus size={13} weight="bold" />
              </Handle>
            </span>
          ))}
        </div>
      ) : (
        <Handle
          type="source"
          id={singleOutput.id}
          position={Position.Right}
          className="flow-step-add-handle is-single"
          aria-label={`Connect ${props.data.label}`}
          title={t("dragConnect")}
        >
          <Plus size={13} weight="bold" />
        </Handle>
      )}
    </article>
  );
}

function TerminalNode(props: NodeProps<TerminalCanvasNode>) {
  return (
    <div className={`flow-terminal-node is-${props.data.tone}`}>
      {props.data.tone !== "start" ? (
        <Handle type="target" id="target" position={Position.Left} />
      ) : null}
      {props.data.tone === "start" ? (
        <Handle type="source" id="start" position={Position.Right} />
      ) : null}
      <span>
        {props.data.tone === "start" ? (
          <PlayIcon />
        ) : props.data.tone === "end" ? (
          <CheckCircle size={18} />
        ) : (
          <Trash size={17} />
        )}
      </span>
      <strong>{props.data.label}</strong>
    </div>
  );
}

function PlayIcon() {
  return <GitBranch size={18} />;
}

const nodeTypes = { step: StepNode, terminal: TerminalNode };

function WorkflowEdge(props: EdgeProps) {
  const { t } = useTranslation("studio");
  const { deleteElements } = useReactFlow();
  const [deleteVisible, setDeleteVisible] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  });
  const showDelete = () => {
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    setDeleteVisible(true);
  };
  const hideDeleteSoon = () => {
    hideTimerRef.current = setTimeout(() => setDeleteVisible(false), 120);
  };
  useEffect(
    () => () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current);
    },
    [],
  );

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        label={props.label}
        labelX={labelX}
        labelY={labelY}
        interactionWidth={0}
        {...(props.markerStart === undefined ? {} : { markerStart: props.markerStart })}
        {...(props.markerEnd === undefined ? {} : { markerEnd: props.markerEnd })}
        {...(props.style === undefined ? {} : { style: props.style })}
      />
      {props.deletable === false ? null : (
        <path
          className="flow-edge-hitbox"
          d={path}
          onMouseEnter={showDelete}
          onMouseLeave={hideDeleteSoon}
        />
      )}
      {props.deletable === false ? null : (
        <EdgeLabelRenderer>
          <button
            className={`flow-edge-delete nodrag nopan${deleteVisible ? " is-visible" : ""}`}
            type="button"
            aria-label={`Delete ${String(props.label ?? "connection")} edge`}
            title={t("deleteEdge")}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 20}px)` }}
            onMouseEnter={showDelete}
            onMouseLeave={() => setDeleteVisible(false)}
            onClick={(event) => {
              event.stopPropagation();
              void deleteElements({ edges: [{ id: props.id }] });
            }}
          >
            <Trash size={13} weight="bold" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { workflow: WorkflowEdge };

function FlowSettings(props: {
  readonly flow: PragmaFlowResource;
  readonly lockId: boolean;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="flow-inspector-content">
      <header>
        <span className="flow-inspector-icon">
          <Brain size={19} />
        </span>
        <div>
          <strong>{t("flowSettings")}</strong>
          <small>{t("flowSettingsDescription")}</small>
        </div>
      </header>
      <InspectorField label="Resource ID">
        <input
          value={props.flow.metadata.id}
          disabled={props.lockId}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.metadata.id = event.target.value;
            })
          }
        />
      </InspectorField>
      <InspectorField label="Name">
        <input
          value={props.flow.metadata.name}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.metadata.name = event.target.value;
            })
          }
        />
      </InspectorField>
      <InspectorField label="Description">
        <textarea
          rows={3}
          value={props.flow.metadata.description}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.metadata.description = event.target.value;
            })
          }
        />
      </InspectorField>
      <InspectorField label="Version">
        <input
          value={props.flow.metadata.version}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.metadata.version = event.target.value;
            })
          }
        />
      </InspectorField>
      <div className="flow-inspector-grid">
        <InspectorField label="Max node visits">
          <input
            type="number"
            min={1}
            value={props.flow.spec.limits.maxNodeVisits}
            onChange={(event) =>
              props.onPatch((copy) => {
                copy.spec.limits.maxNodeVisits = Number(event.target.value);
              })
            }
          />
        </InspectorField>
        <InspectorField label="Timeout (ms)">
          <input
            type="number"
            min={1}
            value={props.flow.spec.limits.timeoutMs ?? ""}
            onChange={(event) =>
              props.onPatch((copy) => {
                copy.spec.limits.timeoutMs =
                  event.target.value === "" ? undefined : Number(event.target.value);
              })
            }
          />
        </InspectorField>
      </div>
      <JsonField
        label="Input contract"
        value={props.flow.spec.input}
        onCommit={(value) =>
          props.onPatch((copy) => {
            copy.spec.input = value as PragmaFlowResource["spec"]["input"];
          })
        }
      />
      <JsonField
        label="Output contract"
        value={props.flow.spec.output}
        onCommit={(value) =>
          props.onPatch((copy) => {
            copy.spec.output = value as PragmaFlowResource["spec"]["output"];
          })
        }
      />
    </div>
  );
}

function StepInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly stepId: string;
  readonly targets: readonly ResourceTarget[];
  readonly resources: readonly PragmaResource[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onSupportingResource: (resource: PragmaResource) => void;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly onRename: (nextId: string) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const step = props.flow.spec.graph.steps[props.stepId];
  const transition = props.flow.spec.graph.transitions[props.stepId] ?? { end: true };
  if (step === undefined) return null;
  const kind = flowStepKind(step);
  const target = flowStepTarget(step);
  const mode = transitionMode(transition);
  const patchStep = (mutator: (copy: FlowStep) => void) =>
    props.onPatch((copy) => {
      const current = copy.spec.graph.steps[props.stepId];
      if (current !== undefined) mutator(current);
    });
  return (
    <div className="flow-inspector-content">
      <header>
        <span className={`flow-inspector-icon is-${kind}`}>
          <Robot size={19} />
        </span>
        <div>
          <strong>{props.stepId}</strong>
          <small>{kind} step</small>
        </div>
      </header>
      <InspectorField label="Node ID">
        <input
          key={props.stepId}
          defaultValue={props.stepId}
          onBlur={(event) => props.onRename(event.target.value)}
        />
      </InspectorField>
      {kind === "human" ? (
        <>
          <InspectorField label="Request type">
            <select
              value={step.human?.kind}
              onChange={(event) =>
                patchStep((current) => {
                  if (!current.human) return;
                  const kind = event.target.value as NonNullable<FlowStep["human"]>["kind"];
                  current.human.kind = kind;
                  if (kind === "approval") {
                    current.human.options ??= ["approve", "reject"];
                    current.human.approveOption ??= current.human.options[0];
                  } else {
                    delete current.human.options;
                    delete current.human.approveOption;
                  }
                })
              }
            >
              {["approval", "question", "review_gate", "manual_intervention"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </InspectorField>
          <InspectorField label="Title">
            <input
              value={step.human?.title ?? ""}
              onChange={(event) =>
                patchStep((current) => {
                  if (current.human) current.human.title = event.target.value || undefined;
                })
              }
            />
          </InspectorField>
          <InspectorField label="Prompt">
            <textarea
              rows={3}
              value={step.human?.prompt ?? ""}
              onChange={(event) =>
                patchStep((current) => {
                  if (current.human) current.human.prompt = event.target.value;
                })
              }
            />
          </InspectorField>
          {step.human?.kind === "approval" ? (
            <>
              <StringListField
                label="Approval choices"
                values={step.human.options ?? ["approve", "reject"]}
                onChange={(values) =>
                  patchStep((current) => {
                    if (!current.human) return;
                    current.human.options = values;
                    if (!values.includes(current.human.approveOption ?? "")) {
                      current.human.approveOption = values[0];
                    }
                  })
                }
              />
              <InspectorField label="Approved choice">
                <select
                  value={step.human.approveOption ?? step.human.options?.[0] ?? "approve"}
                  onChange={(event) =>
                    patchStep((current) => {
                      if (current.human) current.human.approveOption = event.target.value;
                    })
                  }
                >
                  {(step.human.options ?? ["approve", "reject"]).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </InspectorField>
            </>
          ) : null}
          <HumanQuestionsEditor
            questions={step.human?.questions ?? []}
            onChange={(questions) =>
              patchStep((current) => {
                if (current.human) current.human.questions = questions;
              })
            }
          />
        </>
      ) : kind === "action" ? (
        <InspectorField label="Action reference">
          <input
            value={target}
            onChange={(event) =>
              patchStep((current) => {
                if (current.action) current.action.ref = event.target.value;
              })
            }
            placeholder="action:my_action@v1"
          />
        </InspectorField>
      ) : (
        <InspectorField label="Resource">
          <select
            value={target}
            onChange={(event) =>
              patchStep((current) => setStepReference(current, kind, event.target.value))
            }
          >
            <option value="">{t("selectResource")}</option>
            {target !== "" &&
            !props.targets.some((item) => item.kind === kind && item.ref === target) ? (
              <option value={target}>{target} · unavailable</option>
            ) : null}
            {props.targets
              .filter((item) => item.kind === kind)
              .map((item) => (
                <option key={item.ref} value={item.ref}>
                  {item.label}
                </option>
              ))}
          </select>
        </InspectorField>
      )}
      {kind === "expert" || kind === "team" ? (
        <>
          <PromptTemplateEditor
            flow={props.flow}
            stepId={props.stepId}
            value={step.prompt}
            onChange={(prompt) =>
              patchStep((current) => {
                current.prompt = prompt;
              })
            }
          />
          <StructuredOutputEditor
            value={step.output?.schema}
            onChange={(schema) =>
              patchStep((current) => {
                current.output = schema === undefined ? undefined : { schema };
              })
            }
          />
        </>
      ) : kind === "action" || kind === "flow" ? (
        <JsonField
          label="Input mapping"
          value={step.input}
          onCommit={(value) =>
            patchStep((current) => {
              current.input = value;
            })
          }
        />
      ) : null}
      {kind === "expert" || kind === "team" || kind === "flow" ? (
        <RuntimeBindingEditor
          value={step.runtime}
          allowModel={kind === "expert" || kind === "team"}
          targetKind={kind}
          targetRef={target}
          resources={props.resources}
          runtimes={props.runtimes}
          onSupportingResource={props.onSupportingResource}
          onChange={(runtime) =>
            patchStep((current) => {
              current.runtime = runtime;
            })
          }
        />
      ) : null}
      <details className="flow-advanced-settings">
        <summary>{t("advancedSettings")}</summary>
        <InspectorField label="Step version">
          <input
            value={step.version}
            onChange={(event) =>
              patchStep((current) => {
                current.version = event.target.value;
              })
            }
          />
        </InspectorField>
        {kind === "expert" || kind === "team" ? (
          <InspectorField label="Context">
            <input
              value={step.context ?? ""}
              onChange={(event) =>
                patchStep((current) => {
                  current.context = event.target.value || undefined;
                })
              }
            />
          </InspectorField>
        ) : null}
        <InspectorField label={t("rawNodeDsl")}>
          <pre className="flow-raw-dsl">{stringify(step, { lineWidth: 72 })}</pre>
        </InspectorField>
      </details>

      <div className="flow-inspector-divider" />
      <InspectorField label="Transition">
        <select
          value={mode}
          onChange={(event) =>
            props.onPatch((copy) => {
              const previous = copy.spec.graph.transitions[props.stepId];
              copy.spec.graph.transitions[props.stepId] = defaultTransition(
                event.target.value as ReturnType<typeof transitionMode>,
                props.stepId,
                copy,
              );
              if (previous !== undefined) {
                for (const destination of transitionDestinations(previous)) {
                  removeOrphanedLoop(copy, destination);
                }
              }
            })
          }
        >
          {(["goto", "end", "fail", "repeat", "route"] as const).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </InspectorField>
      <TransitionFields
        flow={props.flow}
        sourceId={props.stepId}
        transition={transition}
        onPatch={props.onPatch}
      />
      <button className="flow-delete-node" type="button" onClick={props.onDelete}>
        <Trash size={16} /> Delete node
      </button>
    </div>
  );
}

interface FlowVariableOption {
  readonly key: string;
  readonly label: string;
  readonly variable: PragmaFlowVariable;
  readonly optional: boolean;
}

export function PromptTemplateEditor(props: {
  readonly flow: PragmaFlowResource;
  readonly stepId: string;
  readonly value: PragmaFlowPrompt | undefined;
  readonly onChange: (value: PragmaFlowPrompt) => void;
}) {
  const { t } = useTranslation("studio");
  const promptLabelId = useId();
  const prompt = props.value ?? { segments: [{ text: "" }] };
  const initialPromptRef = useRef(prompt);
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const [variableMenuOpen, setVariableMenuOpen] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const options = useMemo(
    () => flowVariableOptions(props.flow, props.stepId),
    [props.flow, props.stepId],
  );
  const promptIsEmpty = prompt.segments.every(
    (segment) => "text" in segment && segment.text.length === 0,
  );

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor === null || promptSegmentsEqual(promptSegmentsFromEditor(editor), prompt.segments)) {
      return;
    }
    const restoreFocus = document.activeElement === editor;
    replacePromptEditorContents(editor, prompt.segments, {
      variableLabel: (variable) => variableLabel(props.flow, variable),
      variableIsOptional: (variable) => variableIsOptional(props.flow, props.stepId, variable),
      optionalLabel: t("optionalVariable"),
      removeLabel: (variable) =>
        t("removeVariable", {
          variable: variableLabel(props.flow, variable),
        }),
    });
    selectionRef.current = null;
    if (restoreFocus) {
      const range = restoreEditorSelection(editor, null);
      setBrowserSelection(range);
      selectionRef.current = range.cloneRange();
    }
  }, [prompt.segments, props.flow, props.stepId, t]);

  const rememberSelection = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (
      editor === null ||
      selection === null ||
      selection.rangeCount === 0 ||
      !editor.contains(selection.anchorNode)
    ) {
      return;
    }
    selectionRef.current = selection.getRangeAt(0).cloneRange();
  };

  const emitEditorValue = () => {
    const editor = editorRef.current;
    if (editor === null) return;
    props.onChange({ segments: promptSegmentsFromEditor(editor) });
    rememberSelection();
  };

  const insertText = (text: string) => {
    const editor = editorRef.current;
    if (editor === null) return;
    const range = restoreEditorSelection(editor, selectionRef.current);
    range.deleteContents();
    const textNode = document.createTextNode(text);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    setBrowserSelection(range);
    emitEditorValue();
  };

  const insertVariable = (option: FlowVariableOption) => {
    const editor = editorRef.current;
    if (editor === null) return;
    const range = restoreEditorSelection(editor, selectionRef.current);
    range.deleteContents();
    const token = createFlowVariableChip(option.variable, {
      label: option.label,
      optional: option.optional,
      optionalLabel: t("optionalVariable"),
      removeLabel: t("removeVariable", { variable: option.label }),
    });
    range.insertNode(token);
    range.setStartAfter(token);
    range.collapse(true);
    setBrowserSelection(range);
    setVariableMenuOpen(false);
    emitEditorValue();
    requestAnimationFrame(() => editor.focus());
  };

  const handleEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (variableMenuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveOptionIndex((current) => {
          const length = Math.max(options.length, 1);
          return (current + direction + length) % length;
        });
        return;
      }
      if (event.key === "Enter" && options[activeOptionIndex] !== undefined) {
        event.preventDefault();
        insertVariable(options[activeOptionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setVariableMenuOpen(false);
        return;
      }
    }
    if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      rememberSelection();
      setActiveOptionIndex(0);
      setVariableMenuOpen(true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      rememberSelection();
      insertText("\n");
    }
  };

  return (
    <div className="flow-inspector-field" role="group" aria-labelledby={promptLabelId}>
      <span id={promptLabelId}>{t("flowPrompt")}</span>
      <div className="flow-prompt-composer">
        <div
          ref={editorRef}
          className="flow-prompt-editor"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-labelledby={promptLabelId}
          aria-multiline="true"
          aria-expanded={variableMenuOpen}
          data-empty={promptIsEmpty ? "true" : "false"}
          data-placeholder={t("flowPromptPlaceholder")}
          onFocus={rememberSelection}
          onInput={emitEditorValue}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          onMouseDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.closest("[data-flow-variable-remove]") !== null
            ) {
              event.preventDefault();
            }
          }}
          onClick={(event) => {
            if (!(event.target instanceof Element)) return;
            const removeButton = event.target.closest("[data-flow-variable-remove]");
            const chip = removeButton?.closest<HTMLElement>("[data-flow-variable]");
            if (chip === undefined || chip === null) return;
            chip.remove();
            emitEditorValue();
            requestAnimationFrame(() => editorRef.current?.focus());
          }}
          onKeyDown={handleEditorKeyDown}
          onPaste={(event) => {
            event.preventDefault();
            rememberSelection();
            insertText(event.clipboardData.getData("text/plain"));
          }}
        >
          {initialPromptRef.current.segments.map((segment, index) =>
            "text" in segment ? (
              <span key={`text-${index}`} data-flow-prompt-text className="flow-prompt-text">
                {segment.text}
              </span>
            ) : (
              <span
                className="flow-variable-chip"
                key={`variable-${index}`}
                contentEditable={false}
                data-flow-variable={encodeFlowVariable(segment.variable)}
              >
                <span>{variableLabel(props.flow, segment.variable)}</span>
                {variableIsOptional(props.flow, props.stepId, segment.variable) ? (
                  <small>{t("optionalVariable")}</small>
                ) : null}
                <button
                  type="button"
                  data-flow-variable-remove
                  aria-label={t("removeVariable", {
                    variable: variableLabel(props.flow, segment.variable),
                  })}
                >
                  <X size={12} />
                </button>
              </span>
            ),
          )}
        </div>
        <div className="flow-prompt-tools">
          <button
            type="button"
            className="flow-variable-trigger"
            aria-haspopup="listbox"
            aria-expanded={variableMenuOpen}
            onMouseDown={() => rememberSelection()}
            onClick={() => {
              setActiveOptionIndex(0);
              setVariableMenuOpen((current) => !current);
            }}
          >
            <Code size={14} />
            {t("insertVariable")}
          </button>
          <small>{t("flowPromptVariableHint")}</small>
        </div>
        {variableMenuOpen ? (
          <div className="flow-variable-menu" role="listbox" aria-label={t("insertVariable")}>
            {options.length === 0 ? <small>{t("noAvailableVariables")}</small> : null}
            {options.map((option, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === activeOptionIndex}
                className={index === activeOptionIndex ? "is-active" : undefined}
                key={option.key}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveOptionIndex(index)}
                onClick={() => insertVariable(option)}
              >
                <span>{option.label}</span>
                {option.optional ? <small>{t("optionalVariable")}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function promptSegmentsFromEditor(editor: HTMLElement): PragmaFlowPrompt["segments"] {
  const segments: PragmaFlowPrompt["segments"] = [];
  for (const node of editor.childNodes) {
    if (node instanceof HTMLElement && node.dataset.flowVariable !== undefined) {
      const variable = decodeFlowVariable(node.dataset.flowVariable);
      if (variable !== undefined) segments.push({ variable });
      continue;
    }
    const text = node.textContent ?? "";
    if (text !== "") segments.push({ text });
  }
  return normalizePromptSegments(segments);
}

export function normalizePromptSegments(
  segments: PragmaFlowPrompt["segments"],
): PragmaFlowPrompt["segments"] {
  const normalized: PragmaFlowPrompt["segments"] = [];
  for (const segment of segments) {
    const previous = normalized.at(-1);
    if ("text" in segment && previous !== undefined && "text" in previous) {
      normalized[normalized.length - 1] = { text: previous.text + segment.text };
    } else {
      normalized.push(segment);
    }
  }
  return normalized.length === 0 ? [{ text: "" }] : normalized;
}

function promptSegmentsEqual(
  left: PragmaFlowPrompt["segments"],
  right: PragmaFlowPrompt["segments"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function replacePromptEditorContents(
  editor: HTMLElement,
  segments: PragmaFlowPrompt["segments"],
  labels: {
    readonly variableLabel: (variable: PragmaFlowVariable) => string;
    readonly variableIsOptional: (variable: PragmaFlowVariable) => boolean;
    readonly optionalLabel: string;
    readonly removeLabel: (variable: PragmaFlowVariable) => string;
  },
): void {
  const nodes = segments.map((segment) => {
    if ("text" in segment) {
      const text = document.createElement("span");
      text.dataset.flowPromptText = "";
      text.className = "flow-prompt-text";
      text.textContent = segment.text;
      return text;
    }
    return createFlowVariableChip(segment.variable, {
      label: labels.variableLabel(segment.variable),
      optional: labels.variableIsOptional(segment.variable),
      optionalLabel: labels.optionalLabel,
      removeLabel: labels.removeLabel(segment.variable),
    });
  });
  editor.replaceChildren(...nodes);
}

function createFlowVariableChip(
  variable: PragmaFlowVariable,
  labels: {
    readonly label: string;
    readonly optional: boolean;
    readonly optionalLabel: string;
    readonly removeLabel: string;
  },
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "flow-variable-chip";
  chip.contentEditable = "false";
  chip.dataset.flowVariable = encodeFlowVariable(variable);

  const variableLabel = document.createElement("span");
  variableLabel.textContent = labels.label;
  chip.append(variableLabel);

  if (labels.optional) {
    const optionalLabel = document.createElement("small");
    optionalLabel.textContent = labels.optionalLabel;
    chip.append(optionalLabel);
  }

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.dataset.flowVariableRemove = "";
  removeButton.setAttribute("aria-label", labels.removeLabel);
  removeButton.textContent = "×";
  chip.append(removeButton);
  return chip;
}

function encodeFlowVariable(variable: PragmaFlowVariable): string {
  return encodeURIComponent(JSON.stringify(variable));
}

function decodeFlowVariable(value: string): PragmaFlowVariable | undefined {
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return typeof parsed === "object" && parsed !== null && "source" in parsed
      ? (parsed as PragmaFlowVariable)
      : undefined;
  } catch {
    return undefined;
  }
}

function restoreEditorSelection(editor: HTMLElement, saved: Range | null): Range {
  editor.focus();
  if (saved !== null && editor.contains(saved.commonAncestorContainer)) return saved.cloneRange();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

function setBrowserSelection(range: Range): void {
  const selection = window.getSelection();
  if (selection === null) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function StructuredOutputEditor(props: {
  readonly value: Extract<PragmaJsonSchema, { readonly type: "object" }> | undefined;
  readonly onChange: (
    value: Extract<PragmaJsonSchema, { readonly type: "object" }> | undefined,
  ) => void;
}) {
  const { t } = useTranslation("studio");
  const [fields, setFields] = useState<readonly SchemaFieldDraft[]>(
    props.value === undefined ? [] : objectSchemaToFields(props.value),
  );
  useEffect(() => {
    setFields((current) =>
      props.value === undefined ? [] : objectSchemaToFields(props.value, current),
    );
  }, [props.value]);
  const update = (next: readonly SchemaFieldDraft[]) => {
    setFields(next);
    try {
      props.onChange(fieldsToObjectSchema(next));
    } catch {
      // Keep the in-progress form value; Flow validation remains on the last valid schema.
    }
  };
  return (
    <section className="flow-output-editor">
      <InspectorField label={t("flowOutput")}>
        <select
          value={props.value === undefined ? "native" : "structured"}
          onChange={(event) => {
            if (event.target.value === "native") {
              setFields([]);
              props.onChange(undefined);
            } else {
              const schema = {
                type: "object" as const,
                properties: {},
                required: [],
                additionalProperties: false as const,
              };
              setFields([]);
              props.onChange(schema);
            }
          }}
        >
          <option value="native">{t("nativeResult")}</option>
          <option value="structured">{t("structuredResult")}</option>
        </select>
      </InspectorField>
      {props.value === undefined ? (
        <small className="flow-field-hint">{t("nativeResultHint")}</small>
      ) : (
        <SchemaFieldsEditor title={t("resultFields")} fields={fields} onChange={update} />
      )}
    </section>
  );
}

export function RuntimeBindingEditor(props: {
  readonly value: FlowStep["runtime"];
  readonly allowModel: boolean;
  readonly targetKind: FlowStepKind;
  readonly targetRef: string;
  readonly resources: readonly PragmaResource[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onSupportingResource: (resource: PragmaResource) => void;
  readonly onChange: (value: FlowStep["runtime"]) => void;
}) {
  const { t } = useTranslation("studio");
  const profiles = runtimeProfiles(props.resources);
  const inheritedProfileRef = targetRuntimeProfileRef(
    props.targetKind,
    props.targetRef,
    props.resources,
  );
  const inheritedProfile = profiles.find((profile) => profile.ref === inheritedProfileRef);
  const selectedProfile = profiles.find((profile) => profile.ref === props.value?.ref);
  const runtimeIsInherited =
    props.value === undefined ||
    (inheritedProfileRef !== undefined && props.value.ref === inheritedProfileRef);
  const selectedRuntimeId = runtimeIsInherited
    ? ""
    : (selectedProfile?.config.runtimeId ?? props.value?.ref ?? "");
  const effectiveRuntimeId =
    selectedRuntimeId === "" ? inheritedProfile?.config.runtimeId : selectedRuntimeId;
  const availability = props.runtimes.find((runtime) => runtime.id === effectiveRuntimeId);
  const models = availability?.models ?? [];
  const profileModel =
    selectedProfile?.config.providerId === undefined || selectedProfile.config.model === undefined
      ? undefined
      : {
          providerId: selectedProfile.config.providerId,
          modelId: selectedProfile.config.model,
        };
  const selectedIdentity =
    props.value?.modelSelection?.model ?? (runtimeIsInherited ? undefined : profileModel);
  const selectedModel = models.find(
    (model) =>
      model.id === selectedIdentity?.modelId && model.provider.id === selectedIdentity?.providerId,
  );
  return (
    <section className="flow-runtime-editor">
      <InspectorField label={t("runtime")}>
        <select
          value={selectedRuntimeId}
          onChange={(event) => {
            const runtimeId = event.target.value;
            if (runtimeId === "") {
              props.onChange(
                props.value?.modelSelection === undefined || inheritedProfileRef === undefined
                  ? undefined
                  : {
                      ref: inheritedProfileRef,
                      modelSelection: props.value.modelSelection,
                    },
              );
              return;
            }
            const runtime = props.runtimes.find((candidate) => candidate.id === runtimeId);
            if (runtime === undefined) return;
            const profile = flowRuntimeProfile(runtime);
            props.onSupportingResource(profile);
            props.onChange({ ref: pragmaResourceRef(profile) });
          }}
        >
          <option value="">{t("inheritExpertRuntime")}</option>
          {selectedRuntimeId !== "" &&
          !props.runtimes.some((runtime) => runtime.id === selectedRuntimeId) ? (
            <option value={selectedRuntimeId}>
              {selectedRuntimeId} · {t("unavailable")}
            </option>
          ) : null}
          {props.runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id} disabled={runtime.status !== "available"}>
              {runtime.displayName}
              {runtime.status === "available" ? "" : ` · ${t("unavailable")}`}
            </option>
          ))}
        </select>
      </InspectorField>
      {props.allowModel ? (
        <InspectorField label={t("model")}>
          <select
            value={selectedModel === undefined ? "" : runtimeModelKey(selectedModel)}
            onChange={(event) => {
              const model = models.find(
                (candidate) => runtimeModelKey(candidate) === event.target.value,
              );
              const bindingRef =
                selectedRuntimeId === "" ? inheritedProfileRef : selectedProfile?.ref;
              if (bindingRef === undefined) return;
              if (model === undefined) {
                props.onChange(selectedRuntimeId === "" ? undefined : { ref: bindingRef });
                return;
              }
              props.onChange({
                ref: bindingRef,
                modelSelection: {
                  model: { providerId: model.provider.id, modelId: model.id },
                },
              });
            }}
            disabled={effectiveRuntimeId === undefined || availability?.status !== "available"}
          >
            <option value="">
              {selectedRuntimeId === "" ? t("inheritExpertModel") : t("selectModel")}
            </option>
            {models.map((model) => (
              <option key={runtimeModelKey(model)} value={runtimeModelKey(model)}>
                {model.provider.kind === "registered"
                  ? `${model.provider.displayName} / ${model.displayName}`
                  : model.displayName}
              </option>
            ))}
          </select>
        </InspectorField>
      ) : null}
      {props.allowModel &&
      selectedModel?.thinking !== undefined &&
      props.value?.modelSelection !== undefined ? (
        <InspectorField label={t("thinkingLevel")}>
          <select
            value={props.value.modelSelection?.thinkingLevel ?? ""}
            onChange={(event) => {
              if (props.value?.modelSelection === undefined) return;
              const thinkingLevel = event.target.value;
              props.onChange({
                ...props.value,
                modelSelection: {
                  model: props.value.modelSelection.model,
                  ...(thinkingLevel === "" ? {} : { thinkingLevel }),
                },
              });
            }}
          >
            <option value="">{t("runtimeDefault")}</option>
            {selectedModel.thinking.supportedLevels.map((level) => (
              <option key={level.value} value={level.value}>
                {level.label}
              </option>
            ))}
          </select>
        </InspectorField>
      ) : null}
      {availability?.modelDiscoveryError ? (
        <small className="form-error">{availability.modelDiscoveryError}</small>
      ) : null}
      {props.allowModel && selectedRuntimeId !== "" && props.value?.modelSelection === undefined ? (
        <small className="form-error">{t("selectModelForRuntime")}</small>
      ) : null}
    </section>
  );
}

function runtimeProfiles(resources: readonly PragmaResource[]) {
  return resources.flatMap((resource) => {
    if (resource.kind !== "RuntimeProfile") return [];
    const config = PragmaRuntimeProfileConfigSchema.safeParse(resource.spec.config);
    if (!config.success) return [];
    return [
      {
        ref: `runtime-profile:${resource.metadata.id}@${resource.metadata.version}`,
        name: resource.metadata.name,
        config: config.data,
      },
    ];
  });
}

export function targetRuntimeProfileRef(
  kind: FlowStepKind,
  targetRef: string,
  resources: readonly PragmaResource[],
): string | undefined {
  const target = resources.find((resource) => canonicalPragmaResourceRef(resource) === targetRef);
  if (kind === "expert" && target?.kind === "Expert") return target.spec.runtime?.ref;
  if (kind !== "team" || target?.kind !== "ExpertTeam") return undefined;
  const coordinator = resources.find(
    (resource) =>
      resource.kind === "Expert" &&
      canonicalPragmaResourceRef(resource) === target.spec.coordinator.ref,
  );
  return coordinator?.kind === "Expert" ? coordinator.spec.runtime?.ref : undefined;
}

export function flowRuntimeProfile(runtime: DesktopRuntimeAvailability) {
  return PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: "pragma/v2",
    kind: "RuntimeProfile",
    metadata: {
      id: `flow_runtime_${stableRuntimeKey(runtime.id)}`,
      version: "1.0.0",
      name: `${runtime.displayName} Flow Runtime`,
      description: `Desktop-managed Runtime profile for Flow node overrides using ${runtime.displayName}.`,
      tags: ["desktop-managed", "flow-runtime-override"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId: runtime.id },
    },
  });
}

function stableRuntimeKey(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function pragmaResourceRef(resource: PragmaResource): string {
  return canonicalPragmaResourceRef(resource);
}

function mergePragmaResources(
  existing: readonly PragmaResource[],
  additions: readonly PragmaResource[],
): readonly PragmaResource[] {
  const byRef = new Map(existing.map((resource) => [pragmaResourceRef(resource), resource]));
  for (const resource of additions) byRef.set(pragmaResourceRef(resource), resource);
  return [...byRef.values()];
}

export function validateFlowRuntimeSelections(
  flow: PragmaFlowResource,
  resources: readonly PragmaResource[],
): readonly FlowValidationIssue[] {
  const profiles = new Map(runtimeProfiles(resources).map((profile) => [profile.ref, profile]));
  const issues: FlowValidationIssue[] = [];
  for (const [stepId, step] of Object.entries(flow.spec.graph.steps)) {
    const kind = flowStepKind(step);
    if ((kind !== "expert" && kind !== "team") || step.runtime === undefined) continue;
    const inheritedRef = targetRuntimeProfileRef(kind, flowStepTarget(step), resources);
    if (step.runtime.ref === inheritedRef || step.runtime.modelSelection !== undefined) continue;
    const profile = profiles.get(step.runtime.ref);
    if (profile === undefined) continue;
    issues.push({
      path: ["spec", "graph", "steps", stepId, "runtime", "modelSelection"],
      message: "Choose a model when overriding the node Runtime.",
      stepId,
    });
  }
  return issues;
}

function runtimeModelKey(model: DesktopRuntimeModel): string {
  return `${model.provider.id}\u0000${model.id}`;
}

export function flowVariableOptions(
  flow: PragmaFlowResource,
  targetStepId: string,
): readonly FlowVariableOption[] {
  const availability = analyzePragmaFlowNodeAvailability(flow, targetStepId);
  const options: FlowVariableOption[] = [
    variableOption({ source: "flow-input", path: [] }, "Flow input", false),
  ];
  for (const path of objectSchemaPaths(flow.spec.input?.schema)) {
    options.push(
      variableOption(
        { source: "flow-input", path: [...path.path] },
        `Flow input.${path.path.join(".")}`,
        path.optional,
      ),
    );
  }
  for (const nodeId of [...availability.upstream].sort()) {
    const step = flow.spec.graph.steps[nodeId];
    if (step === undefined) continue;
    const branchOptional = !availability.required.has(nodeId);
    options.push(
      variableOption(
        { source: "node-output", nodeId, path: [] },
        `${nodeId}.result`,
        branchOptional,
      ),
    );
    for (const path of objectSchemaPaths(step.output?.schema)) {
      options.push(
        variableOption(
          { source: "node-output", nodeId, path: [...path.path] },
          `${nodeId}.result.${path.path.join(".")}`,
          branchOptional || path.optional,
        ),
      );
    }
  }
  return options;
}

function variableOption(
  variable: PragmaFlowVariable,
  label: string,
  optional: boolean,
): FlowVariableOption {
  return { key: JSON.stringify(variable), label, variable, optional };
}

function variableLabel(flow: PragmaFlowResource, variable: PragmaFlowVariable): string {
  if (variable.source === "flow-input") {
    return variable.path.length === 0 ? "Flow input" : `Flow input.${variable.path.join(".")}`;
  }
  return `${variable.nodeId}.result${
    variable.path.length === 0 ? "" : `.${variable.path.join(".")}`
  }`;
}

function variableIsOptional(
  flow: PragmaFlowResource,
  targetStepId: string,
  variable: PragmaFlowVariable,
): boolean {
  return (
    flowVariableOptions(flow, targetStepId).find(
      (option) => option.key === JSON.stringify(variable),
    )?.optional ?? true
  );
}

function objectSchemaPaths(
  schema: unknown,
  prefix: readonly string[] = [],
  parentOptional = false,
): readonly { readonly path: readonly string[]; readonly optional: boolean }[] {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return [];
  const record = schema as Record<string, unknown>;
  if (record["type"] !== "object") return [];
  const properties = record["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(record["required"]) ? record["required"] : []);
  return Object.entries(properties as Record<string, unknown>).flatMap(([name, child]) => {
    const path = [...prefix, name];
    const optional = parentOptional || !required.has(name);
    return [{ path, optional }, ...objectSchemaPaths(child, path, optional)];
  });
}

function TransitionFields(props: {
  readonly flow: PragmaFlowResource;
  readonly sourceId: string;
  readonly transition: PragmaFlowTransition;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
}) {
  const mode = transitionMode(props.transition);
  const nodeOptions = Object.keys(props.flow.spec.graph.steps);
  if (mode === "goto") {
    const target = destinationTarget(props.transition as PragmaFlowDestination) ?? "";
    return (
      <InspectorField label="Target node">
        <select
          value={target}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.spec.graph.transitions[props.sourceId] = { goto: event.target.value };
            })
          }
        >
          {nodeOptions.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
      </InspectorField>
    );
  }
  if (mode === "fail") {
    const destination = props.transition as { fail: string };
    return (
      <InspectorField label="Failure message">
        <input
          value={destination.fail}
          onChange={(event) =>
            props.onPatch((copy) => {
              copy.spec.graph.transitions[props.sourceId] = { fail: event.target.value };
            })
          }
        />
      </InspectorField>
    );
  }
  if (mode === "repeat") {
    const destination = props.transition as { repeat: { loop: string; goto: string } };
    const loop = props.flow.spec.graph.loops[destination.repeat.loop];
    return (
      <>
        <InspectorField label="Loop ID">
          <input
            value={destination.repeat.loop}
            onChange={(event) =>
              props.onPatch((copy) => {
                const current = copy.spec.graph.transitions[props.sourceId] as typeof destination;
                const previous = current.repeat.loop;
                current.repeat.loop = event.target.value;
                const definition = copy.spec.graph.loops[previous];
                if (definition) {
                  delete copy.spec.graph.loops[previous];
                  copy.spec.graph.loops[event.target.value] = definition;
                }
              })
            }
          />
        </InspectorField>
        <InspectorField label="Loop entry">
          <select
            value={destination.repeat.goto}
            onChange={(event) =>
              props.onPatch((copy) => {
                (copy.spec.graph.transitions[props.sourceId] as typeof destination).repeat.goto =
                  event.target.value;
                copy.spec.graph.loops[destination.repeat.loop]!.entry = event.target.value;
              })
            }
          >
            {nodeOptions.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </InspectorField>
        <InspectorField label="Max iterations">
          <input
            type="number"
            min={1}
            value={loop?.maxIterations ?? 3}
            onChange={(event) =>
              props.onPatch((copy) => {
                copy.spec.graph.loops[destination.repeat.loop] = {
                  ...(copy.spec.graph.loops[destination.repeat.loop] ?? {
                    entry: destination.repeat.goto,
                  }),
                  maxIterations: Number(event.target.value),
                };
              })
            }
          />
        </InspectorField>
        <JsonField
          label="On limit destination"
          value={loop?.onLimit}
          onCommit={(value) =>
            props.onPatch((copy) => {
              const current = copy.spec.graph.loops[destination.repeat.loop];
              if (current) current.onLimit = value as typeof current.onLimit;
            })
          }
        />
      </>
    );
  }
  if (mode === "route") {
    const route = props.transition as Extract<PragmaFlowTransition, { route: string }>;
    return (
      <>
        <InspectorField label="Route output">
          <input
            value={route.route}
            onChange={(event) =>
              props.onPatch((copy) => {
                (copy.spec.graph.transitions[props.sourceId] as typeof route).route =
                  event.target.value;
              })
            }
          />
        </InspectorField>
        <JsonField
          label="Cases"
          value={route.cases}
          required
          onCommit={(value) =>
            props.onPatch((copy) => {
              (copy.spec.graph.transitions[props.sourceId] as typeof route).cases =
                value as typeof route.cases;
            })
          }
        />
        <JsonField
          label="Fallback"
          value={route.fallback}
          onCommit={(value) =>
            props.onPatch((copy) => {
              (copy.spec.graph.transitions[props.sourceId] as typeof route).fallback =
                value as typeof route.fallback;
            })
          }
        />
      </>
    );
  }
  return null;
}

function InspectorField(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="flow-inspector-field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

type HumanQuestion = NonNullable<NonNullable<FlowStep["human"]>["questions"]>[number];

function StringListField(props: {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (values: string[]) => void;
}) {
  return (
    <InspectorField label={props.label}>
      <textarea
        rows={Math.max(2, props.values.length)}
        value={props.values.join("\n")}
        onChange={(event) =>
          props.onChange(
            event.target.value
              .split("\n")
              .map((value) => value.trim())
              .filter(Boolean),
          )
        }
      />
    </InspectorField>
  );
}

function HumanQuestionsEditor(props: {
  readonly questions: readonly HumanQuestion[];
  readonly onChange: (questions: HumanQuestion[]) => void;
}) {
  const patch = (index: number, update: (question: HumanQuestion) => HumanQuestion) => {
    props.onChange(
      props.questions.map((question, current) => (current === index ? update(question) : question)),
    );
  };
  return (
    <div className="flow-inspector-field">
      <span>Questions</span>
      {props.questions.map((question, index) => (
        <div className="flow-inspector-grid" key={`${question.id}-${index}`}>
          <input
            aria-label={`Question ${index + 1} id`}
            value={question.id}
            placeholder="decision"
            onChange={(event) =>
              patch(index, (current) => ({ ...current, id: event.target.value }))
            }
          />
          <select
            aria-label={`Question ${index + 1} type`}
            value={question.type}
            onChange={(event) =>
              patch(index, (current) => ({
                ...current,
                type: event.target.value as HumanQuestion["type"],
                options: event.target.value === "text" ? [] : current.options,
              }))
            }
          >
            <option value="single_choice">single choice</option>
            <option value="multiple_choice">multiple choice</option>
            <option value="text">text</option>
          </select>
          <input
            aria-label={`Question ${index + 1} label`}
            value={question.label}
            placeholder="What should happen?"
            onChange={(event) =>
              patch(index, (current) => ({ ...current, label: event.target.value }))
            }
          />
          {question.type === "text" ? null : (
            <input
              aria-label={`Question ${index + 1} options`}
              value={question.options.join(", ")}
              placeholder="approve, revise, reject"
              onChange={(event) =>
                patch(index, (current) => ({
                  ...current,
                  options: event.target.value
                    .split(",")
                    .map((value) => value.trim())
                    .filter(Boolean),
                }))
              }
            />
          )}
          <button
            type="button"
            className="flow-inspector-delete"
            onClick={() =>
              props.onChange(props.questions.filter((_, current) => current !== index))
            }
          >
            Remove question
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          props.onChange([
            ...props.questions,
            {
              id: `question_${props.questions.length + 1}`,
              type: "text",
              label: "Question",
              options: [],
            },
          ])
        }
      >
        <Plus size={14} /> Add question
      </button>
    </div>
  );
}

function JsonField(props: {
  readonly label: string;
  readonly value: unknown;
  readonly onCommit: (value: unknown) => void;
  readonly required?: boolean;
}) {
  const serialized = props.value === undefined ? "" : JSON.stringify(props.value, null, 2);
  const [text, setText] = useState(serialized);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(serialized), [serialized]);
  return (
    <label className="flow-inspector-field">
      <span>{props.label}</span>
      <textarea
        className={invalid ? "is-invalid" : ""}
        rows={4}
        value={text}
        placeholder={props.required ? "{}" : "Optional JSON"}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onBlur={() => {
          if (text.trim() === "" && !props.required) {
            props.onCommit(undefined);
            return;
          }
          try {
            props.onCommit(JSON.parse(text));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
    </label>
  );
}

interface ResourceTarget {
  readonly kind: "expert" | "team" | "flow";
  readonly ref: string;
  readonly label: string;
}

function resourceTargets(
  resources: readonly PragmaResource[],
  currentFlowId: string,
): readonly ResourceTarget[] {
  return resources.flatMap((resource) => {
    if (resource.kind !== "Expert" && resource.kind !== "ExpertTeam" && resource.kind !== "Flow") {
      return [];
    }
    const kind =
      resource.kind === "Expert"
        ? ("expert" as const)
        : resource.kind === "ExpertTeam"
          ? ("team" as const)
          : ("flow" as const);
    if (kind === "flow" && resource.metadata.id === currentFlowId) return [];
    return [
      {
        kind,
        ref: `${kind}:${resource.metadata.id}@${resource.metadata.version}`,
        label: resource.metadata.name,
      },
    ];
  });
}

function defaultStep(kind: FlowStepKind, targets: readonly ResourceTarget[]): FlowStep {
  const version = "1.0.0";
  if (kind === "human")
    return {
      human: {
        kind: "approval",
        prompt: "Approve this step",
        options: ["approve", "reject"],
        approveOption: "approve",
      },
      version,
    };
  const target = targets.find((item) => item.kind === kind)?.ref ?? `${kind}:select_me@1.0.0`;
  return {
    [kind]: { ref: target },
    version,
    ...(kind === "expert" || kind === "team" ? { prompt: { segments: [{ text: "" }] } } : {}),
  } as FlowStep;
}

function setStepReference(step: FlowStep, kind: Exclude<FlowStepKind, "human">, ref: string): void {
  const value = step[kind];
  if (value !== undefined) value.ref = ref;
}

function defaultTransition(
  mode: ReturnType<typeof transitionMode>,
  sourceId: string,
  flow: PragmaFlowResource,
): PragmaFlowTransition {
  const other = Object.keys(flow.spec.graph.steps).find((id) => id !== sourceId) ?? sourceId;
  if (mode === "goto") return { goto: other };
  if (mode === "fail") return { fail: "Flow failed" };
  if (mode === "repeat") {
    const loopId = `loop_${sourceId}`;
    flow.spec.graph.loops[loopId] = { entry: other, maxIterations: 3 };
    return { repeat: { loop: loopId, goto: other } };
  }
  if (mode === "route")
    return { route: "result", cases: { success: { goto: other } }, fallback: { end: true } };
  return { end: true };
}

function nextStepId(flow: PragmaFlowResource, kind: FlowStepKind): string {
  let index = 1;
  while (flow.spec.graph.steps[`${kind}_${index}`] !== undefined) index += 1;
  return `${kind}_${index}`;
}

function nextFlowResourceId(resources: readonly PragmaResource[]): string {
  const ids = new Set(
    resources
      .filter((resource) => resource.kind === "Flow")
      .map((resource) => resource.metadata.id),
  );
  let index = 1;
  while (ids.has(index === 1 ? "untitled_flow" : `untitled_flow_${index}`)) index += 1;
  return index === 1 ? "untitled_flow" : `untitled_flow_${index}`;
}

function connectionDestination(targetId: string): PragmaFlowDestination | null {
  if (targetId === END_NODE_ID) return { end: true };
  if (targetId === FAIL_NODE_ID) return { fail: "Flow failed" };
  if (targetId === START_NODE_ID) return null;
  return { goto: targetId };
}

function applyConnection(
  flow: PragmaFlowResource,
  connection: Connection,
  destination: PragmaFlowDestination,
): void {
  const source = connection.source;
  if (source === null) return;
  if (source === START_NODE_ID) {
    const target = destinationTarget(destination);
    if (target !== null) flow.spec.graph.start = target;
    return;
  }
  if (flow.spec.graph.steps[source] === undefined) return;
  const current = flow.spec.graph.transitions[source];
  const handle = connection.sourceHandle ?? "default";
  let previous: PragmaFlowDestination | undefined;
  if (
    handle.startsWith("case:") &&
    current !== undefined &&
    typeof current === "object" &&
    "route" in current
  ) {
    const caseName = handle.slice(5);
    previous = current.cases[caseName];
    current.cases[caseName] = destination;
  } else if (
    handle === "fallback" &&
    current !== undefined &&
    typeof current === "object" &&
    "route" in current
  ) {
    previous = current.fallback;
    current.fallback = destination;
  } else {
    if (current !== undefined && !(typeof current === "object" && "route" in current)) {
      previous = current;
    }
    flow.spec.graph.transitions[source] = destination;
  }
  removeOrphanedLoop(flow, previous);
}

export function removeEdgeFromFlow(flow: PragmaFlowResource, edge: Edge): void {
  if (edge.id === "start-edge") return;
  const transition = flow.spec.graph.transitions[edge.source];
  if (transition === undefined) return;
  let removed: PragmaFlowDestination | undefined;
  if (typeof transition === "object" && "route" in transition) {
    if (edge.sourceHandle?.startsWith("case:")) {
      const caseName = edge.sourceHandle.slice(5);
      removed = transition.cases[caseName];
      delete transition.cases[caseName];
    } else if (edge.sourceHandle === "fallback") {
      removed = transition.fallback;
      delete transition.fallback;
    }
  } else {
    removed = transition;
    delete flow.spec.graph.transitions[edge.source];
  }
  removeOrphanedLoop(flow, removed);
}

function removeOrphanedLoop(
  flow: PragmaFlowResource,
  destination: PragmaFlowDestination | undefined,
): void {
  if (destination === undefined || typeof destination === "string" || !("repeat" in destination)) {
    return;
  }
  const loopId = destination.repeat.loop;
  const stillReferenced = Object.values(flow.spec.graph.transitions).some((transition) =>
    transitionDestinations(transition).some(
      (candidate) =>
        typeof candidate === "object" && "repeat" in candidate && candidate.repeat.loop === loopId,
    ),
  );
  if (!stillReferenced) delete flow.spec.graph.loops[loopId];
}

function transitionDestinations(
  transition: PragmaFlowTransition,
): readonly PragmaFlowDestination[] {
  return typeof transition === "object" && "route" in transition
    ? [...Object.values(transition.cases), ...(transition.fallback ? [transition.fallback] : [])]
    : [transition];
}

export function buildCanvasNodes(
  flow: PragmaFlowResource,
  suppliedPositions: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
  invalidStepIds: ReadonlySet<string> = new Set(),
  selectedStepId: string | null = null,
): WorkflowCanvasNode[] {
  const automatic = automaticPositions(flow);
  const stepIds = Object.keys(flow.spec.graph.steps);
  const positions = Object.fromEntries(
    stepIds.map((id) => [id, suppliedPositions[id] ?? automatic[id] ?? { x: 0, y: 0 }]),
  );
  const semantic = stepIds.map((id): StepCanvasNode => {
    const step = flow.spec.graph.steps[id]!;
    return {
      id,
      type: "step",
      position: positions[id]!,
      deletable: false,
      selected: id === selectedStepId,
      data: {
        kind: flowStepKind(step),
        label: id,
        subtitle: flowStepTarget(step),
        outputs: transitionOutputs(flow.spec.graph.transitions[id]),
        invalid: invalidStepIds.has(id),
      },
    };
  });
  const startPosition = positions[flow.spec.graph.start] ?? { x: 0, y: 0 };
  const maxX = Math.max(...Object.values(positions).map((position) => position.x), 0);
  const averageY =
    Object.values(positions).length === 0
      ? 0
      : Object.values(positions).reduce((total, position) => total + position.y, 0) /
        Object.values(positions).length;
  const showFail = flowUsesFail(flow);
  const terminalX = maxX + NODE_WIDTH + TERMINAL_HORIZONTAL_GAP;
  const defaultStartPosition = {
    x: startPosition.x - TERMINAL_NODE_WIDTH - TERMINAL_HORIZONTAL_GAP,
    y: startPosition.y + 25,
  };
  const defaultEndPosition = { x: terminalX, y: showFail ? averageY - 35 : averageY + 25 };
  const defaultFailPosition = { x: terminalX, y: averageY + 70 };
  const terminalNodes: WorkflowCanvasNode[] = [
    {
      id: START_NODE_ID,
      type: "terminal",
      position: suppliedPositions[START_NODE_ID] ?? defaultStartPosition,
      draggable: true,
      deletable: false,
      data: { label: "Start", tone: "start" },
    },
    ...semantic,
    {
      id: END_NODE_ID,
      type: "terminal",
      position: suppliedPositions[END_NODE_ID] ?? defaultEndPosition,
      draggable: true,
      deletable: false,
      data: { label: "End", tone: "end" },
    },
  ];
  if (showFail) {
    terminalNodes.push({
      id: FAIL_NODE_ID,
      type: "terminal",
      position: suppliedPositions[FAIL_NODE_ID] ?? defaultFailPosition,
      draggable: true,
      deletable: false,
      data: { label: "Fail", tone: "fail" },
    });
  }
  return terminalNodes;
}

export function buildCanvasEdges(flow: PragmaFlowResource): Edge[] {
  const startTarget =
    flow.spec.graph.steps[flow.spec.graph.start] === undefined
      ? END_NODE_ID
      : flow.spec.graph.start;
  const edges: Edge[] = [
    {
      id: "start-edge",
      source: START_NODE_ID,
      sourceHandle: "start",
      target: startTarget,
      targetHandle: "target",
      type: "workflow",
      animated: true,
      deletable: false,
      markerEnd: { type: MarkerType.ArrowClosed },
    },
  ];
  for (const [source, transition] of Object.entries(flow.spec.graph.transitions)) {
    if (typeof transition === "object" && "route" in transition) {
      for (const [caseName, destination] of Object.entries(transition.cases))
        edges.push(destinationEdge(source, `case:${caseName}`, destination, caseName));
      if (transition.fallback !== undefined)
        edges.push(destinationEdge(source, "fallback", transition.fallback, "fallback"));
    } else edges.push(destinationEdge(source, "default", transition, transitionMode(transition)));
  }
  return edges;
}

function flowUsesFail(flow: PragmaFlowResource): boolean {
  const transitionFails = Object.values(flow.spec.graph.transitions).some((transition) =>
    transitionDestinations(transition).some(isFailDestination),
  );
  return (
    transitionFails ||
    Object.values(flow.spec.graph.loops).some(
      (loop) => loop.onLimit !== undefined && isFailDestination(loop.onLimit),
    )
  );
}

function isFailDestination(destination: PragmaFlowDestination): boolean {
  return typeof destination === "object" && "fail" in destination;
}

function destinationEdge(
  source: string,
  sourceHandle: string,
  destination: PragmaFlowDestination,
  label: string,
): Edge {
  const target =
    destinationTarget(destination) ??
    (typeof destination === "object" && "fail" in destination ? FAIL_NODE_ID : END_NODE_ID);
  const repeat = typeof destination === "object" && "repeat" in destination;
  return {
    id: `${source}:${sourceHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle: "target",
    label: repeat ? `${label} · ${destination.repeat.loop}` : label,
    type: "workflow",
    animated: repeat,
    ...(repeat ? { className: "is-repeat-edge" } : {}),
    markerEnd: { type: MarkerType.ArrowClosed },
  };
}

function transitionOutputs(
  transition: PragmaFlowTransition | undefined,
): readonly { id: string; label: string }[] {
  if (transition !== undefined && typeof transition === "object" && "route" in transition) {
    return [
      ...Object.keys(transition.cases).map((key) => ({ id: `case:${key}`, label: key })),
      ...(transition.fallback === undefined ? [] : [{ id: "fallback", label: "fallback" }]),
    ];
  }
  return [
    { id: "default", label: transition === undefined ? "connect" : transitionMode(transition) },
  ];
}

function automaticPositions(flow: PragmaFlowResource): Record<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 110, nodesep: 54, marginx: 20, marginy: 20 });
  for (const id of Object.keys(flow.spec.graph.steps))
    graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const [source, transition] of Object.entries(flow.spec.graph.transitions)) {
    const destinations =
      typeof transition === "object" && "route" in transition
        ? [...Object.values(transition.cases), transition.fallback].filter(
            (value): value is PragmaFlowDestination => value !== undefined,
          )
        : [transition];
    for (const destination of destinations) {
      const target = destinationTarget(destination);
      if (target !== null && flow.spec.graph.steps[target] !== undefined)
        graph.setEdge(source, target);
    }
  }
  dagre.layout(graph);
  return Object.fromEntries(
    Object.keys(flow.spec.graph.steps).map((id) => {
      const position = graph.node(id) as { x: number; y: number };
      return [id, { x: position.x - NODE_WIDTH / 2, y: position.y - NODE_HEIGHT / 2 }];
    }),
  );
}

export function canvasPositions(
  nodes: readonly WorkflowCanvasNode[],
): Record<string, { x: number; y: number }> {
  return Object.fromEntries(nodes.map((node) => [node.id, node.position]));
}

export function nextAvailableNodePosition(
  existing: Readonly<Record<string, { readonly x: number; readonly y: number }>>,
  preferred: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const occupied = Object.values(existing);
  const cellWidth = NODE_WIDTH + NODE_HORIZONTAL_GAP;
  const cellHeight = NODE_HEIGHT + NODE_VERTICAL_GAP;
  const isAvailable = (candidate: { readonly x: number; readonly y: number }) =>
    occupied.every(
      (position) =>
        Math.abs(candidate.x - position.x) >= cellWidth ||
        Math.abs(candidate.y - position.y) >= cellHeight,
    );

  if (isAvailable(preferred)) return { ...preferred };
  for (let ring = 1; ring <= 50; ring += 1) {
    for (const [column, row] of gridRing(ring)) {
      const candidate = {
        x: preferred.x + column * cellWidth,
        y: preferred.y + row * cellHeight,
      };
      if (isAvailable(candidate)) return candidate;
    }
  }
  return {
    x: preferred.x + occupied.length * cellWidth,
    y: preferred.y,
  };
}

function gridRing(ring: number): readonly (readonly [number, number])[] {
  const offsets: [number, number][] = [];
  for (let row = 0; row <= ring; row += 1) offsets.push([ring, row]);
  for (let column = ring - 1; column >= -ring; column -= 1) offsets.push([column, ring]);
  for (let row = ring - 1; row >= -ring; row -= 1) offsets.push([-ring, row]);
  for (let column = -ring + 1; column <= ring; column += 1) offsets.push([column, -ring]);
  for (let row = -ring + 1; row < 0; row += 1) offsets.push([ring, row]);
  return offsets;
}

export function workflowLayoutFromCanvas(input: {
  readonly projectId: string;
  readonly flow: PragmaFlowResource;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly viewport?: Viewport | undefined;
  readonly updatedAt?: string | undefined;
}): WorkflowLayout {
  return {
    schemaVersion: "pragma.desktop-flow-layout/v1",
    projectId: input.projectId,
    flowId: input.flow.metadata.id,
    flowVersion: input.flow.metadata.version,
    nodes: { ...input.positions },
    viewport: input.viewport ?? { x: 0, y: 0, zoom: 1 },
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  };
}
