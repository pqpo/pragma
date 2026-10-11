import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopTerminalIntegration } from "../../../../shared/contracts/terminal-integration.ts";
import { ConfirmationDialog } from "../../components/Dialog.tsx";

export function TerminalIntegrationSettings() {
  const { t } = useTranslation(["settings", "common"]);
  const [snapshot, setSnapshot] = useState<DesktopTerminalIntegration>();
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let changed = false;
    const unsubscribe = window.pragmaDesktop.subscribeTerminalIntegration((snapshot) => {
      changed = true;
      setSnapshot(snapshot);
    });
    void window.pragmaDesktop
      .inspectTerminalIntegration()
      .then((value) => {
        if (!cancelled && !changed) setSnapshot(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled && !changed) setError(String(cause));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  const change = async (action: "repair" | "remove") => {
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(
        await (action === "repair"
          ? window.pragmaDesktop.repairTerminalIntegration()
          : window.pragmaDesktop.removeTerminalIntegration()),
      );
      setConfirmRemove(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting-row terminal-integration-setting">
      <span className="setting-copy">
        <strong>{t("terminal.title")}</strong>
        <span>{t("terminal.description")}</span>
        <small role="status">
          {t(`terminal.${snapshot?.status ?? "loading"}`)}
          {snapshot?.cliVersion ? ` · CLI ${snapshot.cliVersion}` : ""}
        </small>
        <small>{t("terminal.restart")}</small>
        {snapshot?.commandDirectory ? <code>{snapshot.commandDirectory}</code> : null}
        {error || snapshot?.error ? <small role="alert">{error ?? snapshot?.error}</small> : null}
      </span>
      <span className="terminal-integration-actions">
        <button
          className="secondary-button"
          disabled={busy || !snapshot || snapshot.status === "unavailable"}
          onClick={() => void change("repair")}
        >
          {t("terminal.repair")}
        </button>
        <button
          className="text-button"
          disabled={
            busy || !snapshot || snapshot.status === "unavailable" || snapshot.status === "removed"
          }
          onClick={() => setConfirmRemove(true)}
        >
          {t("terminal.remove")}
        </button>
      </span>
      {confirmRemove ? (
        <ConfirmationDialog
          title={t("terminal.remove")}
          description={t("terminal.removeDescription")}
          cancelLabel={t("actions.cancel", { ns: "common" })}
          confirmLabel={t("terminal.remove")}
          busyLabel={t("terminal.removing")}
          busy={busy}
          tone="danger"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => void change("remove")}
        />
      ) : null}
    </div>
  );
}
