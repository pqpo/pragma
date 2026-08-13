import { Brain, CaretDown, CaretRight, Check } from "@phosphor-icons/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import type { DesktopRuntimeModel, MissionModelOverride } from "../../../shared/contracts/index.ts";

type OverridePanel = "model" | "thinking";

export function MissionModelOverrideControls(props: {
  readonly models: readonly DesktopRuntimeModel[];
  readonly loading?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly value?: MissionModelOverride | undefined;
  readonly defaultValue?: MissionModelOverride | undefined;
  readonly onChange: (value: MissionModelOverride | undefined) => void;
}) {
  const { t } = useTranslation("missions");
  const menuId = `${useId().replaceAll(":", "")}-menu`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<OverridePanel>("model");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const selected = props.models.find(
    (model) => model.provider.id === props.value?.providerId && model.id === props.value?.modelId,
  );
  const defaultModel = props.models.find(
    (model) =>
      model.provider.id === props.defaultValue?.providerId &&
      model.id === props.defaultValue?.modelId,
  );
  const effectiveModel = selected ?? defaultModel;
  const thinkingLevels = effectiveModel?.thinking?.supportedLevels ?? [];
  const effectiveThinkingLevel =
    props.value?.thinkingLevel ??
    effectiveModel?.thinking?.defaultLevel ??
    props.defaultValue?.thinkingLevel;
  const effectiveThinkingLabel = thinkingLevels.find(
    (level) => level.value === effectiveThinkingLevel,
  )?.label;
  const modelLabel =
    effectiveModel === undefined
      ? t("modelOverride")
      : `${effectiveModel.provider.displayName} · ${effectiveModel.displayName}`;
  const thinkingLabel = effectiveThinkingLabel ?? t("thinkingDepth");
  const disabled = props.loading || props.disabled || props.models.length === 0;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (trigger === undefined) return;
      const viewportPadding = 12;
      const menuWidth = Math.min(536, window.innerWidth - viewportPadding * 2);
      const menuGap = 8;
      const openAbove = window.innerHeight - trigger.bottom < 240 && trigger.top > 240;
      setMenuStyle({
        width: menuWidth,
        left: Math.max(
          viewportPadding,
          Math.min(trigger.right - menuWidth, window.innerWidth - menuWidth - viewportPadding),
        ),
        ...(openAbove
          ? { bottom: window.innerHeight - trigger.top + menuGap }
          : { top: trigger.bottom + menuGap }),
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);

  const closeMenu = () => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const chooseModel = (model: DesktopRuntimeModel) => {
    props.onChange({ providerId: model.provider.id, modelId: model.id });
    closeMenu();
  };

  const chooseThinkingLevel = (thinkingLevel: string) => {
    if (effectiveModel === undefined) return;
    props.onChange({
      providerId: effectiveModel.provider.id,
      modelId: effectiveModel.id,
      thinkingLevel,
    });
    closeMenu();
  };

  const menu = (
    <div
      className="mission-model-menu"
      id={menuId}
      ref={menuRef}
      role="dialog"
      aria-label={t("modelOverride")}
      style={menuStyle}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        closeMenu();
      }}
    >
      <div className="mission-model-menu-sections" role="tablist" aria-label={t("modelOverride")}>
        <MenuSection
          active={activePanel === "model"}
          label={t("modelOverride")}
          value={modelLabel}
          onSelect={() => setActivePanel("model")}
        />
        <MenuSection
          active={activePanel === "thinking"}
          disabled={thinkingLevels.length === 0}
          label={t("thinkingDepth")}
          value={thinkingLabel}
          onSelect={() => setActivePanel("thinking")}
        />
      </div>
      <div
        className="mission-model-menu-options"
        role="listbox"
        aria-label={t(activePanel === "model" ? "modelOverride" : "thinkingDepth")}
      >
        {activePanel === "model"
          ? props.models.map((model) => {
              const selectedModel =
                model.provider.id === effectiveModel?.provider.id &&
                model.id === effectiveModel?.id;
              return (
                <button
                  className="mission-model-menu-option"
                  type="button"
                  role="option"
                  aria-selected={selectedModel}
                  key={modelOptionKey(model.provider.id, model.id)}
                  onClick={() => chooseModel(model)}
                >
                  <span>{`${model.provider.displayName} · ${model.displayName}`}</span>
                  <Check size={15} weight="bold" aria-hidden="true" />
                </button>
              );
            })
          : thinkingLevels.map((level) => (
              <button
                className="mission-model-menu-option"
                type="button"
                role="option"
                aria-selected={level.value === effectiveThinkingLevel}
                key={level.value}
                onClick={() => chooseThinkingLevel(level.value)}
              >
                <span>{level.label}</span>
                <Check size={15} weight="bold" aria-hidden="true" />
              </button>
            ))}
      </div>
    </div>
  );

  return (
    <div
      className={`mission-model-control${open ? " is-open" : ""}`}
      ref={rootRef}
      data-testid="mission-model-control"
    >
      <button
        className="mission-model-control-trigger"
        type="button"
        ref={triggerRef}
        aria-label={t("modelOverride")}
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setActivePanel("model");
          setOpen((current) => !current);
        }}
      >
        <Brain size={16} aria-hidden="true" />
        <span className="mission-model-control-value">{`${modelLabel} · ${thinkingLabel}`}</span>
        <CaretDown size={13} aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined" ? createPortal(menu, document.body) : null}
    </div>
  );
}

function MenuSection(props: {
  readonly active: boolean;
  readonly disabled?: boolean | undefined;
  readonly label: string;
  readonly value: string;
  readonly onSelect: () => void;
}) {
  return (
    <button
      className="mission-model-menu-section"
      type="button"
      role="tab"
      aria-selected={props.active}
      disabled={props.disabled}
      onClick={props.onSelect}
    >
      <span className="mission-model-menu-section-label">{props.label}</span>
      <span className="mission-model-menu-section-value">{props.value}</span>
      <CaretRight size={15} aria-hidden="true" />
    </button>
  );
}

function modelOptionKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId]);
}
