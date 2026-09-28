import { ArrowUp, ArrowDown, MagnifyingGlass, Check } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Compartment, EditorState, StateEffect } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  closeSearchPanel,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import {
  acceptChunk,
  getChunks,
  getOriginalDoc,
  goToNextChunk,
  goToPreviousChunk,
  unifiedMergeView,
  updateOriginalDoc,
} from "@codemirror/merge";

export default function AssetGitMergeEditor(props: {
  readonly documentKey: string;
  readonly initialContent: string;
  readonly original?: string | undefined;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly states: Map<string, EditorState>;
  readonly onChange: (content: string, remaining: number, edited: boolean) => void;
}) {
  const { t } = useTranslation("studio");
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const editable = useRef(new Compartment());
  const [remaining, setRemaining] = useState(0);
  const merging = props.original !== undefined;
  const stateKey = props.documentKey;
  useEffect(() => {
    if (!host.current) return;
    const { initialContent, original: initialOriginal, readOnly, busy, states } = callbacks.current;
    const saved = states.get(stateKey);
    const original =
      saved && initialOriginal !== undefined ? getOriginalDoc(saved).toString() : initialOriginal;
    const report = (view: EditorView, edited: boolean) => {
      const count = getChunks(view.state)?.chunks.length ?? 0;
      setRemaining(count);
      callbacks.current.onChange(view.state.doc.toString(), count, edited);
    };
    const extensions = [
      lineNumbers(),
      EditorState.phrases.of(
        t("assetGit.editorPhrases", { returnObjects: true }) as Record<string, string>,
      ),
      history(),
      search(),
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ "aria-label": t("assetGit.result"), spellcheck: "false" }),
      editable.current.of([
        EditorState.readOnly.of(readOnly || busy),
        EditorView.editable.of(!readOnly && !busy),
      ]),
      EditorView.updateListener.of((update) => {
        if (
          update.docChanged ||
          update.transactions.some((transaction) =>
            transaction.effects.some((effect) => effect.is(updateOriginalDoc)),
          )
        )
          report(update.view, true);
      }),
      ...(original === undefined
        ? []
        : unifiedMergeView({
            original,
            collapseUnchanged: { margin: 3, minSize: 4 },
            syntaxHighlightDeletions: false,
            diffConfig: { scanLimit: 500, timeout: 100 },
            mergeControls: (type, action) => {
              const button = document.createElement("button");
              button.type = "button";
              button.className = "text-button";
              button.dataset.mergeChoice = type;
              button.textContent = t(
                type === "accept" ? "assetGit.keepLocal" : "assetGit.useRemote",
              );
              button.disabled = busy;
              button.addEventListener("click", (event) => {
                if (!callbacks.current.busy) action(event);
              });
              if (type === "accept") {
                const group = document.createElement("span");
                group.className = "asset-git-chunk-choice";
                const label = document.createElement("span");
                label.className = "asset-git-chunk-label";
                label.textContent = t("assetGit.chunkLabel");
                group.append(label, button);
                return group;
              }
              return button;
            },
          })),
    ];
    const view = new EditorView({
      parent: host.current,
      state: saved
        ? saved.update({ effects: StateEffect.reconfigure.of(extensions) }).state
        : EditorState.create({ doc: initialContent, extensions }),
    });
    viewRef.current = view;
    report(view, false);
    return () => {
      states.set(stateKey, view.state);
      viewRef.current = null;
      view.destroy();
    };
    // Rebind UI callbacks on restore while retaining the accepted original and undo history.
  }, [stateKey, t]);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editable.current.reconfigure([
        EditorState.readOnly.of(props.readOnly || props.busy),
        EditorView.editable.of(!props.readOnly && !props.busy),
      ]),
    });
    for (const button of view.dom.querySelectorAll<HTMLButtonElement>("button[data-merge-choice]"))
      button.disabled = props.busy;
  }, [props.busy, props.readOnly, props.documentKey]);
  const navigate = (direction: "next" | "previous") => {
    const view = viewRef.current;
    if (!view) return;
    (direction === "next" ? goToNextChunk : goToPreviousChunk)(view);
    view.focus();
  };
  return (
    <div className="asset-git-editor-workspace">
      <div className="asset-git-editor-toolbar">
        {merging ? (
          <>
            <span role="status">{t("assetGit.remaining", { count: remaining })}</span>
            <button
              type="button"
              className="text-button asset-git-icon-button"
              aria-label={t("assetGit.previous")}
              title={t("assetGit.previous")}
              disabled={props.busy || remaining === 0}
              onClick={() => navigate("previous")}
            >
              <ArrowUp size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="text-button asset-git-icon-button"
              aria-label={t("assetGit.next")}
              title={t("assetGit.next")}
              disabled={props.busy || remaining === 0}
              onClick={() => navigate("next")}
            >
              <ArrowDown size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="text-button asset-git-mark-resolved"
              disabled={props.busy}
              onClick={() => {
                const view = viewRef.current;
                if (!view) return;
                for (
                  let chunk = getChunks(view.state)?.chunks[0];
                  chunk;
                  chunk = getChunks(view.state)?.chunks[0]
                ) {
                  if (!acceptChunk(view, chunk.fromB)) break;
                }
                callbacks.current.onChange(
                  view.state.doc.toString(),
                  getChunks(view.state)?.chunks.length ?? 0,
                  true,
                );
              }}
            >
              <Check size={16} aria-hidden="true" />
              {t("assetGit.confirmResult")}
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="text-button asset-git-icon-button"
          aria-label={t("assetGit.search")}
          title={t("assetGit.search")}
          disabled={props.busy}
          onClick={() => {
            if (viewRef.current) openSearchPanel(viewRef.current);
          }}
        >
          <MagnifyingGlass size={16} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={host}
        className="asset-git-code-editor"
        onKeyDownCapture={(event) => {
          const view = viewRef.current;
          if (event.key === "Escape" && view && searchPanelOpen(view.state)) {
            closeSearchPanel(view);
            event.preventDefault();
            event.stopPropagation();
            view.focus();
          }
        }}
      />
    </div>
  );
}
