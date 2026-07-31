import { useEffect, useRef, useState } from "react";
import { GitBranch, Sparkle, TerminalWindow } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

type ConstellationNode = {
  readonly x: number;
  readonly y: number;
  readonly driftX: number;
  readonly driftY: number;
  readonly duration: number;
  readonly phase: number;
  readonly radius: number;
  readonly pulse?: boolean;
};

const CONSTELLATION_NODES: readonly ConstellationNode[] = [
  { x: 0.1, y: 0.16, driftX: 2.2, driftY: 1.4, duration: 16, phase: 0.2, radius: 1.9 },
  { x: 0.15, y: 0.09, driftX: 1.7, driftY: 2.2, duration: 18, phase: 1.1, radius: 2.1 },
  { x: 0.2, y: 0.2, driftX: 2.6, driftY: 1.5, duration: 14, phase: 2.4, radius: 1.7 },
  { x: 0.25, y: 0.12, driftX: 1.5, driftY: 2.4, duration: 17, phase: 0.8, radius: 2.3 },
  { x: 0.3, y: 0.22, driftX: 2.1, driftY: 1.6, duration: 15, phase: 3.2, radius: 1.8 },
  {
    x: 0.35,
    y: 0.07,
    driftX: 1.6,
    driftY: 2.5,
    duration: 19,
    phase: 2,
    radius: 2.1,
    pulse: true,
  },
  { x: 0.39, y: 0.17, driftX: 2.3, driftY: 1.4, duration: 14, phase: 4.1, radius: 1.6 },
  { x: 0.44, y: 0.1, driftX: 1.8, driftY: 2.1, duration: 18, phase: 1.7, radius: 1.9 },
  { x: 0.56, y: 0.08, driftX: 2.1, driftY: 1.6, duration: 15, phase: 3.8, radius: 1.8 },
  { x: 0.61, y: 0.17, driftX: 1.5, driftY: 2.4, duration: 19, phase: 0.5, radius: 2.2 },
  {
    x: 0.66,
    y: 0.09,
    driftX: 2.4,
    driftY: 1.5,
    duration: 16,
    phase: 2.8,
    radius: 1.7,
    pulse: true,
  },
  { x: 0.71, y: 0.21, driftX: 1.7, driftY: 2.2, duration: 18, phase: 4.7, radius: 2.1 },
  { x: 0.76, y: 0.12, driftX: 2.5, driftY: 1.3, duration: 14, phase: 1.3, radius: 1.7 },
  { x: 0.81, y: 0.2, driftX: 1.6, driftY: 2.5, duration: 17, phase: 3.5, radius: 2.2 },
  { x: 0.86, y: 0.08, driftX: 2.2, driftY: 1.6, duration: 15, phase: 0.9, radius: 1.8 },
  { x: 0.91, y: 0.16, driftX: 1.4, driftY: 2.3, duration: 19, phase: 2.2, radius: 2.1 },
] as const;

const CONSTELLATION_CONNECTIONS = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [2, 4],
  [3, 5],
  [3, 6],
  [4, 6],
  [5, 7],
  [6, 7],
  [8, 9],
  [8, 10],
  [9, 10],
  [9, 11],
  [10, 12],
  [11, 12],
  [11, 13],
  [12, 14],
  [13, 14],
  [13, 15],
  [14, 15],
] as const;

const SUBMIT_ORDER = CONSTELLATION_NODES.map((_, index) => index).sort(
  (left, right) =>
    Math.abs(CONSTELLATION_NODES[right]!.x - 0.5) - Math.abs(CONSTELLATION_NODES[left]!.x - 0.5),
);

type SpecialNodeKind = "repository" | "terminal" | "synthesis";

const SPECIAL_NODES: readonly {
  readonly kind: SpecialNodeKind;
  readonly className: string;
}[] = [
  { kind: "terminal", className: "is-terminal" },
  { kind: "repository", className: "is-repository" },
  { kind: "synthesis", className: "is-synthesis" },
];

