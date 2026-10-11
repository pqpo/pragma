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
  readonly previewSource?: string;
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
              className={!props.preview ? "is-active" : ""}
              type="button"
              title={t("edit")}
              aria-label={t("edit")}
              aria-pressed={!props.preview}
              onClick={() => props.onPreviewChange(false)}
            >
              <PencilSimple size={17} />
            </button>
          )}
          {props.value === null ? null : (
            <button
              className={props.preview ? "is-active" : ""}
              type="button"
              title={t("preview")}
              aria-label={t("preview")}
              aria-pressed={props.preview}
              onClick={() => props.onPreviewChange(true)}
            >
              <Eye size={17} />
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
            <MarkdownContent source={props.previewSource ?? props.value} />
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
