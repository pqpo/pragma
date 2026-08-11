import { Check } from "@phosphor-icons/react";
import { resolvePragmaAvatarId } from "@pragma/shared";
import { useTranslation } from "react-i18next";

import { Dialog } from "../../components/Dialog.tsx";
import { EXPERT_AVATAR_OPTIONS } from "../../components/ExpertAvatar.tsx";
import { ProfiledExpertAvatar } from "../../components/ProfiledExpertAvatar.tsx";

export function ExpertAvatarPicker(props: {
  readonly value: string;
  readonly onChange: (avatarId: string) => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation("studio");
  const selectedId = resolvePragmaAvatarId("expert", props.value);
  return (
    <Dialog
      className="expert-avatar-picker-dialog"
      title={t("avatarPickerTitle")}
      description={t("avatarPickerDescription")}
      onCancel={props.onCancel}
    >
      <div className="expert-avatar-picker-grid" role="listbox" aria-label={t("avatarPickerTitle")}>
        {EXPERT_AVATAR_OPTIONS.map((option) => {
          const selected = option.id === selectedId;
          return (
            <button
              className={selected ? "expert-avatar-option is-selected" : "expert-avatar-option"}
              type="button"
              role="option"
              aria-selected={selected}
              aria-label={t("avatarOption", { name: option.name })}
              key={option.id}
              onClick={() => props.onChange(option.id)}
            >
              <ProfiledExpertAvatar avatarId={option.id} size="picker" />
              {selected ? <Check size={15} weight="bold" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
