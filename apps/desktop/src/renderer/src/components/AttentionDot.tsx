import { useTranslation } from "react-i18next";

export function AttentionDot() {
  const { t } = useTranslation("common");
  return (
    <span
      className="navigation-attention-dot"
      role="img"
      aria-label={t("navigation.needsAttention")}
    />
  );
}
