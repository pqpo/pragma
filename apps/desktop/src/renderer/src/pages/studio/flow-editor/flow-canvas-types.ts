import type { Node } from "@xyflow/react";

import type { FlowStepKind } from "./flow-model.ts";

export const START_NODE_ID = "__pragma_canvas_start__";
export const END_NODE_ID = "__pragma_canvas_end__";
export const FAIL_NODE_ID = "__pragma_canvas_fail__";
export const LOGIC_NODE_PREFIX = "__pragma_canvas_logic__";
export const LOGIC_DRAFT_PREFIX = "__pragma_canvas_logic_draft__";

export const NODE_WIDTH = 238;
export const NODE_HEIGHT = 104;
export const LOGIC_NODE_WIDTH = 210;
export const LOGIC_NODE_HEIGHT = 112;
export const TERMINAL_NODE_WIDTH = 112;
export const TERMINAL_HORIZONTAL_GAP = 180;
export const NODE_HORIZONTAL_GAP = 36;
export const NODE_VERTICAL_GAP = 28;

export interface StepNodeData extends Record<string, unknown> {
  readonly kind: FlowStepKind;
  readonly label: string;
  readonly subtitle: string;
  readonly outputs: readonly { readonly id: string; readonly label: string }[];
  readonly invalid: boolean;
}

export interface TerminalNodeData extends Record<string, unknown> {
  readonly label: string;
  readonly tone: "start" | "end" | "fail";
}

export interface LogicNodeData extends Record<string, unknown> {
  readonly sourceId: string | null;
  readonly label: string;
  readonly fieldLabel: string;
  readonly outputs: readonly { readonly id: string; readonly label: string }[];
  readonly invalid: boolean;
}

export type StepCanvasNode = Node<StepNodeData, "step">;
export type LogicCanvasNode = Node<LogicNodeData, "logic">;
export type TerminalCanvasNode = Node<TerminalNodeData, "terminal">;
export type WorkflowCanvasNode = StepCanvasNode | LogicCanvasNode | TerminalCanvasNode;
export type FlowPaletteKind = FlowStepKind | "logic";
