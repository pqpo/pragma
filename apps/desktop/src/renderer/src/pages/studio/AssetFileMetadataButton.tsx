import { Table, X } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../components/Dialog.tsx";
import type { KnowledgeMetadataEntry } from "./knowledge-frontmatter.ts";

export function AssetFileMetadataButton(props: {
  readonly entries: readonly KnowledgeMetadataEntry[];
}) {
  const { t } = useTranslation("studio");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        title={t("fileMetadata")}
        aria-label={t("fileMetadata")}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Table size={17} />
      </button>
      {open ? (
        <Dialog
          title={t("fileMetadata")}
          className="knowledge-frontmatter-dialog"
          onCancel={() => setOpen(false)}
          headerAction={
            <button
              type="button"
              className="icon-button"
              aria-label={t("close")}
              title={t("close")}
              data-dialog-initial-focus
              onClick={() => setOpen(false)}
            >
              <X size={18} />
            </button>
          }
        >
          <div
            className="knowledge-frontmatter-scroll"
            tabIndex={0}
            role="region"
            aria-label={t("fileMetadata")}
          >
            <table className="knowledge-frontmatter-table">
              <thead>
                <tr>
                  <th scope="col">{t("fileMetadataField")}</th>
                  <th scope="col">{t("fileMetadataValue")}</th>
                </tr>
              </thead>
              <tbody>
                {props.entries.map(([field, value]) => (
                  <tr key={field}>
                    <th scope="row">{field}</th>
                    <td>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
