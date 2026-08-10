import { CaretDown, Check, MagnifyingGlass } from "@phosphor-icons/react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type SelectMenuOption<Value extends string = string> = {
  readonly value: Value;
  readonly label: string;
  readonly description?: string | undefined;
  readonly disabled?: boolean | undefined;
};

type MenuPlacement = "top" | "bottom";

export function SelectMenu<Value extends string>(props: {
  readonly ariaLabel: string;
  readonly className?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly emptyLabel?: string | undefined;
  readonly icon?: ReactNode | undefined;
  readonly onChange: (value: Value) => void;
  readonly overlayOwnerId?: string | undefined;
  readonly options: readonly SelectMenuOption<Value>[];
  readonly placement?: "auto" | MenuPlacement | undefined;
  readonly portal?: boolean | undefined;
  readonly align?: "start" | "end" | undefined;
  readonly animateOverflowingOptions?: boolean | undefined;
  readonly searchable?: boolean | undefined;
  readonly searchPlaceholder?: string | undefined;
  readonly title?: string | undefined;
  readonly value: Value;
}) {
  const listboxId = `${useId().replaceAll(":", "")}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = props.options.findIndex((option) => option.value === props.value);
  const selected = props.options[selectedIndex] ?? props.options.find((option) => !option.disabled);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPlacement, setMenuPlacement] = useState<MenuPlacement>("bottom");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!props.searchable || term === "") return props.options;
    return props.options.filter((option) =>
      `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(term),
    );
  }, [props.options, props.searchable, query]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target))
        closeMenu(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const positionMenu = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (trigger === undefined) return;
      const viewportPadding = 12;
      const menuGap = 8;
      const preferred = props.placement ?? "auto";
      const availableBelow = window.innerHeight - trigger.bottom - viewportPadding;
      const availableAbove = trigger.top - viewportPadding;
      const placement =
        preferred === "auto"
          ? availableBelow >= 240 || availableBelow >= availableAbove
            ? "bottom"
            : "top"
          : preferred;
      const width = Math.min(Math.max(trigger.width, 200), Math.max(200, window.innerWidth - 24));
      const left =
        props.align === "end"
          ? Math.max(viewportPadding, trigger.right - width)
          : Math.min(trigger.left, window.innerWidth - width - viewportPadding);
      setMenuPlacement(placement);
      setMenuStyle({
        left,
        width,
        ...(placement === "bottom"
          ? { top: trigger.bottom + menuGap }
          : { bottom: window.innerHeight - trigger.top + menuGap }),
      });
    };
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, props.align, props.placement]);

  useEffect(() => {
    if (!open) return;
    const selectedVisibleIndex = visibleOptions.findIndex((option) => option.value === props.value);
    const nextIndex = optionAvailable(visibleOptions, selectedVisibleIndex)
      ? selectedVisibleIndex
      : firstAvailableOption(visibleOptions);
    setActiveIndex(nextIndex);
    requestAnimationFrame(() => {
      if (props.searchable) searchRef.current?.focus();
      else optionRefs.current[nextIndex]?.focus();
    });
  }, [open, props.searchable, props.value, visibleOptions]);

  useEffect(() => {
    if (props.disabled) closeMenu(false);
  }, [props.disabled]);

  const openMenu = (preferredValue = props.value) => {
    if (props.disabled) return;
    setQuery("");
    const preferredIndex = props.options.findIndex((option) => option.value === preferredValue);
    setActiveIndex(
      optionAvailable(props.options, preferredIndex)
        ? preferredIndex
        : firstAvailableOption(props.options),
    );
    setOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setOpen(false);
    setQuery("");
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
      const nextIndex = nextAvailableOption(props.options, selectedIndex, direction);
      openMenu(props.options[nextIndex]?.value);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex =
        event.key === "Home"
          ? firstAvailableOption(props.options)
          : lastAvailableOption(props.options);
      openMenu(props.options[nextIndex]?.value);
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
        visibleOptions,
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
          ? firstAvailableOption(visibleOptions)
          : lastAvailableOption(visibleOptions);
      setActiveIndex(nextIndex);
      optionRefs.current[nextIndex]?.focus();
    }
  };

  const menu = (
    <div
      className={`ui-select-menu is-${menuPlacement}`}
      id={listboxId}
      role="listbox"
      aria-label={props.ariaLabel}
      data-ui-overlay-owner={props.overlayOwnerId}
      ref={menuRef}
      style={menuStyle}
      hidden={!open}
    >
      {props.searchable ? (
        <label className="ui-select-search">
          <MagnifyingGlass size={15} aria-hidden="true" />
          <span className="sr-only">{props.searchPlaceholder ?? props.ariaLabel}</span>
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder={props.searchPlaceholder ?? props.ariaLabel}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeMenu(true);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                optionRefs.current[firstAvailableOption(visibleOptions)]?.focus();
              }
            }}
          />
        </label>
      ) : null}
      {visibleOptions.length === 0 ? (
        <p className="ui-select-empty">{props.emptyLabel ?? props.ariaLabel}</p>
      ) : (
        visibleOptions.map((option, index) => (
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
            tabIndex={index === activeIndex ? 0 : -1}
            onClick={() => choose(option)}
            onFocus={() => setActiveIndex(index)}
            onKeyDown={(event) => handleOptionKeyDown(event, index)}
          >
            <span className="ui-select-option-copy">
              {props.animateOverflowingOptions ? (
                <OverflowingOptionLabel label={option.label} visible={open} />
              ) : (
                <span>{option.label}</span>
              )}
              {option.description ? <small>{option.description}</small> : null}
            </span>
            <Check className="ui-select-option-check" size={14} weight="bold" aria-hidden="true" />
          </button>
        ))
      )}
    </div>
  );

  return (
    <div
      className={["ui-select", props.className, open ? "is-open" : ""].filter(Boolean).join(" ")}
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
      {!open || typeof document === "undefined" || props.portal === false
        ? menu
        : createPortal(menu, document.body)}
    </div>
  );
}

function OverflowingOptionLabel(props: { readonly label: string; readonly visible: boolean }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);

  useLayoutEffect(() => {
    if (!props.visible) {
      setOverflowDistance(0);
      return;
    }

    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (viewport === null || content === null) return;

    const measure = () => {
      setOverflowDistance(Math.max(0, content.scrollWidth - viewport.clientWidth));
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    return () => observer.disconnect();
  }, [props.label, props.visible]);

  const overflowing = overflowDistance > 1;
  const style:
    | (CSSProperties & Record<"--ui-marquee-distance" | "--ui-marquee-duration", string>)
    | undefined = overflowing
    ? {
        "--ui-marquee-distance": `${overflowDistance}px`,
        "--ui-marquee-duration": `${Math.max(3.2, overflowDistance / 36 + 1.8)}s`,
      }
    : undefined;

  return (
    <span
      className={`ui-overflow-marquee${overflowing ? " is-overflowing" : ""}`}
      ref={viewportRef}
      style={style}
      title={props.label}
    >
      <span ref={contentRef}>{props.label}</span>
    </span>
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
