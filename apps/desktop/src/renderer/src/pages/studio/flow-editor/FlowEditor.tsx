import {
  ArrowLeft,
  ArrowsOut,
  Brain,
  CheckCircle,
  CirclesFour,
  Code,
  DiamondsFour,
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
const LOGIC_NODE_PREFIX = "__pragma_canvas_logic__";
const LOGIC_DRAFT_PREFIX = "__pragma_canvas_logic_draft__";
const NODE_WIDTH = 238;
const NODE_HEIGHT = 104;
const LOGIC_NODE_WIDTH = 210;
const LOGIC_NODE_HEIGHT = 112;
const TERMINAL_NODE_WIDTH = 112;
const TERMINAL_HORIZONTAL_GAP = 180;
const NODE_HORIZONTAL_GAP = 36;
const NODE_VERTICAL_GAP = 28;
export const FLOW_ERROR_AUTO_DISMISS_MS = 5_000;

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

interface LogicNodeData extends Record<string, unknown> {
  readonly sourceId: string | null;
  readonly label: string;
  readonly fieldLabel: string;
  readonly outputs: readonly { readonly id: string; readonly label: string }[];
  readonly invalid: boolean;
}

type StepCanvasNode = Node<StepNodeData, "step">;
type LogicCanvasNode = Node<LogicNodeData, "logic">;
type TerminalCanvasNode = Node<TerminalNodeData, "terminal">;
type WorkflowCanvasNode = StepCanvasNode | LogicCanvasNode | TerminalCanvasNode;

interface EditorSnapshot {
  readonly flow: PragmaFlowResource;
  readonly positions: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly logicDraftIds: readonly string[];
}

interface NodeContextMenuState {
  readonly nodeId: string;
  readonly x: number;
  readonly y: number;
}

interface VisibleFlowError {
  readonly message: string;
  readonly sequence: number;
}

type FlowPaletteKind = FlowStepKind | "logic";

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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [logicDraftIds, setLogicDraftIds] = useState<readonly string[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<WorkflowCanvasNode>(
    buildCanvasNodes(initialFlow, {}),
  );
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [candidateIssues, setCandidateIssues] = useState<readonly string[]>([]);
  const errorSequenceRef = useRef(0);
  const [visibleError, setVisibleError] = useState<VisibleFlowError | null>(
    props.error === null ? null : { message: props.error, sequence: 0 },
  );
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
    () => [
      ...validateFlowDraft(flow),
      ...validateLogicRoutes(flow),
      ...validateFlowRuntimeSelections(flow, editorResources),
      ...logicDraftIds.map(
        (): FlowValidationIssue => ({
          path: ["spec", "graph", "transitions"],
          message: t("connectLogicUpstream"),
        }),
      ),
    ],
    [editorResources, flow, logicDraftIds, t],
  );
  const invalidStepIds = useMemo(
    () => new Set(localIssues.map((issue) => issue.stepId).filter((id): id is string => !!id)),
    [localIssues],
  );
  const targets = useMemo(
    () => resourceTargets(props.project.resources, flow.metadata.id),
    [flow.metadata.id, props.project.resources],
  );
  const showError = useCallback((message: string) => {
    errorSequenceRef.current += 1;
    setVisibleError({ message, sequence: errorSequenceRef.current });
  }, []);

  useEffect(() => {
    if (props.error !== null) showError(props.error);
  }, [props.error, showError]);

  useEffect(() => {
    if (visibleError === null) return;
    const timer = setTimeout(() => setVisibleError(null), FLOW_ERROR_AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [visibleError]);

  const positions = useCallback(() => canvasPositions(nodes), [nodes]);
  const snapshot = useCallback(
    (): EditorSnapshot => ({
      flow: structuredClone(flow),
      positions: positions(),
      logicDraftIds: [...logicDraftIds],
    }),
    [flow, logicDraftIds, positions],
  );

  const commitFlow = useCallback(
    (
      next: PragmaFlowResource,
      nextPositions?: Readonly<Record<string, { x: number; y: number }>>,
      nextSelectedNodeId = selectedNodeId,
      nextLogicDraftIds = logicDraftIds,
    ) => {
      if (
        JSON.stringify(next) === JSON.stringify(flow) &&
        nextPositions === undefined &&
        nextLogicDraftIds === logicDraftIds
      )
        return;
      historyRef.current.push(snapshot());
      futureRef.current = [];
      setFlow(next);
      setLogicDraftIds(nextLogicDraftIds);
      if (nextPositions !== undefined) {
        setNodes(
          buildCanvasNodes(
            next,
            nextPositions,
            invalidStepIds,
            nextSelectedNodeId,
            nextLogicDraftIds,
          ),
        );
      }
    },
    [flow, invalidStepIds, logicDraftIds, selectedNodeId, setNodes, snapshot],
  );

  const restoreSnapshot = useCallback(
    (next: EditorSnapshot) => {
      const nextSelectedNodeId =
        selectedNodeId !== null && canvasNodeExists(next.flow, selectedNodeId, next.logicDraftIds)
          ? selectedNodeId
          : null;
      setFlow(structuredClone(next.flow));
      setLogicDraftIds(next.logicDraftIds);
      setNodes(
        buildCanvasNodes(
          next.flow,
          next.positions,
          new Set(),
          nextSelectedNodeId,
          next.logicDraftIds,
        ),
      );
      setSelectedNodeId(nextSelectedNodeId);
      setSelectedEdgeId(null);
      setLayoutStatus("unsaved");
    },
    [selectedNodeId, setNodes],
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
      if (
        api === undefined ||
        flow.metadata.id.trim() === "" ||
        logicDraftIds.length > 0 ||
        (semanticDirty && !force)
      ) {
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
        showError(`Flow is published, but the layout was not saved: ${errorMessage(cause)}`);
        setLayoutStatus("unsaved");
        return false;
      }
    },
    [
      flow.metadata.id,
      flow.metadata.version,
      getViewport,
      logicDraftIds.length,
      positions,
      props.project.projectId,
      semanticDirty,
      showError,
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
        if (!cancelled) showError(`Layout could not be loaded: ${errorMessage(cause)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [fitView, initialFlow, props.project.projectId, setNodes, setViewport, showError]);

  useEffect(() => {
    setNodes((current) => {
      const selectedStep = current.find((node) => node.type === "step" && node.selected);
      return buildCanvasNodes(
        flow,
        canvasPositions(current),
        invalidStepIds,
        selectedStep?.id ??
          current.find((node) => node.type === "logic" && node.selected)?.id ??
          null,
        logicDraftIds,
      );
    });
  }, [flow, invalidStepIds, logicDraftIds, setNodes]);

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
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedNodeId !== null) {
        event.preventDefault();
        removeCanvasNode(selectedNodeId);
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
    copy.spec.graph.steps[id] = defaultStep(kind, targets, {
      prompt: t("humanDefaultPrompt"),
      approve: t("humanDefaultApprove"),
      reject: t("humanDefaultReject"),
    });
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
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
    setLayoutStatus("unsaved");
  };

  const removeStep = (stepId: string) => {
    commitFlow(deleteFlowStep(flow, stepId));
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  };

  const addLogicDraft = (position?: { x: number; y: number }) => {
    const id = `${LOGIC_DRAFT_PREFIX}${crypto.randomUUID()}`;
    const currentPositions = positions();
    const canvasBounds = canvasRef.current?.getBoundingClientRect();
    const viewportCenter =
      canvasBounds === undefined
        ? { x: 180 + LOGIC_NODE_WIDTH / 2, y: 180 + LOGIC_NODE_HEIGHT / 2 }
        : screenToFlowPosition({
            x: canvasBounds.left + canvasBounds.width / 2,
            y: canvasBounds.top + canvasBounds.height / 2,
          });
    const nextPosition =
      position ??
      nextAvailableNodePosition(currentPositions, {
        x: viewportCenter.x - LOGIC_NODE_WIDTH / 2,
        y: viewportCenter.y - LOGIC_NODE_HEIGHT / 2,
      });
    commitFlow(flow, { ...currentPositions, [id]: nextPosition }, id, [...logicDraftIds, id]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
    setLayoutStatus("unsaved");
  };

  const removeCanvasNode = (nodeId: string) => {
    if (flow.spec.graph.steps[nodeId] !== undefined) {
      removeStep(nodeId);
      return;
    }
    if (logicDraftIds.includes(nodeId)) {
      const nextPositions = { ...positions() };
      delete nextPositions[nodeId];
      commitFlow(
        flow,
        nextPositions,
        null,
        logicDraftIds.filter((candidate) => candidate !== nodeId),
      );
      setSelectedNodeId(null);
      setNodeContextMenu(null);
      return;
    }
    const sourceId = logicSourceId(nodeId);
    if (sourceId === null || !isRouteTransition(flow.spec.graph.transitions[sourceId])) return;
    if (!window.confirm(t("deleteLogicNodeConfirm"))) return;
    const copy = structuredClone(flow);
    const route = copy.spec.graph.transitions[sourceId];
    delete copy.spec.graph.transitions[sourceId];
    if (route !== undefined) {
      for (const destination of transitionDestinations(route))
        removeOrphanedLoop(copy, destination);
    }
    commitFlow(copy);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setNodeContextMenu(null);
  };

  const setConnection = (connection: Connection) => {
    if (connection.target === null || connection.source === null) return;
    if (logicDraftIds.includes(connection.target)) {
      const sourceId = connection.source;
      if (flow.spec.graph.steps[sourceId] === undefined) return;
      const existing = flow.spec.graph.transitions[sourceId];
      if (isRouteTransition(existing)) {
        setSelectedNodeId(logicNodeId(sourceId));
        showError(t("logicAlreadyExists"));
        return;
      }
      const fields = routeFieldOptions(flow, sourceId);
      const inferred = fields.length === 1 ? fields[0] : undefined;
      const route = createRouteTransition(inferred);
      const copy = structuredClone(flow);
      copy.spec.graph.transitions[sourceId] = route;
      if (existing !== undefined) removeOrphanedLoop(copy, existing);
      const nextLogicId = logicNodeId(sourceId);
      const nextPositions = { ...positions() };
      nextPositions[nextLogicId] = nextPositions[connection.target] ?? { x: 0, y: 0 };
      delete nextPositions[connection.target];
      commitFlow(
        copy,
        nextPositions,
        nextLogicId,
        logicDraftIds.filter((id) => id !== connection.target),
      );
      setSelectedNodeId(nextLogicId);
      setSelectedEdgeId(null);
      setInspectorOpen(true);
      return;
    }
    if (logicSourceId(connection.target) !== null) return;
    const destination = connectionDestination(connection.target);
    if (connection.source === START_NODE_ID) {
      if (destination !== null && typeof destination === "object" && "goto" in destination) {
        patchFlow((copy) => {
          copy.spec.graph.start = destination.goto;
        });
      }
      return;
    }
    if (destination === null) return;
    const semanticSource = logicSourceId(connection.source) ?? connection.source;
    if (flow.spec.graph.steps[semanticSource] === undefined) return;
    if (
      connection.source === semanticSource &&
      isRouteTransition(flow.spec.graph.transitions[semanticSource])
    ) {
      setSelectedNodeId(logicNodeId(semanticSource));
      setSelectedEdgeId(null);
      setInspectorOpen(true);
      showError(t("connectFromLogic"));
      return;
    }
    patchFlow((copy) =>
      applyConnection(
        copy,
        connection,
        normalizeConnectionDestination(copy, semanticSource, destination),
      ),
    );
  };

  const reconnect = (edge: Edge, connection: Connection) => {
    if (connection.target === null || connection.source === null) return;
    if (edge.id.endsWith(":logic-input") || logicDraftIds.includes(connection.target)) return;
    const destination = connectionDestination(connection.target);
    if (destination === null) return;
    const copy = structuredClone(flow);
    removeEdgeFromFlow(copy, edge);
    const semanticSource = logicSourceId(connection.source) ?? connection.source;
    applyConnection(
      copy,
      connection,
      normalizeConnectionDestination(copy, semanticSource, destination),
    );
    commitFlow(copy);
  };

  const disconnect = (deletedEdges: readonly Edge[]) => {
    const copy = structuredClone(flow);
    for (const edge of deletedEdges) removeEdgeFromFlow(copy, edge);
    commitFlow(copy);
    setSelectedEdgeId(null);
  };

  const edges = useMemo(() => buildCanvasEdges(flow), [flow]);

  const publish = async () => {
    const api = desktopApi();
    if (api === undefined || saving) return;
    setCandidateIssues([]);
    setVisibleError(null);
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
      showError(errorMessage(cause));
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
              setNodes(
                buildCanvasNodes(flow, arranged, invalidStepIds, selectedNodeId, logicDraftIds),
              );
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
                <PaletteItem kind="logic" icon={<DiamondsFour />} label={t("logicCondition")} />
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
            const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            if (kind === "logic") addLogicDraft(position);
            else if (isFlowStepKind(kind)) addStep(kind, position);
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
              const selectedEdge = selectedEdges[0];
              const selectedNode = selectedEdge === undefined ? selectedNodes[0] : undefined;
              setSelectedEdgeId(selectedEdge?.id ?? null);
              setSelectedNodeId(
                selectedNode?.type === "step" || selectedNode?.type === "logic"
                  ? selectedNode.id
                  : null,
              );
            }}
            onNodeClick={(_event, node) => {
              setNodeContextMenu(null);
              setSelectedEdgeId(null);
              if (node.type === "step" || node.type === "logic") {
                setSelectedNodeId(node.id);
                setInspectorOpen(true);
              } else setSelectedNodeId(null);
            }}
            onEdgeClick={(_event, edge) => {
              setSelectedNodeId(null);
              setSelectedEdgeId(edge.id);
              setNodeContextMenu(null);
              setInspectorOpen(true);
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              if (node.type !== "step" && node.type !== "logic") {
                setNodeContextMenu(null);
                return;
              }
              const bounds = canvasRef.current?.getBoundingClientRect();
              if (bounds === undefined) return;
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
              setNodeContextMenu({
                nodeId: node.id,
                x: Math.max(8, Math.min(event.clientX - bounds.left, bounds.width - 154)),
                y: Math.max(8, Math.min(event.clientY - bounds.top, bounds.height - 52)),
              });
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
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
              aria-label={`${nodeContextMenu.nodeId} actions`}
              style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => removeCanvasNode(nodeContextMenu.nodeId)}
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
            selectedEdgeId !== null ? (
              <EdgeInspector
                flow={flow}
                edge={edges.find((edge) => edge.id === selectedEdgeId)}
                onPatch={patchFlow}
                onDelete={() => {
                  const edge = edges.find((candidate) => candidate.id === selectedEdgeId);
                  if (edge !== undefined) disconnect([edge]);
                }}
              />
            ) : selectedNodeId === null ? (
              <FlowSettings flow={flow} lockId={props.initial !== undefined} onPatch={patchFlow} />
            ) : flow.spec.graph.steps[selectedNodeId] !== undefined ? (
              <StepInspector
                flow={flow}
                stepId={selectedNodeId}
                targets={targets}
                runtimes={props.runtimes}
                resources={editorResources}
                onSupportingResource={(resource) =>
                  setSupportingResources((current) => mergePragmaResources(current, [resource]))
                }
                onPatch={patchFlow}
                onRename={(nextId) => {
                  const next = renameFlowStep(flow, selectedNodeId, nextId);
                  if (next === flow) return;
                  const nextPositions = { ...positions(), [nextId]: positions()[selectedNodeId]! };
                  delete nextPositions[selectedNodeId];
                  const previousLogicId = logicNodeId(selectedNodeId);
                  const nextLogicId = logicNodeId(nextId);
                  if (nextPositions[previousLogicId] !== undefined) {
                    nextPositions[nextLogicId] = nextPositions[previousLogicId];
                    delete nextPositions[previousLogicId];
                  }
                  commitFlow(next, nextPositions);
                  setSelectedNodeId(nextId);
                }}
                onDelete={() => removeStep(selectedNodeId)}
              />
            ) : (
              <LogicInspector
                flow={flow}
                nodeId={selectedNodeId}
                onPatch={patchFlow}
                onDelete={() => removeCanvasNode(selectedNodeId)}
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
                    onClick={() => issue.stepId && setSelectedNodeId(issue.stepId)}
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
      {visibleError !== null ? (
        <p className="flow-editor-error" role="alert">
          {visibleError.message}
        </p>
      ) : null}
    </section>
  );
}

function PaletteItem(props: {
  readonly kind: FlowPaletteKind;
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
  const kindLabel =
    props.data.kind === "expert"
      ? t("expert")
      : props.data.kind === "team"
        ? t("expertTeam")
        : props.data.kind === "flow"
          ? t("subFlow")
          : props.data.kind === "action"
            ? t("action")
            : t("humanInput");
  const singleOutput =
    props.data.outputs.length === 1 && props.data.outputs[0]?.id === "default"
      ? props.data.outputs[0]
      : undefined;
  return (
    <article
      className={`flow-step-node is-${props.data.kind}${props.selected ? " is-selected" : ""}${props.data.invalid ? " is-invalid" : ""}`}
    >
      <Handle type="target" id="target" position={Position.Left} />
      <span className="flow-step-kind">{kindLabel}</span>
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

function LogicNode(props: NodeProps<LogicCanvasNode>) {
  const { t } = useTranslation("studio");
  return (
    <article
      className={`flow-logic-node${props.selected ? " is-selected" : ""}${props.data.invalid ? " is-invalid" : ""}`}
    >
      <Handle type="target" id="target" position={Position.Left} />
      <span className="flow-step-kind">{t("logic")}</span>
      <div className="flow-step-main">
        <span className="flow-step-icon">
          <DiamondsFour size={18} />
        </span>
        <div>
          <strong>{props.data.label}</strong>
          <small>{props.data.fieldLabel}</small>
        </div>
      </div>
      {props.data.outputs.length === 0 ? (
        <small className="flow-logic-connect-hint">{t("connectUpstream")}</small>
      ) : (
        <div className="flow-step-outputs">
          {props.data.outputs.map((output) => (
            <span key={output.id}>
              {output.label}
              <Handle
                type="source"
                id={output.id}
                position={Position.Right}
                className="flow-step-add-handle"
                aria-label={t("connectLogicBranch", {
                  branch: output.label,
                })}
                title={t("dragConnectBranch", { branch: output.label })}
              >
                <Plus size={13} weight="bold" />
              </Handle>
            </span>
          ))}
        </div>
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

const nodeTypes = { step: StepNode, logic: LogicNode, terminal: TerminalNode };

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
            aria-label={
              props.label === undefined
                ? t("deleteEdge")
                : t("deleteNamedEdge", { name: String(props.label) })
            }
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
      <StructuredOutputEditor
        label={t("flowInputContract")}
        nativeLabel={t("freeformInput")}
        structuredLabel={t("structuredInput")}
        nativeHint={t("freeformInputHint")}
        fieldsTitle={t("inputFields")}
        value={props.flow.spec.input?.schema}
        onChange={(schema) =>
          props.onPatch((copy) => {
            copy.spec.input = schema === undefined ? undefined : { schema };
          })
        }
      />
      <StructuredOutputEditor
        label={t("flowOutputContract")}
        nativeLabel={t("uncheckedOutput")}
        structuredLabel={t("structuredResult")}
        nativeHint={t("uncheckedOutputHint")}
        fieldsTitle={t("resultFields")}
        value={props.flow.spec.output?.schema}
        onChange={(schema) =>
          props.onPatch((copy) => {
            if (schema === undefined) {
              delete copy.spec.output;
            } else {
              copy.spec.output = {
                schema,
                ...(copy.spec.output?.value === undefined ? {} : { value: copy.spec.output.value }),
              };
            }
          })
        }
      />
      {props.flow.spec.output === undefined ? null : (
        <>
          <InspectorField label={t("flowResultSource")}>
            <select
              value={props.flow.spec.output.value === undefined ? "terminal" : "mapping"}
              onChange={(event) =>
                props.onPatch((copy) => {
                  if (copy.spec.output === undefined) return;
                  if (event.target.value === "terminal") delete copy.spec.output.value;
                  else copy.spec.output.value = emptyResultMapping(copy.spec.output.schema);
                })
              }
            >
              <option value="terminal">{t("terminalNodeResult")}</option>
              <option value="mapping">{t("customResultMapping")}</option>
            </select>
          </InspectorField>
          {props.flow.spec.output.value === undefined ? (
            <small className="flow-field-hint">{t("terminalNodeResultHint")}</small>
          ) : (
            <ResultMappingEditor
              flow={props.flow}
              schema={props.flow.spec.output.schema}
              value={props.flow.spec.output.value}
              onChange={(value) =>
                props.onPatch((copy) => {
                  if (copy.spec.output !== undefined) copy.spec.output.value = value;
                })
              }
            />
          )}
        </>
      )}
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
  if (step === undefined) return null;
  const kind = flowStepKind(step);
  const target = flowStepTarget(step);
  const StepIcon =
    kind === "expert"
      ? Robot
      : kind === "team"
        ? UsersThree
        : kind === "flow"
          ? GitBranch
          : kind === "action"
            ? Sparkle
            : UserFocus;
  const kindLabel =
    kind === "expert"
      ? t("expert")
      : kind === "team"
        ? t("expertTeam")
        : kind === "flow"
          ? t("subFlow")
          : kind === "action"
            ? t("action")
            : t("humanInput");
  const patchStep = (mutator: (copy: FlowStep) => void) =>
    props.onPatch((copy) => {
      const current = copy.spec.graph.steps[props.stepId];
      if (current !== undefined) mutator(current);
    });
  return (
    <div className="flow-inspector-content">
      <header>
        <span className={`flow-inspector-icon is-${kind}`}>
          <StepIcon size={19} />
        </span>
        <div>
          <strong>{props.stepId}</strong>
          <small>{t("nodeKind", { kind: kindLabel })}</small>
        </div>
      </header>
      <InspectorField label={t("nodeId")}>
        <input
          key={props.stepId}
          defaultValue={props.stepId}
          onBlur={(event) => props.onRename(event.target.value)}
        />
      </InspectorField>
      {kind === "human" ? (
        <>
          <section className="flow-human-purpose">
            <UserFocus size={18} />
            <div>
              <strong>{t("humanPurposeTitle")}</strong>
              <p>{t("humanPurposeDescription")}</p>
            </div>
          </section>
          <InspectorField label={t("humanRequestType")}>
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
              <option value="approval">{t("humanTypeApproval")}</option>
              <option value="question">{t("humanTypeQuestion")}</option>
              <option value="review_gate">{t("humanTypeReviewGate")}</option>
              <option value="manual_intervention">{t("humanTypeManualIntervention")}</option>
            </select>
          </InspectorField>
          <small className="flow-field-hint">
            {step.human?.kind === "approval"
              ? t("humanTypeApprovalHint")
              : step.human?.kind === "question"
                ? t("humanTypeQuestionHint")
                : step.human?.kind === "review_gate"
                  ? t("humanTypeReviewGateHint")
                  : t("humanTypeManualInterventionHint")}
          </small>
          <InspectorField label={t("humanTitle")}>
            <input
              value={step.human?.title ?? ""}
              placeholder={t("humanTitlePlaceholder")}
              onChange={(event) =>
                patchStep((current) => {
                  if (current.human) current.human.title = event.target.value || undefined;
                })
              }
            />
          </InspectorField>
          <InspectorField label={t("humanPrompt")}>
            <textarea
              rows={3}
              value={step.human?.prompt ?? ""}
              placeholder={t("humanPromptPlaceholder")}
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
                label={t("humanApprovalChoices")}
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
              <small className="flow-field-hint">{t("humanApprovalChoicesHint")}</small>
              <InspectorField label={t("humanApprovedChoice")}>
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
          <details className="flow-human-advanced">
            <summary>{t("humanAdditionalQuestions")}</summary>
            <p>{t("humanAdditionalQuestionsHint")}</p>
            <HumanQuestionsEditor
              questions={step.human?.questions ?? []}
              onChange={(questions) =>
                patchStep((current) => {
                  if (current.human) {
                    if (questions.length === 0) delete current.human.questions;
                    else current.human.questions = questions;
                  }
                })
              }
            />
          </details>
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

function emptyResultMapping(schema: PragmaJsonSchema, path: readonly string[] = []): unknown {
  if (schema.type === "object") {
    return Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [
        name,
        emptyResultMapping(child, [...path, name]),
      ]),
    );
  }
  return `$node.output${path.length === 0 ? "" : `.${path.join(".")}`}`;
}

function ResultMappingEditor(props: {
  readonly flow: PragmaFlowResource;
  readonly schema: Extract<PragmaJsonSchema, { readonly type: "object" }>;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("studio");
  const fields = schemaLeafFields(props.schema);
  return (
    <section className="flow-result-mapping">
      <header>
        <strong>{t("resultMapping")}</strong>
        <small>{t("resultMappingHint")}</small>
      </header>
      {fields.length === 0 ? (
        <small className="flow-field-hint">{t("emptyResultMapping")}</small>
      ) : (
        fields.map((field) => {
          const current = readMappingValue(props.value, field.path);
          const options = resultSourceOptions(props.flow, field.path, {
            terminalResult: t("terminalResultSource"),
            flowInput: t("flowInputSource"),
          });
          const selected =
            typeof current === "string" && options.some((option) => option.value === current)
              ? current
              : "__constant";
          return (
            <div className="flow-result-mapping-row" key={field.path.join(".")}>
              <label>
                <span>{field.path.join(".")}</span>
                <select
                  value={selected}
                  onChange={(event) => {
                    const value =
                      event.target.value === "__constant"
                        ? defaultMappingConstant(field.schema)
                        : event.target.value;
                    props.onChange(setMappingValue(props.value, field.path, value));
                  }}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                  <option value="__constant">{t("constantValue")}</option>
                </select>
              </label>
              {selected === "__constant" ? (
                <MappingConstantInput
                  schema={field.schema}
                  value={current}
                  onChange={(value) =>
                    props.onChange(setMappingValue(props.value, field.path, value))
                  }
                />
              ) : null}
            </div>
          );
        })
      )}
    </section>
  );
}

function MappingConstantInput(props: {
  readonly schema: PragmaJsonSchema;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation("studio");
  if (props.schema.type === "boolean") {
    return (
      <select
        aria-label={t("constantValue")}
        value={props.value === true ? "true" : "false"}
        onChange={(event) => props.onChange(event.target.value === "true")}
      >
        <option value="false">false</option>
        <option value="true">true</option>
      </select>
    );
  }
  if (props.schema.type === "number" || props.schema.type === "integer") {
    return (
      <input
        aria-label={t("constantValue")}
        type="number"
        step={props.schema.type === "integer" ? 1 : "any"}
        value={typeof props.value === "number" ? props.value : 0}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
    );
  }
  if (props.schema.type === "array") {
    return <small className="flow-field-hint">{t("arrayMappingRequiresSource")}</small>;
  }
  return (
    <input
      aria-label={t("constantValue")}
      value={typeof props.value === "string" ? props.value : ""}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

function schemaLeafFields(
  schema: PragmaJsonSchema,
  path: readonly string[] = [],
): readonly { readonly path: readonly string[]; readonly schema: PragmaJsonSchema }[] {
  if (schema.type !== "object") return [{ path, schema }];
  return Object.entries(schema.properties).flatMap(([name, child]) =>
    schemaLeafFields(child, [...path, name]),
  );
}

function resultSourceOptions(
  flow: PragmaFlowResource,
  resultPath: readonly string[],
  labels: {
    readonly terminalResult: string;
    readonly flowInput: string;
  },
): readonly { readonly value: string; readonly label: string }[] {
  const suffix = resultPath.length === 0 ? "" : `.${resultPath.join(".")}`;
  const options: Array<{ value: string; label: string }> = [
    { value: `$node.output${suffix}`, label: `${labels.terminalResult}${suffix}` },
  ];
  if (flow.spec.input !== undefined) {
    for (const field of schemaLeafFields(flow.spec.input.schema)) {
      if (field.path.length === 0) continue;
      options.push({
        value: `$flow.input.${field.path.join(".")}`,
        label: `${labels.flowInput}.${field.path.join(".")}`,
      });
    }
  }
  for (const [nodeId, step] of Object.entries(flow.spec.graph.steps)) {
    options.push({
      value: `$state.nodes.${nodeId}.result`,
      label: `${nodeId}.result`,
    });
    if (step.output !== undefined) {
      for (const field of schemaLeafFields(step.output.schema)) {
        if (field.path.length === 0) continue;
        options.push({
          value: `$state.nodes.${nodeId}.result.${field.path.join(".")}`,
          label: `${nodeId}.result.${field.path.join(".")}`,
        });
      }
    }
  }
  return options;
}

function readMappingValue(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function setMappingValue(value: unknown, path: readonly string[], nextValue: unknown): unknown {
  const root =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? structuredClone(value as Record<string, unknown>)
      : {};
  let current = root;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      current[segment] = nextValue;
      return;
    }
    const child = current[segment];
    const next =
      typeof child === "object" && child !== null && !Array.isArray(child)
        ? (child as Record<string, unknown>)
        : {};
    current[segment] = next;
    current = next;
  });
  return root;
}

function defaultMappingConstant(schema: PragmaJsonSchema): unknown {
  switch (schema.type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties).map(([name, child]) => [
          name,
          defaultMappingConstant(child),
        ]),
      );
  }
}

function StructuredOutputEditor(props: {
  readonly label?: string | undefined;
  readonly nativeLabel?: string | undefined;
  readonly structuredLabel?: string | undefined;
  readonly nativeHint?: string | undefined;
  readonly fieldsTitle?: string | undefined;
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
      <InspectorField label={props.label ?? t("flowOutput")}>
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
          <option value="native">{props.nativeLabel ?? t("nativeResult")}</option>
          <option value="structured">{props.structuredLabel ?? t("structuredResult")}</option>
        </select>
      </InspectorField>
      {props.value === undefined ? (
        <small className="flow-field-hint">{props.nativeHint ?? t("nativeResultHint")}</small>
      ) : (
        <SchemaFieldsEditor
          title={props.fieldsTitle ?? t("resultFields")}
          fields={fields}
          onChange={update}
        />
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

export function validateLogicRoutes(flow: PragmaFlowResource): readonly FlowValidationIssue[] {
  const issues: FlowValidationIssue[] = [];
  for (const [sourceId, transition] of Object.entries(flow.spec.graph.transitions)) {
    if (!isRouteTransition(transition)) continue;
    const field = routeFieldOptions(flow, sourceId).find(
      (candidate) => candidate.name === transition.route,
    );
    const add = (message: string) =>
      issues.push({
        path: ["spec", "graph", "transitions", sourceId],
        message,
        stepId: sourceId,
      });
    if (Object.keys(transition.cases).some((key) => key.trim() === "")) {
      add("Logic branch values cannot be empty.");
    }
    if (field?.type === "boolean") {
      if (transition.cases["true"] === undefined || transition.cases["false"] === undefined) {
        add(`Boolean logic ${sourceId}.result.${field.name} requires true and false branches.`);
      }
      continue;
    }
    if (field !== undefined && Object.keys(transition.cases).length === 0) {
      add(`Logic ${sourceId}.result.${field.name} requires at least one case.`);
    }
    if (field !== undefined && transition.fallback === undefined) {
      add(`Logic ${sourceId}.result.${field.name} requires an otherwise branch.`);
    }
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

function LogicInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly nodeId: string;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const sourceId = logicSourceId(props.nodeId);
  if (sourceId === null) {
    return (
      <div className="flow-inspector-content">
        <header>
          <span className="flow-inspector-icon is-logic">
            <DiamondsFour size={19} />
          </span>
          <div>
            <strong>{t("logicCondition")}</strong>
            <small>{t("logicDraftDescription")}</small>
          </div>
        </header>
        <div className="flow-logic-empty">
          <DiamondsFour size={20} />
          <strong>{t("connectLogicUpstream")}</strong>
          <p>{t("connectLogicUpstreamHint")}</p>
        </div>
        <button className="flow-delete-node" type="button" onClick={props.onDelete}>
          <Trash size={16} /> {t("deleteNode")}
        </button>
      </div>
    );
  }
  const transition = props.flow.spec.graph.transitions[sourceId];
  if (!isRouteTransition(transition)) return null;
  const fields = routeFieldOptions(props.flow, sourceId);
  const currentField = fields.find((field) => field.name === transition.route);
  const booleanField = currentField?.type === "boolean";
  const visibleCases: readonly [string, PragmaFlowDestination][] = booleanField
    ? (["true", "false"] as const).map((key) => [
        key,
        transition.cases[key] ?? unconnectedDestination(),
      ])
    : Object.entries(transition.cases);
  const fieldLabel = `${sourceId}.result.${transition.route}`;
  const patchRoute = (mutator: (route: Extract<PragmaFlowTransition, { route: string }>) => void) =>
    props.onPatch((copy) => {
      const route = copy.spec.graph.transitions[sourceId];
      if (isRouteTransition(route)) mutator(route);
    });

  return (
    <div className="flow-inspector-content">
      <header>
        <span className="flow-inspector-icon is-logic">
          <DiamondsFour size={19} />
        </span>
        <div>
          <strong>{t("logicCondition")}</strong>
          <small>{t("logicFromNode", { node: sourceId })}</small>
        </div>
      </header>
      <InspectorField label={t("decisionField")}>
        <select
          value={transition.route}
          onChange={(event) => {
            const field = fields.find((candidate) => candidate.name === event.target.value);
            props.onPatch((copy) => {
              const route = copy.spec.graph.transitions[sourceId];
              if (!isRouteTransition(route)) return;
              const previousDestinations = transitionDestinations(route);
              route.route = event.target.value;
              if (field?.type === "boolean") {
                route.cases = {
                  true: route.cases["true"] ?? unconnectedDestination(),
                  false: route.cases["false"] ?? route.fallback ?? unconnectedDestination(),
                };
                delete route.fallback;
              } else if (route.fallback === undefined) {
                route.fallback = unconnectedDestination();
              }
              for (const destination of previousDestinations) {
                removeOrphanedLoop(copy, destination);
              }
            });
          }}
        >
          {currentField === undefined ? (
            <option value={transition.route}>
              {t("customDecisionField", { field: fieldLabel })}
            </option>
          ) : null}
          {fields.map((field) => (
            <option key={field.name} value={field.name}>
              {sourceId}.result.{field.name} · {field.type}
            </option>
          ))}
        </select>
      </InspectorField>
      {fields.length === 0 || currentField === undefined ? (
        <p className="flow-logic-warning">{t("decisionFieldNotInSchema")}</p>
      ) : (
        <p className="flow-field-hint">{t("decisionFieldHint", { field: fieldLabel })}</p>
      )}
      <section className="flow-logic-branches">
        <header>
          <div>
            <strong>{t("branches")}</strong>
            <small>{booleanField ? t("booleanBranchesHint") : t("exactMatchBranchesHint")}</small>
          </div>
          {booleanField ? null : (
            <button
              type="button"
              onClick={() =>
                patchRoute((route) => {
                  const key = nextCaseKey(route.cases);
                  route.cases = { ...route.cases, [key]: unconnectedDestination() };
                })
              }
            >
              <Plus size={14} /> {t("addCase")}
            </button>
          )}
        </header>
        {visibleCases.map(([key, destination]) => (
          <div className="flow-logic-branch-row" key={key}>
            <span className={`flow-logic-branch-value${booleanField ? " is-boolean" : ""}`}>
              {booleanField ? (
                key
              ) : (
                <input
                  aria-label={t("caseValue")}
                  value={key}
                  onChange={(event) =>
                    patchRoute((route) => {
                      route.cases = renameRouteCase(route.cases, key, event.target.value);
                    })
                  }
                />
              )}
            </span>
            <span
              className={`flow-logic-branch-target${
                isUnconnectedDestination(destination) ? " is-unconnected" : ""
              }`}
            >
              {isUnconnectedDestination(destination)
                ? t("branchNotConnected")
                : destinationLabel(destination)}
            </span>
            {booleanField ? null : (
              <button
                type="button"
                aria-label={t("removeCase", { value: key })}
                onClick={() =>
                  props.onPatch((copy) => {
                    const route = copy.spec.graph.transitions[sourceId];
                    if (!isRouteTransition(route)) return;
                    const removed = route.cases[key];
                    const next = { ...route.cases };
                    delete next[key];
                    route.cases = next;
                    removeOrphanedLoop(copy, removed);
                  })
                }
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        {booleanField ? null : transition.fallback === undefined ? (
          <button
            className="flow-logic-add-fallback"
            type="button"
            onClick={() => patchRoute((route) => (route.fallback = unconnectedDestination()))}
          >
            <Plus size={14} /> {t("addFallback")}
          </button>
        ) : (
          <div className="flow-logic-branch-row is-fallback">
            <span className="flow-logic-branch-value">{t("otherBranch")}</span>
            <span
              className={`flow-logic-branch-target${
                isUnconnectedDestination(transition.fallback) ? " is-unconnected" : ""
              }`}
            >
              {isUnconnectedDestination(transition.fallback)
                ? t("branchNotConnected")
                : destinationLabel(transition.fallback)}
            </span>
          </div>
        )}
      </section>
      <p className="flow-field-hint">{t("dragBranchHint")}</p>
      <details className="flow-advanced-settings">
        <summary>{t("advancedSettings")}</summary>
        <InspectorField label={t("rawTransitionDsl")}>
          <pre className="flow-raw-dsl">{stringify(transition, { lineWidth: 72 })}</pre>
        </InspectorField>
      </details>
      <button className="flow-delete-node" type="button" onClick={props.onDelete}>
        <Trash size={16} /> {t("deleteLogicNode")}
      </button>
    </div>
  );
}

function EdgeInspector(props: {
  readonly flow: PragmaFlowResource;
  readonly edge: Edge | undefined;
  readonly onPatch: (mutator: (copy: PragmaFlowResource) => void) => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("studio");
  const destination =
    props.edge === undefined ? undefined : edgeDestination(props.flow, props.edge);
  if (props.edge === undefined) {
    return (
      <div className="flow-inspector-content">
        <p className="flow-field-hint">{t("selectControlEdge")}</p>
      </div>
    );
  }
  if (destination === undefined) {
    return (
      <div className="flow-inspector-content">
        <header>
          <span className="flow-inspector-icon">
            <Path size={19} />
          </span>
          <div>
            <strong>{t("flowEdge")}</strong>
            <small>{props.edge.label}</small>
          </div>
        </header>
        <p className="flow-field-hint">{t("logicInputEdgeHint")}</p>
        <button className="flow-delete-node" type="button" onClick={props.onDelete}>
          <Trash size={16} /> {t("deleteEdge")}
        </button>
      </div>
    );
  }
  const mode =
    typeof destination === "object" && "repeat" in destination
      ? "repeat"
      : typeof destination === "object" && "fail" in destination
        ? "fail"
        : "next";
  const patchDestination = (next: PragmaFlowDestination) =>
    props.onPatch((copy) => {
      if (props.edge !== undefined) setEdgeDestination(copy, props.edge, next);
    });
  const loop =
    mode === "repeat" && typeof destination === "object" && "repeat" in destination
      ? props.flow.spec.graph.loops[destination.repeat.loop]
      : undefined;
  return (
    <div className="flow-inspector-content">
      <header>
        <span className={`flow-inspector-icon is-${mode}`}>
          <Path size={19} />
        </span>
        <div>
          <strong>
            {mode === "repeat" ? t("loopEdge") : mode === "fail" ? t("failEdge") : t("flowEdge")}
          </strong>
          <small>{props.edge.label}</small>
        </div>
      </header>
      {mode === "fail" && typeof destination === "object" && "fail" in destination ? (
        <InspectorField label={t("failureMessage")}>
          <input
            value={destination.fail}
            onChange={(event) => patchDestination({ fail: event.target.value })}
          />
        </InspectorField>
      ) : null}
      {mode === "repeat" && typeof destination === "object" && "repeat" in destination ? (
        <>
          <InspectorField label={t("loopId")}>
            <input
              value={destination.repeat.loop}
              onChange={(event) => {
                const nextId = event.target.value;
                props.onPatch((copy) => {
                  if (props.edge === undefined) return;
                  const previousId = destination.repeat.loop;
                  setEdgeDestination(copy, props.edge, {
                    repeat: { loop: nextId, goto: destination.repeat.goto },
                  });
                  const definition = copy.spec.graph.loops[previousId];
                  if (definition !== undefined) {
                    delete copy.spec.graph.loops[previousId];
                    copy.spec.graph.loops[nextId] = definition;
                  }
                });
              }}
            />
          </InspectorField>
          <InspectorField label={t("loopEntry")}>
            <input value={destination.repeat.goto} readOnly />
          </InspectorField>
          <InspectorField label={t("maxIterations")}>
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
                    maxIterations: Math.max(1, Number(event.target.value)),
                  };
                })
              }
            />
          </InspectorField>
          <InspectorField label={t("onLimit")}>
            <select
              value={flowTargetSelectValue(loop?.onLimit)}
              onChange={(event) =>
                props.onPatch((copy) => {
                  const current = copy.spec.graph.loops[destination.repeat.loop];
                  if (current !== undefined)
                    current.onLimit = flowTargetFromSelect(event.target.value);
                })
              }
            >
              <option value="end">{t("endFlow")}</option>
              <option value="fail">{t("failFlow")}</option>
              {Object.keys(props.flow.spec.graph.steps)
                .filter((id) => id !== destination.repeat.goto)
                .map((id) => (
                  <option key={id} value={`goto:${id}`}>
                    {id}
                  </option>
                ))}
            </select>
          </InspectorField>
        </>
      ) : null}
      {mode === "next" ? (
        <p className="flow-field-hint">
          {t("edgeTarget", { target: destinationLabel(destination) })}
        </p>
      ) : null}
      <button className="flow-delete-node" type="button" onClick={props.onDelete}>
        <Trash size={16} /> {t("deleteEdge")}
      </button>
    </div>
  );
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
  const { t } = useTranslation("studio");
  const patch = (index: number, update: (question: HumanQuestion) => HumanQuestion) => {
    props.onChange(
      props.questions.map((question, current) => (current === index ? update(question) : question)),
    );
  };
  return (
    <div className="flow-human-questions">
      {props.questions.length === 0 ? (
        <p className="flow-human-questions-empty">{t("humanNoAdditionalQuestions")}</p>
      ) : null}
      {props.questions.map((question, index) => (
        <section className="flow-human-question-card" key={`${question.id}-${index}`}>
          <header>
            <strong>{t("humanQuestionNumber", { number: index + 1 })}</strong>
            <button
              type="button"
              className="flow-inspector-delete"
              aria-label={t("humanRemoveQuestion", { number: index + 1 })}
              onClick={() =>
                props.onChange(props.questions.filter((_, current) => current !== index))
              }
            >
              <Trash size={14} /> {t("remove")}
            </button>
          </header>
          <InspectorField label={t("humanQuestionId")}>
            <input
              value={question.id}
              placeholder={t("humanQuestionIdPlaceholder")}
              onChange={(event) =>
                patch(index, (current) => ({ ...current, id: event.target.value }))
              }
            />
          </InspectorField>
          <InspectorField label={t("humanQuestionType")}>
            <select
              value={question.type}
              onChange={(event) =>
                patch(index, (current) => ({
                  ...current,
                  type: event.target.value as HumanQuestion["type"],
                  options: event.target.value === "text" ? [] : current.options,
                }))
              }
            >
              <option value="single_choice">{t("humanQuestionSingleChoice")}</option>
              <option value="multiple_choice">{t("humanQuestionMultipleChoice")}</option>
              <option value="text">{t("humanQuestionText")}</option>
            </select>
          </InspectorField>
          <InspectorField label={t("humanQuestionLabel")}>
            <input
              value={question.label}
              placeholder={t("humanQuestionLabelPlaceholder")}
              onChange={(event) =>
                patch(index, (current) => ({ ...current, label: event.target.value }))
              }
            />
          </InspectorField>
          {question.type === "text" ? null : (
            <StringListField
              label={t("humanQuestionOptions")}
              values={question.options}
              onChange={(options) =>
                patch(index, (current) => ({
                  ...current,
                  options,
                }))
              }
            />
          )}
        </section>
      ))}
      <button
        type="button"
        className="flow-human-add-question"
        onClick={() =>
          props.onChange([
            ...props.questions,
            {
              id: `question_${props.questions.length + 1}`,
              type: "text",
              label: t("humanDefaultQuestion"),
              options: [],
            },
          ])
        }
      >
        <Plus size={14} /> {t("humanAddQuestion")}
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

function defaultStep(
  kind: FlowStepKind,
  targets: readonly ResourceTarget[],
  humanCopy: { readonly prompt: string; readonly approve: string; readonly reject: string },
): FlowStep {
  const version = "1.0.0";
  if (kind === "human")
    return {
      human: {
        kind: "approval",
        prompt: humanCopy.prompt,
        options: [humanCopy.approve, humanCopy.reject],
        approveOption: humanCopy.approve,
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

type RouteTransition = Extract<PragmaFlowTransition, { route: string }>;
type RouteFieldType = "string" | "number" | "integer" | "boolean";

interface RouteFieldOption {
  readonly name: string;
  readonly type: RouteFieldType;
}

function isRouteTransition(
  transition: PragmaFlowTransition | undefined,
): transition is RouteTransition {
  return typeof transition === "object" && transition !== null && "route" in transition;
}

function logicNodeId(sourceId: string): string {
  return `${LOGIC_NODE_PREFIX}${encodeURIComponent(sourceId)}`;
}

function logicSourceId(nodeId: string): string | null {
  if (!nodeId.startsWith(LOGIC_NODE_PREFIX) || nodeId.startsWith(LOGIC_DRAFT_PREFIX)) return null;
  try {
    return decodeURIComponent(nodeId.slice(LOGIC_NODE_PREFIX.length));
  } catch {
    return null;
  }
}

function canvasNodeExists(
  flow: PragmaFlowResource,
  nodeId: string,
  logicDraftIds: readonly string[],
): boolean {
  if (flow.spec.graph.steps[nodeId] !== undefined || logicDraftIds.includes(nodeId)) return true;
  const sourceId = logicSourceId(nodeId);
  return sourceId !== null && isRouteTransition(flow.spec.graph.transitions[sourceId]);
}

export function routeFieldOptions(
  flow: PragmaFlowResource,
  sourceId: string,
): readonly RouteFieldOption[] {
  const schema = flow.spec.graph.steps[sourceId]?.output?.schema;
  if (schema?.type !== "object") return [];
  return Object.entries(schema.properties).flatMap(([name, property]) =>
    ["string", "number", "integer", "boolean"].includes(property.type)
      ? [{ name, type: property.type as RouteFieldType }]
      : [],
  );
}

export function createRouteTransition(field: RouteFieldOption | undefined): RouteTransition {
  if (field?.type === "boolean") {
    return {
      route: field.name,
      cases: {
        true: unconnectedDestination(),
        false: unconnectedDestination(),
      },
    };
  }
  return {
    route: field?.name ?? "result",
    cases: { value_1: unconnectedDestination() },
    fallback: unconnectedDestination(),
  };
}

function routeOutputs(
  flow: PragmaFlowResource,
  sourceId: string,
  route: RouteTransition,
): readonly { id: string; label: string }[] {
  const field = routeFieldOptions(flow, sourceId).find(
    (candidate) => candidate.name === route.route,
  );
  const caseNames = field?.type === "boolean" ? ["true", "false"] : Object.keys(route.cases);
  return [
    ...caseNames.map((key) => ({ id: `case:${key}`, label: key })),
    ...(field?.type === "boolean" ? [] : [{ id: "fallback", label: "otherwise" }]),
  ];
}

function nextCaseKey(cases: Readonly<Record<string, PragmaFlowDestination>>): string {
  let index = 1;
  let key = `value_${index}`;
  while (cases[key] !== undefined) {
    index += 1;
    key = `value_${index}`;
  }
  return key;
}

function renameRouteCase(
  cases: Readonly<Record<string, PragmaFlowDestination>>,
  previousKey: string,
  nextKey: string,
): Record<string, PragmaFlowDestination> {
  if (previousKey === nextKey || nextKey.trim() === "" || cases[nextKey] !== undefined) {
    return { ...cases };
  }
  return Object.fromEntries(
    Object.entries(cases).map(([key, destination]) => [
      key === previousKey ? nextKey : key,
      destination,
    ]),
  );
}

function destinationLabel(destination: PragmaFlowDestination): string {
  if (typeof destination === "string") return destination;
  if ("goto" in destination) return destination.goto === "" ? "Not connected" : destination.goto;
  if ("end" in destination) return "End";
  if ("fail" in destination) return "Fail";
  return `${destination.repeat.goto} · ${destination.repeat.loop}`;
}

function unconnectedDestination(): PragmaFlowDestination {
  return { goto: "" };
}

function isUnconnectedDestination(destination: PragmaFlowDestination): boolean {
  return typeof destination === "object" && "goto" in destination && destination.goto === "";
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

export function normalizeConnectionDestination(
  flow: PragmaFlowResource,
  sourceId: string,
  destination: PragmaFlowDestination,
): PragmaFlowDestination {
  const target = destinationTarget(destination);
  if (target === null || !wouldCreateCycle(flow, sourceId, target)) return destination;
  const baseId = `loop_${sourceId}_${target}`.replace(/[^A-Za-z0-9_-]/g, "_");
  let loopId = baseId;
  let suffix = 2;
  while (
    flow.spec.graph.loops[loopId] !== undefined &&
    flow.spec.graph.loops[loopId]?.entry !== target
  ) {
    loopId = `${baseId}_${suffix}`;
    suffix += 1;
  }
  flow.spec.graph.loops[loopId] ??= {
    entry: target,
    maxIterations: 3,
    onLimit: { fail: `Loop ${loopId} reached its limit.` },
  };
  return { repeat: { loop: loopId, goto: target } };
}

function wouldCreateCycle(flow: PragmaFlowResource, sourceId: string, targetId: string): boolean {
  if (sourceId === targetId) return true;
  const seen = new Set<string>();
  const pending = [targetId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === sourceId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const transition = flow.spec.graph.transitions[current];
    if (transition === undefined) continue;
    for (const destination of transitionDestinations(transition)) {
      const next = destinationTarget(destination);
      if (next !== null) pending.push(next);
    }
  }
  return false;
}

function applyConnection(
  flow: PragmaFlowResource,
  connection: Connection,
  destination: PragmaFlowDestination,
): void {
  const canvasSource = connection.source;
  if (canvasSource === null) return;
  if (canvasSource === START_NODE_ID) {
    const target = destinationTarget(destination);
    if (target !== null) flow.spec.graph.start = target;
    return;
  }
  const routeSource = logicSourceId(canvasSource);
  const source = routeSource ?? canvasSource;
  if (flow.spec.graph.steps[source] === undefined) return;
  const current = flow.spec.graph.transitions[source];
  const handle = connection.sourceHandle ?? "default";
  let previous: PragmaFlowDestination | undefined;
  if (routeSource !== null && handle.startsWith("case:") && isRouteTransition(current)) {
    const caseName = handle.slice(5);
    previous = current.cases[caseName];
    current.cases[caseName] = destination;
  } else if (routeSource !== null && handle === "fallback" && isRouteTransition(current)) {
    previous = current.fallback;
    current.fallback = destination;
  } else {
    if (routeSource !== null) return;
    if (current !== undefined && !isRouteTransition(current)) {
      previous = current;
    }
    flow.spec.graph.transitions[source] = destination;
  }
  removeOrphanedLoop(flow, previous);
}

export function removeEdgeFromFlow(flow: PragmaFlowResource, edge: Edge): void {
  if (edge.id === "start-edge") {
    flow.spec.graph.start = "";
    return;
  }
  if (edge.id.endsWith(":logic-input")) {
    const route = flow.spec.graph.transitions[edge.source];
    if (!isRouteTransition(route)) return;
    delete flow.spec.graph.transitions[edge.source];
    for (const destination of transitionDestinations(route)) {
      removeOrphanedLoop(flow, destination);
    }
    return;
  }
  const routeSource = logicSourceId(edge.source);
  const source = routeSource ?? edge.source;
  const transition = flow.spec.graph.transitions[source];
  if (transition === undefined) return;
  let removed: PragmaFlowDestination | undefined;
  if (routeSource !== null && isRouteTransition(transition)) {
    if (edge.sourceHandle?.startsWith("case:")) {
      const caseName = edge.sourceHandle.slice(5);
      removed = transition.cases[caseName];
      transition.cases[caseName] = unconnectedDestination();
    } else if (edge.sourceHandle === "fallback") {
      removed = transition.fallback;
      transition.fallback = unconnectedDestination();
    }
  } else {
    if (isRouteTransition(transition)) return;
    removed = transition;
    delete flow.spec.graph.transitions[source];
  }
  removeOrphanedLoop(flow, removed);
}

function edgeDestination(flow: PragmaFlowResource, edge: Edge): PragmaFlowDestination | undefined {
  if (edge.id === "start-edge") {
    return flow.spec.graph.start === "" ? undefined : { goto: flow.spec.graph.start };
  }
  const routeSource = logicSourceId(edge.source);
  const source = routeSource ?? edge.source;
  const transition = flow.spec.graph.transitions[source];
  if (transition === undefined) return undefined;
  if (routeSource !== null && isRouteTransition(transition)) {
    if (edge.sourceHandle?.startsWith("case:")) {
      return transition.cases[edge.sourceHandle.slice(5)];
    }
    if (edge.sourceHandle === "fallback") return transition.fallback;
    return undefined;
  }
  return isRouteTransition(transition) ? undefined : transition;
}

function setEdgeDestination(
  flow: PragmaFlowResource,
  edge: Edge,
  destination: PragmaFlowDestination,
): void {
  const routeSource = logicSourceId(edge.source);
  const source = routeSource ?? edge.source;
  const transition = flow.spec.graph.transitions[source];
  if (routeSource !== null && isRouteTransition(transition)) {
    if (edge.sourceHandle?.startsWith("case:")) {
      transition.cases[edge.sourceHandle.slice(5)] = destination;
    } else if (edge.sourceHandle === "fallback") {
      transition.fallback = destination;
    }
    return;
  }
  if (!isRouteTransition(transition)) flow.spec.graph.transitions[source] = destination;
}

type FlowLimitTarget = NonNullable<PragmaFlowResource["spec"]["graph"]["loops"][string]["onLimit"]>;

function flowTargetSelectValue(target: FlowLimitTarget | undefined): string {
  if (target === undefined || (typeof target === "object" && "end" in target)) return "end";
  if (typeof target === "object" && "fail" in target) return "fail";
  return `goto:${typeof target === "string" ? target : target.goto}`;
}

function flowTargetFromSelect(value: string): FlowLimitTarget {
  if (value === "end") return { end: true };
  if (value === "fail") return { fail: "Loop reached its limit." };
  return { goto: value.slice("goto:".length) };
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
  selectedNodeId: string | null = null,
  logicDraftIds: readonly string[] = [],
): WorkflowCanvasNode[] {
  const automatic = automaticPositions(flow);
  const stepIds = Object.keys(flow.spec.graph.steps);
  const routeSourceIds = Object.entries(flow.spec.graph.transitions)
    .filter(([, transition]) => isRouteTransition(transition))
    .map(([sourceId]) => sourceId);
  const logicIds = routeSourceIds.map(logicNodeId);
  const canvasIds = [...stepIds, ...logicIds, ...logicDraftIds];
  const positions = Object.fromEntries(
    canvasIds.map((id, index) => [
      id,
      suppliedPositions[id] ??
        automatic[id] ?? {
          x: 280 + (index % 3) * (NODE_WIDTH + NODE_HORIZONTAL_GAP),
          y: 120 + Math.floor(index / 3) * (NODE_HEIGHT + NODE_VERTICAL_GAP),
        },
    ]),
  );
  const semantic = stepIds.map((id): StepCanvasNode => {
    const step = flow.spec.graph.steps[id]!;
    return {
      id,
      type: "step",
      position: positions[id]!,
      deletable: false,
      selected: id === selectedNodeId,
      data: {
        kind: flowStepKind(step),
        label: id,
        subtitle: flowStepTarget(step),
        outputs: [{ id: "default", label: "result" }],
        invalid: invalidStepIds.has(id),
      },
    };
  });
  const logicNodes: LogicCanvasNode[] = routeSourceIds.map((sourceId) => {
    const transition = flow.spec.graph.transitions[sourceId] as RouteTransition;
    const id = logicNodeId(sourceId);
    return {
      id,
      type: "logic",
      position: positions[id]!,
      deletable: false,
      selected: id === selectedNodeId,
      data: {
        sourceId,
        label: transition.route,
        fieldLabel: `${sourceId}.result.${transition.route}`,
        outputs: routeOutputs(flow, sourceId, transition),
        invalid: invalidStepIds.has(sourceId),
      },
    };
  });
  const draftNodes: LogicCanvasNode[] = logicDraftIds.map((id) => ({
    id,
    type: "logic",
    position: positions[id]!,
    deletable: false,
    selected: id === selectedNodeId,
    data: {
      sourceId: null,
      label: "Condition",
      fieldLabel: "Connect an upstream node",
      outputs: [],
      invalid: true,
    },
  }));
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
    ...logicNodes,
    ...draftNodes,
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
  const edges: Edge[] = [];
  if (flow.spec.graph.steps[flow.spec.graph.start] !== undefined) {
    edges.push({
      id: "start-edge",
      source: START_NODE_ID,
      sourceHandle: "start",
      target: flow.spec.graph.start,
      targetHandle: "target",
      type: "workflow",
      animated: true,
      deletable: true,
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  }
  for (const [source, transition] of Object.entries(flow.spec.graph.transitions)) {
    if (isRouteTransition(transition)) {
      const logicId = logicNodeId(source);
      edges.push({
        id: `${source}:logic-input`,
        source,
        sourceHandle: "default",
        target: logicId,
        targetHandle: "target",
        label: "result",
        type: "workflow",
        deletable: true,
        markerEnd: { type: MarkerType.ArrowClosed },
      });
      for (const [caseName, destination] of Object.entries(transition.cases)) {
        const edge = destinationEdge(logicId, `case:${caseName}`, destination, caseName);
        if (edge !== null) edges.push(edge);
      }
      if (transition.fallback !== undefined) {
        const edge = destinationEdge(logicId, "fallback", transition.fallback, "otherwise");
        if (edge !== null) edges.push(edge);
      }
    } else {
      const edge = destinationEdge(source, "default", transition, transitionMode(transition));
      if (edge !== null) edges.push(edge);
    }
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
): Edge | null {
  if (isUnconnectedDestination(destination)) return null;
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
    deletable: true,
    animated: repeat,
    ...(repeat ? { className: "is-repeat-edge" } : {}),
    markerEnd: { type: MarkerType.ArrowClosed },
  };
}

function automaticPositions(flow: PragmaFlowResource): Record<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", ranksep: 110, nodesep: 54, marginx: 20, marginy: 20 });
  for (const id of Object.keys(flow.spec.graph.steps))
    graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const [source, transition] of Object.entries(flow.spec.graph.transitions)) {
    const route = isRouteTransition(transition);
    const graphSource = route ? logicNodeId(source) : source;
    if (route) {
      graph.setNode(graphSource, { width: LOGIC_NODE_WIDTH, height: LOGIC_NODE_HEIGHT });
      graph.setEdge(source, graphSource);
    }
    const destinations = route
      ? [...Object.values(transition.cases), transition.fallback].filter(
          (value): value is PragmaFlowDestination => value !== undefined,
        )
      : [transition];
    for (const destination of destinations) {
      const target = destinationTarget(destination);
      if (target !== null && flow.spec.graph.steps[target] !== undefined)
        graph.setEdge(graphSource, target);
    }
  }
  dagre.layout(graph);
  return Object.fromEntries(
    [
      ...Object.keys(flow.spec.graph.steps),
      ...Object.keys(flow.spec.graph.transitions)
        .filter((id) => isRouteTransition(flow.spec.graph.transitions[id]))
        .map(logicNodeId),
    ].map((id) => {
      const position = graph.node(id) as { x: number; y: number };
      const logic = logicSourceId(id) !== null;
      return [
        id,
        {
          x: position.x - (logic ? LOGIC_NODE_WIDTH : NODE_WIDTH) / 2,
          y: position.y - (logic ? LOGIC_NODE_HEIGHT : NODE_HEIGHT) / 2,
        },
      ];
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
