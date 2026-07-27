import {
  CheckCircle,
  DiamondsFour,
  GitBranch,
  Plus,
  Robot,
  Sparkle,
  Trash,
  UserFocus,
  UsersThree,
} from "@phosphor-icons/react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  useReactFlow,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type {
  FlowPaletteKind,
  LogicCanvasNode,
  StepCanvasNode,
  TerminalCanvasNode,
} from "./flow-canvas-types.ts";

export function PaletteItem(props: {
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

export const nodeTypes = { step: StepNode, logic: LogicNode, terminal: TerminalNode };

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

export const edgeTypes = { workflow: WorkflowEdge };
