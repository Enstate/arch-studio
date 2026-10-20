import { useMountEffect } from "@arch/ui/hooks/use-mount-effect";
import { cn } from "@arch/ui/lib/utils";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { useT } from "./locale";

import type { ViewerProject } from "./types";
import { ControlBar, FullscreenButton, RoomLabel, ViewerHotkeys, WalkHint } from "./viewer-controls";
import {
  posterFor,
  useFullscreen,
  useViewerState,
  type ViewerActions,
  type ViewerInstance,
  viewerActions,
} from "./viewer-model";
import { ViewerStage } from "./viewer-stage";

/** The 3D viewer filling its container, or a quiet placeholder while the model is being made. */
export function ViewerPane({
  project,
  ...layers
}: { project: ViewerProject } & Pick<ViewerSurfaceProps, "onViewer" | "above" | "rightPanelOpen">) {
  if (project.status === "processing" || !project.planUrl) return <Processing />;
  return <ViewerSurface artifactId={project.artifactId} assetBase={project.assetBase} planUrl={project.planUrl} posterUrl={project.posterUrl ?? posterFor(project.planUrl)} {...layers} />;
}

function Processing() {
  const t = useT();
  return (
    <div className="grid size-full min-h-60 place-items-center bg-foreground/2">
      <p className="flex items-center gap-2 text-ui text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-info motion-safe:animate-pulse" />
        {t.viewer.processing}
      </p>
    </div>
  );
}

/**
 * Full-bleed canvas with floating controls. The stage is keyed by plan URL: while this component
 * stays mounted, a project with the same plan reuses the running viewer.
 */
export interface ViewerSurfaceProps {
  /** A fullscreen button top right. The portal keeps that corner free; F and "Mehr" still work. */
  cornerFullscreen?: boolean;
  onViewer?: (viewer: ViewerInstance | null) => void;
  onProgress?: (progress: number) => void;
  onError?: () => void;
  planUrl: string;
  assetBase?: string;
  artifactId?: string;
  posterUrl?: string | null;
  /** Above the room label, top left. */
  top?: ReactNode;
  /** Below the control bar. */
  footer?: ReactNode;
  /** Docked on top of the control bar and as wide as it, such as the comment composer. */
  above?: ReactNode;
  /**
   * A side panel covers the right edge on desktop; the bottom controls center in what is left and
   * their container queries measure that width.
   */
  rightPanelOpen?: boolean;
  className?: string;
}

export function ViewerSurface({
  planUrl,
  assetBase,
  artifactId,
  posterUrl,
  top,
  footer,
  above,
  rightPanelOpen,
  className,
  cornerFullscreen,
  onViewer,
  onProgress,
  onError,
}: ViewerSurfaceProps) {
  const [viewer, setViewer] = useState<ViewerInstance | null>(null);
  const reportViewer = useCallback((next: ViewerInstance | null) => {
    setViewer(next);
    onViewer?.(next);
  }, [onViewer]);
  const state = useViewerState(viewer);
  const actions = useMemo(() => viewer && viewerActions(viewer), [viewer]);
  const fullscreen = useFullscreen();

  return (
    <div
      data-viewer=""
      className={cn(
        "@container relative size-full min-h-0 overflow-hidden bg-muted",
        fullscreen && "fixed inset-0 z-50",
        className,
      )}
    >
      <ViewerStage
        key={artifactId ?? planUrl}
        planUrl={planUrl}
        assetBase={assetBase}
        posterUrl={posterUrl}
        onViewer={reportViewer}
        onProgress={onProgress}
        onError={onError}
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-col items-start gap-2">
          {top}
          {viewer && state && <RoomLabel viewer={viewer} state={state} />}
        </div>
        {viewer && cornerFullscreen && <FullscreenButton />}
      </div>

      <div
        className={cn(
          "@container pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] transition-[padding] duration-200 ease-out-quint",
          rightPanelOpen && "md:pr-90",
        )}
      >
        {viewer && state && actions && (
          <>
            <WalkHint state={state} />
            <div className="grid w-fit max-w-full grid-cols-1 gap-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300">
              {above}
              <ControlBar viewer={viewer} state={state} actions={actions} />
            </div>
            <ViewerSession key={instanceKey(viewer)} viewer={viewer} actions={actions} />
          </>
        )}
        {footer}
      </div>
    </div>
  );
}

const instanceKeys = new WeakMap<ViewerInstance, number>();
let instanceCount = 0;
function instanceKey(viewer: ViewerInstance) {
  if (!instanceKeys.has(viewer)) instanceKeys.set(viewer, ++instanceCount);
  return instanceKeys.get(viewer);
}

function ViewerSession({ viewer, actions }: { viewer: ViewerInstance; actions: ViewerActions }) {
  useMountEffect(() => {
    // The theme class on <html> is the source of truth, whether set by the user, the system or another tab.
    const root = document.documentElement;
    const syncTheme = () => viewer.setTheme(root.classList.contains("dark") ? "dark" : "light");
    syncTheme();
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  });
  return <ViewerHotkeys actions={actions} />;
}
