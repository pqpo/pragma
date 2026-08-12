import { useCallback, useEffect, useRef, useState } from "react";
import {
  File as FileIcon,
  FolderOpen,
  ImageSquare,
  Plus,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import type { ExpertPromptAttachment, ExpertPromptAttachmentKind } from "@pragma/shared";
import { useTranslation } from "react-i18next";

import { missionAttachmentDraftOriginalUrl } from "../../../shared/contracts/index.ts";
import { Dialog } from "./Dialog.tsx";

export function MissionAttachmentPicker(props: {
  readonly disabled: boolean;
  readonly compact?: boolean | undefined;
  readonly onPick: (kind: ExpertPromptAttachmentKind) => void | Promise<void>;
}) {
  const { t } = useTranslation("missions");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return;
      close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, open]);

  const choose = (kind: ExpertPromptAttachmentKind) => {
    setOpen(false);
    void props.onPick(kind);
  };

  return (
    <div
      className={[
        "mission-attachment-picker",
        open ? "is-open" : "",
        props.compact ? "is-compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={rootRef}
    >
      <button
        className="mission-attachment-trigger"
        type="button"
        aria-label={t("addAttachment")}
        aria-expanded={open}
        aria-haspopup="menu"
        title={props.disabled ? t("attachmentUnavailableForFlow") : t("addAttachment")}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <Plus size={props.compact ? 18 : 20} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mission-attachment-menu" role="menu" aria-label={t("addAttachment")}>
          <button type="button" role="menuitem" onClick={() => choose("image")}>
            <ImageSquare size={18} aria-hidden="true" />
            <span>{t("attachImage")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose("file")}>
            <FileIcon size={18} aria-hidden="true" />
            <span>{t("attachFile")}</span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose("directory")}>
            <FolderOpen size={18} aria-hidden="true" />
            <span>{t("attachFolder")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function MissionAttachmentList(props: {
  readonly attachments: readonly ExpertPromptAttachment[];
  readonly previews?: Readonly<Record<string, string>> | undefined;
  readonly imageUnsupported?: boolean | undefined;
  readonly originalUrl?: ((attachment: ExpertPromptAttachment) => string) | undefined;
  readonly onRemove: (id: string) => void;
}) {
  const { t } = useTranslation("missions");
  const [previewing, setPreviewing] = useState<ExpertPromptAttachment>();
  const [previewFailed, setPreviewFailed] = useState(false);
  const closePreview = () => {
    setPreviewing(undefined);
    setPreviewFailed(false);
  };
  return (
    <>
      <div
        className={
          props.attachments.length === 0
            ? "mission-attachment-list is-empty"
            : props.attachments.some((attachment) => attachment.kind === "image")
              ? "mission-attachment-list has-images"
              : "mission-attachment-list"
        }
        aria-label={props.attachments.length === 0 ? undefined : t("attachedContext")}
      >
        {props.attachments.map((attachment) => {
          if (attachment.kind === "image") {
            const preview = props.previews?.[attachment.id];
            return (
              <figure className="mission-attachment-image-card" key={attachment.id}>
                <button
                  className="mission-attachment-thumbnail"
                  type="button"
                  aria-label={t("viewOriginalImage", { name: attachment.name })}
                  onClick={() => {
                    setPreviewFailed(false);
                    setPreviewing(attachment);
                  }}
                >
                  {preview === undefined ? (
                    <ImageSquare size={28} aria-hidden="true" />
                  ) : (
                    <img src={preview} alt={t("attachmentPreviewAlt", { name: attachment.name })} />
                  )}
                </button>
                <figcaption title={attachment.name}>{attachment.name}</figcaption>
                <button
                  className="mission-attachment-image-remove"
                  type="button"
                  aria-label={t("removeAttachment", { name: attachment.name })}
                  onClick={() => props.onRemove(attachment.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
                {props.imageUnsupported ? (
                  <small className="mission-attachment-model-error">
                    <WarningCircle size={13} aria-hidden="true" />
                    {t("imageUnsupportedByModel")}
                  </small>
                ) : null}
              </figure>
            );
          }
          const AttachmentIcon = attachment.kind === "directory" ? FolderOpen : FileIcon;
          return (
            <span className="mission-attachment-chip" key={attachment.id} title={attachment.path}>
              <AttachmentIcon size={16} aria-hidden="true" />
              <span>{attachment.name}</span>
              <button
                type="button"
                aria-label={t("removeAttachment", { name: attachment.name })}
                onClick={() => props.onRemove(attachment.id)}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          );
        })}
      </div>
      {previewing === undefined ? null : (
        <Dialog
          className="mission-original-image-dialog"
          title={previewing.name}
          description={t("originalImageDescription")}
          onCancel={closePreview}
          footer={
            <button className="secondary-button" type="button" onClick={closePreview}>
              {t("closeImagePreview")}
            </button>
          }
        >
          {previewFailed ? (
            <p className="form-error" role="alert">
              {t("originalImageUnavailable")}
            </p>
          ) : (
            <img
              className="mission-original-image"
              src={
                props.originalUrl?.(previewing) ?? missionAttachmentDraftOriginalUrl(previewing.id)
              }
              alt={t("originalImageAlt", { name: previewing.name })}
              onError={() => setPreviewFailed(true)}
            />
          )}
        </Dialog>
      )}
    </>
  );
}
