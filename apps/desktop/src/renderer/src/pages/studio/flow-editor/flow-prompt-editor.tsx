import { Code, X } from "@phosphor-icons/react";
import type {
  PragmaFlowPrompt,
  PragmaFlowVariable,
  PragmaFlowResource,
} from "@pragma/interpreter/ast";
import { analyzePragmaFlowNodeAvailability } from "@pragma/interpreter/ast";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";

import { stepOutputSchema } from "./flow-canvas-model.ts";

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
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
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
      <span id={promptLabelId}>{props.label ?? t("flowPrompt")}</span>
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
          data-placeholder={props.placeholder ?? t("flowPromptPlaceholder")}
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
  return promptSegmentsFromEditorNodes(editor.childNodes);
}

export function promptSegmentsFromEditorNodes(
  nodes: Iterable<globalThis.Node>,
): PragmaFlowPrompt["segments"] {
  const segments: PragmaFlowPrompt["segments"] = [];
  for (const node of nodes) appendPromptEditorNode(segments, node);
  return normalizePromptSegments(segments);
}

function appendPromptEditorNode(
  segments: PragmaFlowPrompt["segments"],
  node: globalThis.Node,
): void {
  if (node.nodeType === 1) {
    const encodedVariable = (node as HTMLElement).dataset.flowVariable;
    if (encodedVariable !== undefined) {
      const variable = decodeFlowVariable(encodedVariable);
      if (variable !== undefined) segments.push({ variable });
      return;
    }
    for (const child of node.childNodes) appendPromptEditorNode(segments, child);
    return;
  }
  if (node.nodeType !== 3) return;
  const text = node.textContent ?? "";
  if (text !== "") segments.push({ text });
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
    for (const path of objectSchemaPaths(stepOutputSchema(step))) {
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
