import { CaretDown, Check } from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

export type SelectMenuOption<Value extends string = string> = {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean | undefined;
};

export function SelectMenu<Value extends string>(props: {
  readonly ariaLabel: string;
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly icon?: ReactNode | undefined;
  readonly onChange: (value: Value) => void;
  readonly options: readonly SelectMenuOption<Value>[];
  readonly placement?: "top" | "bottom" | undefined;
  readonly title?: string | undefined;
  readonly value: Value;
}) {
  const listboxId = `${useId().replaceAll(":", "")}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = props.options.findIndex((option) => option.value === props.value);
  const selected = props.options[selectedIndex] ?? props.options.find((option) => !option.disabled);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const nextIndex = optionAvailable(props.options, activeIndex)
      ? activeIndex
      : firstAvailableOption(props.options);
    setActiveIndex(nextIndex);
    requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  }, [activeIndex, open, props.options]);

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  const openMenu = (preferredIndex = selectedIndex) => {
    if (props.disabled) return;
    setActiveIndex(
      optionAvailable(props.options, preferredIndex)
        ? preferredIndex
        : firstAvailableOption(props.options),
    );
    setOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (option: SelectMenuOption<Value>) => {
    if (option.disabled) return;
    props.onChange(option.value);
    closeMenu(true);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      openMenu(nextAvailableOption(props.options, selectedIndex, direction));
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      openMenu(
        event.key === "Home"
          ? firstAvailableOption(props.options)
          : lastAvailableOption(props.options),
      );
    }
  };

  const handleOptionKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = nextAvailableOption(
        props.options,
        index,
        event.key === "ArrowDown" ? 1 : -1,
      );
      setActiveIndex(nextIndex);
      optionRefs.current[nextIndex]?.focus();
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? firstAvailableOption(props.options)
          : lastAvailableOption(props.options);
      setActiveIndex(nextIndex);
      optionRefs.current[nextIndex]?.focus();
    }
  };

  return (
    <div
      className={["ui-select", props.className, open ? "is-open" : ""].filter(Boolean).join(" ")}
      data-placement={props.placement ?? "top"}
      ref={rootRef}
      title={props.title}
    >
      <button
        className="ui-select-trigger"
        type="button"
        ref={triggerRef}
        role="combobox"
        aria-label={props.ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={props.disabled}
        onClick={() => (open ? closeMenu(false) : openMenu())}
        onKeyDown={handleTriggerKeyDown}
      >
        {props.icon}
        <span className="ui-select-value">{selected?.label ?? props.ariaLabel}</span>
        <CaretDown className="ui-select-caret" size={13} aria-hidden="true" />
      </button>
      <div
        className="ui-select-menu"
        id={listboxId}
        role="listbox"
        aria-label={props.ariaLabel}
        hidden={!open}
      >
        {props.options.map((option, index) => (
          <button
            className="ui-select-option"
            type="button"
            role="option"
            aria-selected={option.value === props.value}
            disabled={option.disabled}
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            tabIndex={open && index === activeIndex ? 0 : -1}
            onClick={() => choose(option)}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
          >
            <span>{option.label}</span>
            <Check className="ui-select-option-check" size={14} weight="bold" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

function optionAvailable<Value extends string>(
  options: readonly SelectMenuOption<Value>[],
  index: number,
): boolean {
  return index >= 0 && index < options.length && !options[index]?.disabled;
}

function firstAvailableOption<Value extends string>(
  options: readonly SelectMenuOption<Value>[],
): number {
  const index = options.findIndex((option) => !option.disabled);
  return index < 0 ? 0 : index;
}

function lastAvailableOption<Value extends string>(
  options: readonly SelectMenuOption<Value>[],
): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return 0;
}

function nextAvailableOption<Value extends string>(
  options: readonly SelectMenuOption<Value>[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return 0;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (currentIndex + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return currentIndex < 0 ? 0 : currentIndex;
}
