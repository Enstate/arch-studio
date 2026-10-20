import { ARCH_MARK, ARCH_MARK_VIEWBOX, ArchMark } from "@arch/ui/components/arch-logo";
import { cn } from "@arch/ui/lib/utils";
import type { CSSProperties } from "react";

import { useFormat, useT } from "./locale";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${ARCH_MARK_VIEWBOX}"><path d="${ARCH_MARK}"/></svg>`;
const glyphMask: CSSProperties = {
  maskImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
  maskSize: "100% 100%",
  maskRepeat: "no-repeat",
};

// Two periods, so sliding the strip by half its width loops without a seam.
const WAVE = "M0 10C25 0 25 0 50 10S75 20 100 10S125 0 150 10S175 20 200 10V20H0Z";

/**
 * The Arch "A" filling with liquid as the viewer loads. Only `translate`, `scale` and `opacity`
 * animate, on HTML layers under a CSS mask, so the compositor keeps the wave moving while the
 * main thread is busy compiling shaders. `done` tops it up, calms the wave and fades it out.
 */
export function ViewerLoader({ progress, done = false, onHidden }: { progress: number; done?: boolean; onHidden?: () => void }) {
  const level = done ? 1 : Math.min(1, Math.max(0, progress));
  const value = Math.round(level * 100);
  const t = useT();
  const format = useFormat();

  return (
    <div
      onTransitionEnd={(e) => {
        if (done && e.target === e.currentTarget && e.propertyName === "opacity") onHidden?.();
      }}
      className={cn(
        "pointer-events-none absolute inset-0 grid place-items-center bg-muted transition-opacity duration-500 ease-out motion-reduce:delay-0",
        done && "opacity-0 delay-300",
      )}
    >
      <div
        role="progressbar"
        aria-label={t.viewer.loading}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="flex flex-col items-center gap-4"
      >
        <div className="relative aspect-[440/354] w-14">
          <ArchMark className="absolute inset-0 h-full w-full text-foreground/8" />
          <div className="absolute inset-0" style={glyphMask}>
            {/* Between reports the liquid keeps creeping a third of the way to full on a long ease-out, so a
                stalled load still moves; the transition runs on the compositor while the main thread compiles. */}
            <div
              className={cn(
                "absolute inset-0 translate-y-[calc((1-var(--level)-var(--creep))*100%)] transition-[translate] ease-out [--creep:var(--creep-to)] motion-reduce:transition-none motion-reduce:[--creep:0]",
                done ? "duration-700" : "duration-[2400ms]",
              )}
              style={{ "--level": level, "--creep-to": done ? 0 : (1 - level) * 0.35 } as CSSProperties}
            >
              <div
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-0 bottom-[calc(100%-1px)] h-[14%] origin-bottom transition-[scale] duration-500 ease-out motion-reduce:hidden",
                  done && "scale-y-0",
                )}
              >
                <svg
                  viewBox="0 0 200 20"
                  preserveAspectRatio="none"
                  className="absolute bottom-0 left-0 h-full w-[200%] animate-[arch-wave_3.4s_linear_infinite_reverse] text-foreground/35"
                >
                  <path d={WAVE} fill="currentColor" />
                </svg>
                <svg
                  viewBox="0 0 200 20"
                  preserveAspectRatio="none"
                  className="absolute bottom-0 left-0 h-3/4 w-[200%] animate-[arch-wave_2.2s_linear_infinite] text-foreground"
                >
                  <path d={WAVE} fill="currentColor" />
                </svg>
              </div>
              <div className="absolute inset-0 bg-foreground" />
            </div>
          </div>
        </div>
        <p aria-hidden="true" className="text-2xs text-muted-foreground tabular-nums">
          {format.number(value / 100, { style: "percent" })}
        </p>
      </div>
    </div>
  );
}
