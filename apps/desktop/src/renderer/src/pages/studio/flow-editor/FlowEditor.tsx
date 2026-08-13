import {
  ArrowLeft,
  ArrowsOut,
  CheckCircle,
  CirclesFour,
  DiamondsFour,
  GitBranch,
  Hand,
  Path,
  Plus,
  Robot,
  Trash,
  UserFocus,
  UsersThree,
} from "@phosphor-icons/react";
import type { PragmaFlowResource, PragmaResource } from "@pragma/interpreter/ast";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  MarkerType,
  type Connection,
  type Edge,
  type OnMoveEnd,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DesktopRuntimeAvailability,
  PragmaProjectSnapshot,
} from "../../../../../shared/contracts/index.ts";
import { ConfirmationDialog } from "../../../components/Dialog.tsx";
import { errorMessage } from "../../../lib/errors.ts";
import { desktopApi } from "../studio-model.ts";
import {
  createEmptyFlow,
  deleteFlowStep,
  isFlowStepKind,
  renameFlowStep,
  validateFlowDraft,
  type FlowValidationIssue,
  type FlowStepKind,
} from "./flow-model.ts";
import { edgeTypes, nodeTypes, PaletteItem } from "./flow-canvas-components.tsx";
import {
  applyConnection,
  automaticPositions,
  buildCanvasEdges,
  buildCanvasNodes,
  canvasNodeExists,
  canvasPositions,
  connectionDestination,
  createRouteTransition,
  defaultStep,
  inspectorNodeId,
  isRouteTransition,
  logicNodeId,
  logicSourceId,
  nextAvailableNodePosition,
  nextFlowResourceId,
  nextStepId,
  normalizeConnectionDestination,
  rebuildCanvasNodesPreservingSelection,
  removeEdgeFromFlow,
  removeOrphanedLoop,
  resourceTargets,
  routeFieldOptions,
  transitionDestinations,
  type FlowExpertOption,
} from "./flow-canvas-model.ts";
import {
  END_NODE_ID,
  FAIL_NODE_ID,
  LOGIC_DRAFT_PREFIX,
  LOGIC_NODE_HEIGHT,
  LOGIC_NODE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  START_NODE_ID,
  type WorkflowCanvasNode,
} from "./flow-canvas-types.ts";
import { mergePragmaResources, validateFlowRuntimeSelections } from "./flow-editor-fields.tsx";
import {
  EdgeInspector,
  EndInspector,
  FlowSettings,
  LogicInspector,
  StepInspector,
} from "./flow-inspectors.tsx";

export const FLOW_ERROR_AUTO_DISMISS_MS = 5_000;

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

export function FlowEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly expertOptions?: readonly FlowExpertOption[] | undefined;
  readonly baseRevision?: number | undefined;
  readonly mode?: "create" | "edit" | undefined;
  readonly runtimes?: readonly DesktopRuntimeAvailability[] | undefined;
  readonly initial?: PragmaFlowResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (
    resource: PragmaFlowResource,
    supportingResources: readonly PragmaResource[],
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
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
  readonly expertOptions?: readonly FlowExpertOption[] | undefined;
  readonly baseRevision?: number | undefined;
  readonly mode?: "create" | "edit" | undefined;
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly initial?: PragmaFlowResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (
    resource: PragmaFlowResource,
    supportingResources: readonly PragmaResource[],
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation("studio");
  const initialFlow = useMemo(
    () => props.initial ?? createEmptyFlow(nextFlowResourceId(props.project.resources)),
    [props.initial, props.project.resources],
  );
  const baselineRef = useRef(JSON.stringify(initialFlow));
  const expectedRevisionRef = useRef(props.baseRevision ?? props.project.revision);
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
  const [pendingLogicSourceId, setPendingLogicSourceId] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
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
      ...validateFlowDraft(flow, editorResources),
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
    () => resourceTargets(props.project.resources, flow.metadata.id, props.expertOptions ?? []),
    [flow.metadata.id, props.expertOptions, props.project.resources],
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
          schemaVersion: "pragma.desktop-flow-layout/v2",
          projectId: props.project.projectId,
          flowId: flow.metadata.id,
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
      return rebuildCanvasNodesPreservingSelection(flow, current, invalidStepIds, logicDraftIds);
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
      optionLabels: [
        t("humanDefaultOption", { number: 1 }),
        t("humanDefaultOption", { number: 2 }),
      ],
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
    setPendingLogicSourceId(sourceId);
    setNodeContextMenu(null);
  };

  const confirmRemoveLogicNode = () => {
    const sourceId = pendingLogicSourceId;
    if (sourceId === null || !isRouteTransition(flow.spec.graph.transitions[sourceId])) {
      setPendingLogicSourceId(null);
      return;
    }
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
    setPendingLogicSourceId(null);
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
        baseRevision: expectedRevisionRef.current,
        upserts: [...supportingResources, flow],
        removals: [],
        requiredUnchangedRefs: [],
      });
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) {
        setCandidateIssues(errors.map((diagnostic) => diagnostic.message));
        setValidationOpen(true);
        return;
      }
      if (!(await props.onSave(flow, supportingResources, expectedRevisionRef.current, []))) return;
      baselineRef.current = JSON.stringify(flow);
      if (await persistLayout(true)) props.onCancel();
    } catch (cause) {
      showError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleBack = () => {
    if (semanticDirty || layoutStatus === "unsaved") {
      setDiscardOpen(true);
      return;
    }
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
              setSelectedNodeId(inspectorNodeId(selectedNode));
            }}
            onNodeClick={(_event, node) => {
              setNodeContextMenu(null);
              setSelectedEdgeId(null);
              const nextSelectedNodeId = inspectorNodeId(node);
              if (nextSelectedNodeId !== null) {
                setSelectedNodeId(nextSelectedNodeId);
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
              <FlowSettings
                flow={flow}
                onPatch={patchFlow}
                showMemoryPolicy={props.mode === "edit" && props.initial !== undefined}
              />
            ) : selectedNodeId === END_NODE_ID ? (
              <EndInspector flow={flow} onPatch={patchFlow} />
            ) : selectedNodeId === START_NODE_ID || selectedNodeId === FAIL_NODE_ID ? (
              <FlowSettings
                flow={flow}
                onPatch={patchFlow}
                showMemoryPolicy={props.mode === "edit" && props.initial !== undefined}
              />
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
      {pendingLogicSourceId !== null ? (
        <ConfirmationDialog
          title={t("deleteNode")}
          description={t("deleteLogicNodeConfirm")}
          confirmLabel={t("deleteNode")}
          cancelLabel={t("cancel")}
          busyLabel={t("deleteNode")}
          busy={false}
          tone="danger"
          onCancel={() => setPendingLogicSourceId(null)}
          onConfirm={confirmRemoveLogicNode}
        />
      ) : null}
      {discardOpen ? (
        <ConfirmationDialog
          title={t("backFlows")}
          description={t("discardFlowChanges")}
          confirmLabel={t("backFlows")}
          cancelLabel={t("cancel")}
          busyLabel={t("backFlows")}
          busy={false}
          tone="danger"
          onCancel={() => setDiscardOpen(false)}
          onConfirm={props.onCancel}
        />
      ) : null}
    </section>
  );
}
