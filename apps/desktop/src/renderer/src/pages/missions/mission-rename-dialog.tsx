import { useEffect, useRef, useState } from "react";
import { X } from "@phosphor-icons/react";
import { PRAGMA_TEXT_LIMITS, RenameMissionSchema } from "@pragma/shared";
import { useTranslation } from "react-i18next";
import { CharacterCount } from "../../components/CharacterCount.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { localizedMissionError } from "../../lib/mission-errors.ts";
import type { MissionSummary } from "../../../../shared/contracts/index.ts";

export function MissionRenameDialog(props: {
  readonly mission: Pick<MissionSummary, "id" | "title">;
  readonly onSave: (title: string) => Promise<void>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("missions");
  const [title, setTitle] = useState(props.mission.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, []);
  const valid = RenameMissionSchema.safeParse({ id: props.mission.id, title }).success;
  const changed = title.trim() !== props.mission.title;
  const save = async () => {
    if (!valid || !changed || savingRef.current) return;
    savingRef.current = true;
    inputRef.current?.focus();
    setBusy(true);
    setError(null);
    try {
      await props.onSave(title.trim());
      props.onClose();
    } catch (cause) {
      setError(localizedMissionError(cause, (key, options) => t(key, options ?? {})));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t("renameMission")}
      description={t("renameDescription")}
      className="mission-rename-dialog"
      busy={busy}
      onCancel={props.onClose}
      headerAction={
        <button
          type="button"
          className="mission-row-preview-edit"
          disabled={busy}
          aria-label={t("renameClose")}
          title={t("renameClose")}
          onClick={props.onClose}
        >
          <X size={16} aria-hidden="true" />
        </button>
      }
      footer={
        <>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={props.onClose}
          >
            {t("renameCancel")}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !valid || !changed}
            onClick={() => void save()}
          >
            {t(busy ? "renameSaving" : "renameSave")}
          </button>
        </>
      }
    >
      <label className="sr-only" htmlFor="mission-rename-title">
        {t("renameTitleLabel")}
      </label>
      <input
        id="mission-rename-title"
        className="mission-rename-input"
        data-dialog-initial-focus
        value={title}
        readOnly={busy}
        aria-describedby="mission-rename-help"
        aria-invalid={changed && !valid ? true : undefined}
        ref={inputRef}
        onChange={(event) => {
          setTitle(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            if (event.key === "Escape") event.stopPropagation();
            return;
          }
          if (event.key !== "Enter") return;
          event.preventDefault();
          void save();
        }}
      />
      <div className="mission-rename-help" id="mission-rename-help">
        <span>
          {changed && !valid ? t("renameInvalid", { max: PRAGMA_TEXT_LIMITS.mission.title }) : ""}
        </span>
        <CharacterCount value={title} max={PRAGMA_TEXT_LIMITS.mission.title} />
      </div>
      {error ? (
        <p className="mission-rename-error" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