export function ExpertConstellation(props: {
  readonly focused: boolean;
  readonly submitting: boolean;
}) {
  const { t } = useTranslation("missions");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [activeNode, setActiveNode] = useState<SpecialNodeKind>();
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    if (props.focused || props.submitting) setActiveNode(undefined);
  }, [props.focused, props.submitting]);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (root === null || canvas === null) return;

    const context = canvas.getContext("2d");
    if (context === null) return;

    const pointer = { x: Number.NaN, y: Number.NaN };
    let width = 0;
    let height = 0;
    let left = 0;
    let top = 0;
    let green = "rgb(88 121 104)";
    let frame = 0;
    const submitStartedAt = props.submitting ? performance.now() : undefined;

    const resize = () => {
      const bounds = root.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = bounds.width;
      height = bounds.height;
      left = bounds.left;
      top = bounds.top;
      green = getComputedStyle(root).getPropertyValue("--green").trim() || green;
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const pointerMove = (event: PointerEvent) => {
      const inside =
        event.clientX >= left &&
        event.clientX <= left + width &&
        event.clientY >= top &&
        event.clientY <= top + height;
      pointer.x = inside ? event.clientX - left : Number.NaN;
      pointer.y = inside ? event.clientY - top : Number.NaN;
    };

    const pointerLeave = () => {
      pointer.x = Number.NaN;
      pointer.y = Number.NaN;
    };

    const draw = (timestamp: number) => {
      context.clearRect(0, 0, width, height);
      const time = timestamp / 1000;
      const pointerRadius = 120;
      const points = CONSTELLATION_NODES.map((node, index) => {
        const angle = (time / node.duration) * Math.PI * 2 + node.phase;
        let x = node.x * width + (reducedMotion ? 0 : Math.sin(angle) * node.driftX);
        let y = node.y * height * 1.22 + (reducedMotion ? 0 : Math.cos(angle * 0.83) * node.driftY);
        const pointerDistance = Math.hypot(pointer.x - x, pointer.y - y);
        const pointerInfluence =
          reducedMotion || !Number.isFinite(pointerDistance)
            ? 0
            : Math.max(0, 1 - pointerDistance / pointerRadius);
        if (pointerInfluence > 0 && pointerDistance > 0) {
          x += ((pointer.x - x) / pointerDistance) * pointerInfluence * 3;
          y += ((pointer.y - y) / pointerDistance) * pointerInfluence * 3;
        }
        const submitPosition = SUBMIT_ORDER.indexOf(index);
        const submitActive =
          props.submitting &&
          (reducedMotion ||
            (submitStartedAt !== undefined && timestamp - submitStartedAt >= submitPosition * 42));
        return { x, y, pointerInfluence, submitActive };
      });

      context.strokeStyle = green;
      context.lineWidth = 0.75;
      for (const [from, to] of CONSTELLATION_CONNECTIONS) {
        const start = points[from]!;
        const end = points[to]!;
        const active = start.submitActive && end.submitActive;
        context.globalAlpha =
          (active ? 0.33 : 0.075 + Math.max(start.pointerInfluence, end.pointerInfluence) * 0.15) *
          (props.focused ? 0.42 : 1);
        context.beginPath();
        context.moveTo(start.x, start.y);
        context.lineTo(end.x, end.y);
        context.stroke();
      }

      context.fillStyle = green;
      for (const [index, point] of points.entries()) {
        const node = CONSTELLATION_NODES[index]!;
        const pulseProgress = reducedMotion || !node.pulse ? 0 : (time + node.phase) % 9;
        const pulse = pulseProgress > 1.2 ? 0 : Math.sin((pulseProgress / 1.2) * Math.PI) * 1.9;
        const radius =
          node.radius + point.pointerInfluence * 1.1 + (point.submitActive ? 1.15 : 0) + pulse;
        context.globalAlpha =
          (point.submitActive ? 0.78 : 0.16 + point.pointerInfluence * 0.4) *
          (props.focused ? 0.48 : 1);
        context.beginPath();
        context.arc(point.x, point.y, radius, 0, Math.PI * 2);
        context.fill();

        if (pulse > 0 || point.submitActive) {
          context.globalAlpha = (point.submitActive ? 0.14 : 0.07) * (props.focused ? 0.45 : 1);
          context.beginPath();
          context.arc(point.x, point.y, radius + 5, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.globalAlpha = 1;

      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(() => {
      resize();
      if (reducedMotion) draw(performance.now());
    });
    observer.observe(root);
    window.addEventListener("pointermove", pointerMove, { passive: true });
    window.addEventListener("blur", pointerLeave);
    resize();
    draw(performance.now());

    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("blur", pointerLeave);
      cancelAnimationFrame(frame);
    };
  }, [props.focused, props.submitting, reducedMotion]);

  return (
    <div
      ref={rootRef}
      className={[
        "expert-constellation",
        props.focused ? "is-focused" : "",
        props.submitting ? "is-submitting" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <canvas ref={canvasRef} className="expert-constellation-canvas" aria-hidden="true" />
      <div className="expert-constellation-status" aria-hidden="true">
        <span aria-hidden="true" />
        {props.submitting ? t("constellationOrchestrating") : t("constellationReady")}
      </div>
      {SPECIAL_NODES.map((node) => (
        <button
          key={node.kind}
          className={[
            "expert-constellation-special-node",
            node.className,
            activeNode === node.kind ? "is-active" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          type="button"
          aria-label={specialNodeLabel(node.kind, t)}
          aria-pressed={activeNode === node.kind}
          onClick={() =>
            setActiveNode((current) => (current === node.kind ? undefined : node.kind))
          }
        >
          <SpecialNodeIcon kind={node.kind} />
          <span role="tooltip">{specialNodeLabel(node.kind, t)}</span>
        </button>
      ))}
    </div>
  );
}

function SpecialNodeIcon(props: { readonly kind: SpecialNodeKind }) {
  if (props.kind === "repository")
    return <GitBranch size={13} weight="regular" aria-hidden="true" />;
  if (props.kind === "terminal")
    return <TerminalWindow size={13} weight="regular" aria-hidden="true" />;
  return <Sparkle size={13} weight="regular" aria-hidden="true" />;
}

function specialNodeLabel(kind: SpecialNodeKind, translate: (key: string) => string): string {
  if (kind === "repository") return translate("constellationRepositoryExpert");
  if (kind === "terminal") return translate("constellationExecutionExpert");
  return translate("constellationSynthesisExpert");
}
