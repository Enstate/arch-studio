import { cn } from "@arch/ui/lib/utils";

/** Room outlines in metres, as stored on the project. */
export type FloorPlan = { name: string; polygon: number[][] }[];

function bounds(rooms: FloorPlan) {
  const xs = rooms.flatMap((r) => r.polygon.map(([x = 0]) => x));
  const ys = rooms.flatMap((r) => r.polygon.map(([, y = 0]) => y));
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { minX, minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Strokes stay hairline at any size; the drawing inherits the text colour. */
export function PlanThumbnail({
  plan,
  className,
  outline = 1.5,
}: {
  plan?: FloorPlan | null;
  className?: string;
  /** Stroke width of the outer wall in px; rooms draw at 1 px. */
  outline?: number;
}) {
  if (!plan || plan.length === 0) {
    return (
      <svg viewBox="0 0 10 10" fill="none" aria-hidden="true" className={cn("text-faint-foreground", className)}>
        <rect
          x="1.5"
          y="1.5"
          width="7"
          height="7"
          stroke="currentColor"
          strokeDasharray="2 2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }
  const { minX, minY, width, height } = bounds(plan);
  const pad = Math.max(width, height) * 0.08;
  return (
    <svg
      viewBox={`${minX - pad} ${minY - pad} ${width + pad * 2} ${height + pad * 2}`}
      fill="none"
      stroke="currentColor"
      strokeLinejoin="miter"
      aria-hidden="true"
      className={className}
    >
      {plan.map((room) => (
        <polygon
          key={room.name}
          points={room.polygon.map(([x, y]) => `${x},${y}`).join(" ")}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={0.7}
        />
      ))}
      <rect
        x={minX}
        y={minY}
        width={width}
        height={height}
        strokeWidth={outline}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
