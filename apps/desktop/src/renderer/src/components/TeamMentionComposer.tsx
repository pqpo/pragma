import { createPortal } from "react-dom";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { formatExpertMentionToken, parseExpertMentionSegments } from "@pragma/shared";

import type { ExpertMentionCandidate } from "../../../shared/contracts/index.ts";
import { ExpertAvatar, expertAvatarSource } from "./ExpertAvatar.tsx";

interface ActiveMentionQuery {
  readonly range: Range;
  readonly query: string;
}

interface MentionMenuPosition {
  readonly left: number;
  readonly bottom: number;
  readonly width: number;
  readonly maxHeight: number;
}

export function TeamMentionComposer(props: {
  readonly value: string;
  readonly candidates: readonly ExpertMentionCandidate[];
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onPaste?: ((event: ReactClipboardEvent<HTMLDivElement>) => void) | undefined;
  readonly disabled?: boolean | undefined;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly menuLabel: string;
  readonly emptyLabel: string;
  readonly unavailableLabel: string;
  readonly inputRef?: ((element: HTMLDivElement | null) => void) | undefined;
  readonly autoFocus?: boolean | undefined;
  readonly variant: "home" | "mission";
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const queryRef = useRef<ActiveMentionQuery | null>(null);
  const escapeDismissedRef = useRef(false);
  const listboxId = `${useId().replaceAll(":", "")}-mentions`;
  const [query, setQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<MentionMenuPosition>({
    left: 12,
    bottom: 12,
    width: 240,
    maxHeight: 260,
  });
  const candidateByRef = useMemo(
    () => new Map(props.candidates.map((candidate) => [candidate.ref, candidate])),
    [props.candidates],
  );
  const visibleCandidates = useMemo(() => {
    if (query === null) return [];
    const term = query.toLocaleLowerCase();
    if (term === "") return props.candidates;
    return props.candidates.filter((candidate) =>
      `${candidate.name} ${candidate.description}`.toLocaleLowerCase().includes(term),
    );
  }, [props.candidates, query]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (editor === null || serializeMentionEditor(editor) === props.value) return;
    const focused = document.activeElement === editor;
    replaceMentionEditorContents(editor, props.value, candidateByRef, props.unavailableLabel);
    queryRef.current = null;
    setQuery(null);
    if (focused) placeCaretAtEnd(editor);
  }, [candidateByRef, props.unavailableLabel, props.value]);

  useLayoutEffect(() => {
    if (query === null) return;
    const reposition = () => {
      const editor = editorRef.current;
      if (editor !== null) setMenuPosition(resolveMentionMenuPosition(editor));
    };
    reposition();
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [query]);

  const assignRef = (element: HTMLDivElement | null) => {
    editorRef.current = element;
    props.inputRef?.(element);
  };

  const updateMentionQuery = () => {
    if (escapeDismissedRef.current) return;
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (
      editor === null ||
      selection === null ||
      selection.rangeCount === 0 ||
      !selection.isCollapsed ||
      !editor.contains(selection.anchorNode)
    ) {
      queryRef.current = null;
      setQuery(null);
      return;
    }
    const node = selection.anchorNode;
    if (node?.nodeType !== Node.TEXT_NODE) {
      queryRef.current = null;
      setQuery(null);
      return;
    }
    const beforeCaret = (node.textContent ?? "").slice(0, selection.anchorOffset);
    const match = findExpertMentionQuery(beforeCaret);
    if (match === undefined) {
      queryRef.current = null;
      setQuery(null);
      return;
    }
    const range = document.createRange();
    range.setStart(node, selection.anchorOffset - match.query.length - 1);
    range.setEnd(node, selection.anchorOffset);
    queryRef.current = { range: range.cloneRange(), query: match.query };
    setMenuPosition(resolveMentionMenuPosition(editor));
    setActiveIndex(0);
    setQuery(match.query);
  };

  const emitValue = () => {
    const editor = editorRef.current;
    if (editor === null) return;
    escapeDismissedRef.current = false;
    props.onChange(serializeMentionEditor(editor));
    updateMentionQuery();
  };

  const insertText = (text: string) => {
    const editor = editorRef.current;
    if (editor === null) return;
    const range = currentEditorRange(editor);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    setSelection(range);
    emitValue();
  };

  const chooseCandidate = (candidate: ExpertMentionCandidate) => {
    const editor = editorRef.current;
    const activeQuery = queryRef.current;
    if (editor === null || activeQuery === null) return;
    const range = activeQuery.range;
    range.deleteContents();
    const chip = createMentionChip(candidate, props.unavailableLabel);
    const trailing = document.createTextNode(" ");
    range.insertNode(trailing);
    range.insertNode(chip);
    range.setStart(trailing, trailing.data.length);
    range.collapse(true);
    setSelection(range);
    queryRef.current = null;
    escapeDismissedRef.current = false;
    setQuery(null);
    props.onChange(serializeMentionEditor(editor));
    requestAnimationFrame(() => editor.focus());
  };

  const removeAdjacentMention = (direction: "backward" | "forward"): boolean => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (editor === null || selection === null || !selection.isCollapsed) return false;
    const node = selection.anchorNode;
    const offset = selection.anchorOffset;
    const sibling =
      node === editor
        ? direction === "backward"
          ? editor.childNodes[offset - 1]
          : editor.childNodes[offset]
        : node?.nodeType === Node.TEXT_NODE
          ? direction === "backward" && offset === 0
            ? previousMeaningfulSibling(node)
            : direction === "forward" && offset === (node.textContent ?? "").length
              ? nextMeaningfulSibling(node)
              : null
          : null;
    if (!(sibling instanceof HTMLElement) || sibling.dataset.expertMention === undefined)
      return false;
    const range = document.createRange();
    range.setStartBefore(sibling);
    range.collapse(true);
    sibling.remove();
    setSelection(range);
    props.onChange(serializeMentionEditor(editor));
    return true;
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (query !== null) {
      if (event.key === "Escape") {
        event.preventDefault();
        queryRef.current = null;
        escapeDismissedRef.current = true;
        setQuery(null);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const length = Math.max(visibleCandidates.length, 1);
        setActiveIndex((current) => (current + direction + length) % length);
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && visibleCandidates[activeIndex]) {
        event.preventDefault();
        chooseCandidate(visibleCandidates[activeIndex]!);
        return;
      }
    }
    if (event.key === "Backspace" && removeAdjacentMention("backward")) {
      event.preventDefault();
      return;
    }
    if (event.key === "Delete" && removeAdjacentMention("forward")) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.shiftKey) insertText("\n");
      else if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229)
        props.onSubmit();
    }
  };

  const copySelection = (event: ReactClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (
      editor === null ||
      selection === null ||
      selection.rangeCount === 0 ||
      !editor.contains(selection.getRangeAt(0).commonAncestorContainer)
    )
      return;
    event.preventDefault();
    const range = selection.getRangeAt(0);
    const fragment = range.cloneContents();
    event.clipboardData.setData("text/plain", serializeMentionNodes(fragment.childNodes));
    if (cut) {
      range.deleteContents();
      props.onChange(serializeMentionEditor(editor));
      updateMentionQuery();
    }
  };

  const menu =
    query === null
      ? null
      : createPortal(
          <div
            className="team-mention-menu"
            id={listboxId}
            role="listbox"
            aria-label={props.menuLabel}
            style={{
              left: menuPosition.left,
              bottom: menuPosition.bottom,
              width: menuPosition.width,
              maxHeight: menuPosition.maxHeight,
            }}
          >
            {visibleCandidates.length === 0 ? (
              <p>{props.emptyLabel}</p>
            ) : (
              visibleCandidates.map((candidate, index) => (
                <button
                  id={`${listboxId}-${candidate.ref}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  className={index === activeIndex ? "is-active" : undefined}
                  key={candidate.ref}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => chooseCandidate(candidate)}
                >
                  <ExpertAvatar avatarId={candidate.avatarId} size="xs" />
                  <strong>@{candidate.name}</strong>
                  {candidate.description === "" ? null : <small>{candidate.description}</small>}
                </button>
              ))
            )}
          </div>,
          document.body,
        );

  return (
    <>
      <div
        ref={assignRef}
        className={`team-mention-editor is-${props.variant}`}
        contentEditable={!props.disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={props.ariaLabel}
        aria-expanded={query !== null}
        aria-controls={query === null ? undefined : listboxId}
        aria-activedescendant={
          query === null || visibleCandidates[activeIndex] === undefined
            ? undefined
            : `${listboxId}-${visibleCandidates[activeIndex]!.ref}`
        }
        data-placeholder={props.placeholder}
        data-empty={props.value === "" ? "true" : "false"}
        data-disabled={props.disabled ? "true" : "false"}
        autoFocus={props.autoFocus}
        onInput={emitValue}
        onMouseUp={() => {
          escapeDismissedRef.current = false;
          updateMentionQuery();
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          queryRef.current = null;
          escapeDismissedRef.current = false;
          setQuery(null);
        }}
        onPaste={(event) => {
          props.onPaste?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          insertText(event.clipboardData.getData("text/plain"));
        }}
        onCopy={(event) => copySelection(event, false)}
        onCut={(event) => copySelection(event, true)}
      />
      {menu}
    </>
  );
}

function resolveMentionMenuPosition(editor: HTMLElement): MentionMenuPosition {
  const anchor =
    editor.closest<HTMLElement>(".mission-chat-composer-shell") ??
    editor.closest<HTMLElement>(".mission-goal-composer, .mission-chat-composer") ??
    editor;
  const anchorRect = anchor.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 8;
  const availableWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
  const width = Math.min(anchorRect.width, availableWidth);
  const left = Math.max(
    viewportPadding,
    Math.min(anchorRect.left, window.innerWidth - width - viewportPadding),
  );
  return {
    left,
    bottom: Math.max(viewportPadding, window.innerHeight - anchorRect.top + gap),
    width,
    maxHeight: Math.max(48, Math.min(260, anchorRect.top - gap - viewportPadding)),
  };
}

export function findExpertMentionQuery(
  textBeforeCaret: string,
): { readonly start: number; readonly query: string } | undefined {
  const match = /(^|\s)@([^\s@]*)$/u.exec(textBeforeCaret);
  if (match === null) return undefined;
  return {
    start: textBeforeCaret.length - match[2]!.length - 1,
    query: match[2]!,
  };
}

function replaceMentionEditorContents(
  editor: HTMLElement,
  value: string,
  candidates: ReadonlyMap<string, ExpertMentionCandidate>,
  unavailableLabel: string,
): void {
  editor.replaceChildren(
    ...parseExpertMentionSegments(value).map((segment) =>
      segment.kind === "text"
        ? document.createTextNode(segment.text)
        : createMentionChip(candidates.get(segment.ref), unavailableLabel, segment.ref),
    ),
  );
}

function createMentionChip(
  candidate: ExpertMentionCandidate | undefined,
  unavailableLabel: string,
  fallbackRef?: string,
): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "team-mention-chip";
  chip.contentEditable = "false";
  chip.dataset.expertMention = candidate?.ref ?? fallbackRef;
  chip.setAttribute("aria-label", `@${candidate?.name ?? unavailableLabel}`);

  const avatar = document.createElement("span");
  avatar.className = "pragma-avatar pragma-avatar-xs";
  avatar.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.src = expertAvatarSource(candidate?.avatarId);
  image.alt = "";
  avatar.append(image);

  const label = document.createElement("span");
  label.textContent = `@${candidate?.name ?? unavailableLabel}`;
  chip.append(avatar, label);
  return chip;
}

function serializeMentionEditor(editor: HTMLElement): string {
  return serializeMentionNodes(editor.childNodes);
}

function serializeMentionNodes(nodes: Iterable<Node>): string {
  let value = "";
  for (const node of nodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? "";
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;
    const ref = node.dataset.expertMention;
    if (ref !== undefined) {
      try {
        value += formatExpertMentionToken(ref);
      } catch {
        // Invalid DOM metadata is ignored instead of leaking a raw resource ID.
      }
    } else if (node.tagName === "BR") value += "\n";
    else value += serializeMentionNodes(node.childNodes);
  }
  return value;
}

function currentEditorRange(editor: HTMLElement): Range {
  const selection = window.getSelection();
  if (
    selection !== null &&
    selection.rangeCount > 0 &&
    editor.contains(selection.getRangeAt(0).commonAncestorContainer)
  )
    return selection.getRangeAt(0).cloneRange();
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  return range;
}

function placeCaretAtEnd(editor: HTMLElement): void {
  editor.focus();
  setSelection(currentEditorRange(editor));
}

function setSelection(range: Range): void {
  const selection = window.getSelection();
  if (selection === null) return;
  selection.removeAllRanges();
  selection.addRange(range);
}

function previousMeaningfulSibling(node: Node): ChildNode | null {
  let sibling = node.previousSibling;
  while (sibling?.nodeType === Node.TEXT_NODE && sibling.textContent === "")
    sibling = sibling.previousSibling;
  return sibling;
}

function nextMeaningfulSibling(node: Node): ChildNode | null {
  let sibling = node.nextSibling;
  while (sibling?.nodeType === Node.TEXT_NODE && sibling.textContent === "")
    sibling = sibling.nextSibling;
  return sibling;
}
