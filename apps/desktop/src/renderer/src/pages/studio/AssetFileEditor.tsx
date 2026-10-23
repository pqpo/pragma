import { Eye, PencilSimple } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";

export function AssetFileEditor(props: {
  readonly path: string;
  readonly value: string | null;
  readonly preview: boolean;
  readonly readOnly?: boolean;
  readonly disabled?: boolean;
  readonly onPreviewChange: (preview: boolean) => void;
  readonly onChange: (value: string) => void;
  readonly status?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly previewSource?: string | undefined;
}) {
  const { t } = useTranslation("studio");
  const isMarkdown = /\.md$/iu.test(props.path);
  return (
    <>
      <header className="knowledge-editor-toolbar">
        <div>
          <strong>{props.path}</strong>
          {props.status}
        </div>
        <div>
          {props.readOnly || props.value === null ? null : (
            <button
              type="button"
              title={props.preview ? t("edit") : t("preview")}
              aria-label={props.preview ? t("edit") : t("preview")}
              disabled={props.disabled}
              onClick={() => props.onPreviewChange(!props.preview)}
            >
              {props.preview ? (
                <PencilSimple size={17} aria-hidden="true" />
              ) : (
                <Eye size={17} aria-hidden="true" />
              )}
            </button>
          )}
          {props.actions}
        </div>
      </header>
      {props.children}
      {props.value === null ? (
        <p className="capability-empty">{t("binaryFilePreviewUnavailable")}</p>
      ) : props.preview || props.readOnly ? (
        <div className="knowledge-markdown-preview">
          {isMarkdown ? (
            <article className="asset-markdown-document">
              <MarkdownContent source={props.previewSource ?? props.value} codeBlockControls />
            </article>
          ) : (
            <pre className="asset-file-text-preview">{props.value}</pre>
          )}
        </div>
      ) : (
        <textarea
          className="knowledge-markdown-editor"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          disabled={props.disabled}
          spellCheck={false}
          aria-label={isMarkdown ? t("markdownContent") : t("fileContent")}
        />
      )}
    </>
  );
}
