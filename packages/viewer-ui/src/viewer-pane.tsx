import { useMountEffect } from "@arch/ui/hooks/use-mount-effect";
import { cn } from "@arch/ui/lib/utils";
import { ChevronUpIcon } from "lucide-react";
import { type ReactNode, useCallback, useId, useMemo, useRef, useState } from "react";

import { useT } from "./locale";

import type { ViewerProject } from "./types";
import { ControlBar, DesignOptionPicker, focusToggle, LevelPicker, RoomLabel, readStoredFlag, storeFlag, ToolsCard, ViewerHotkeys, NavigationHint, WalkHint } from "./viewer-controls";
import { posterFor, rememberedDesignOption, useFullscreen, useViewerState, viewerActions, type ViewerActions, type ViewerInstance } from "./viewer-model";
import { type DropHandlers, EditButton, EditSession, type ViewerEditing } from "./viewer-editing";
import { ViewerStage } from "./viewer-stage";

/** The 3D viewer filling its container, or a quiet placeholder while the model is being made. */
export function ViewerPane({
  project,
  ...layers
}: { project: ViewerProject } & Pick<ViewerSurfaceProps, "onViewer" | "above" | "rightPanelOpen" | "toolsHidden" | "editing">) {
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
  /** Hides the top-right tools card, such as while a popover covers that corner. */
  toolsHidden?: boolean;
  /** Lets someone edit the design by hand: an Edit button opens the trays. */
  editing?: ViewerEditing;
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
  toolsHidden,
  editing,
  className,
  onViewer,
  onProgress,
  onError,
}: ViewerSurfaceProps) {
  const [viewer, setViewer] = useState<ViewerInstance | null>(null);
  // Editing happens in the house on show: the viewer is built editable whenever a host offers it,
  // and the Edit button only takes the house apart in place.
  const [editingOn, setEditingOn] = useState(false);
  const dropTarget = useRef<DropHandlers | null>(null);
  const reportViewer = useCallback((next: ViewerInstance | null) => {
    setViewer(next);
    onViewer?.(next);
  }, [onViewer]);
  const editable = !!editing && editingOn;
  const state = useViewerState(viewer);
  const actions = useMemo(() => viewer && viewerActions(viewer), [viewer]);
  const fullscreen = useFullscreen();
  const t = useT();
  const contentId = useId();
  const [collapsed, setCollapsed] = useState(() => readStoredFlag(DOCK_KEY, "collapsed"));
  const setDock = (next: boolean) => {
    setCollapsed(next);
    storeFlag(DOCK_KEY, next ? "collapsed" : "open");
  };
  const [labelsHidden, setLabelsHidden] = useState(() => readStoredFlag(LABELS_KEY, "off"));
  const toggleLabels = () => {
    setLabelsHidden(!labelsHidden);
    storeFlag(LABELS_KEY, labelsHidden ? "on" : "off");
  };
  const dockRef = useRef<HTMLDivElement | null>(null);
  const toggleDock = (next: boolean) => {
    setDock(next);
    focusToggle(dockRef.current, contentId, !next);
  };
  const setDockRef = useRef(setDock);
  setDockRef.current = setDock;
  const listenForExpand = useCallback((node: HTMLDivElement | null) => {
    dockRef.current = node;
    if (!node) return;
    // Focus requests from outside (the comments M hotkey) focus right after dispatching, before React
    // re-renders, so the content drops `inert` here first; the render then agrees.
    const expand = () => {
      const content = node.firstElementChild;
      if (content instanceof HTMLElement) content.inert = false;
      setDockRef.current(false);
    };
    node.addEventListener(DOCK_EXPAND_EVENT, expand);
    return () => node.removeEventListener(DOCK_EXPAND_EVENT, expand);
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the surface only receives pieces and finishes dragged from the edit trays
    <div
      data-viewer=""
      data-labels={viewer && labelsHidden ? "off" : undefined}
      onDragOver={(e) => dropTarget.current?.onDragOver(e)}
      onDrop={(e) => dropTarget.current?.onDrop(e)}
      className={cn(
        "@container relative size-full min-h-0 overflow-hidden bg-muted",
        // `.arch-room-label` is the class @arch/viewer gives each room label button.
        "data-[labels=off]:[&_.arch-room-label]:invisible",
        fullscreen && "fixed inset-0 z-50",
        className,
      )}
    >
      <ViewerStage
        key={`${artifactId ?? planUrl}${editing ? ":editable" : ""}`}
        planUrl={planUrl}
        assetBase={assetBase}
        editable={editing && { catalogBase: editing.catalogBase }}
        posterUrl={posterUrl}
        onViewer={reportViewer}
        onProgress={onProgress}
        onError={onError}
      />

      {viewer && state && actions && (
        <div className="pointer-events-none absolute top-1/2 left-3 flex -translate-y-1/2 flex-col items-start gap-2">
          {editing && viewer.editor && !editable && <EditButton onStart={() => setEditingOn(true)} />}
          <LevelPicker viewer={viewer} state={state} actions={actions} />
          <DesignOptionPicker viewer={viewer} state={state} actions={actions} />
        </div>
      )}

      <div className="@container pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-3">
        <div className="flex min-w-0 flex-col items-start gap-2">
          {top}
          {viewer && state && <RoomLabel viewer={viewer} state={state} />}
        </div>
        {viewer && state && actions && (
          <ToolsCard viewer={viewer} state={state} actions={actions} labelsHidden={labelsHidden} onToggleLabels={toggleLabels} hidden={rightPanelOpen || toolsHidden || editable} />
        )}
      </div>

      {editable && viewer?.editor && state && (
        <EditSession
          key={`${instanceKey(viewer)}:${editsKey(editing.saved)}`}
          viewer={viewer}
          state={state}
          editing={editing}
          dropTarget={dropTarget}
          onDone={() => setEditingOn(false)}
        />
      )}

      <div
        className={cn(
          "@container pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 p-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] transition-[padding] duration-200 ease-out-quint",
          rightPanelOpen && "md:pr-90",
        )}
      >
        {viewer && state && actions && (
          <>
            <NavigationHint state={state} />
            <WalkHint state={state} />
            <div
              ref={listenForExpand}
              className={cn(
                "pointer-events-auto relative grid max-w-full origin-bottom grid-cols-1 overflow-hidden bg-popover text-popover-foreground shadow-overlay transition-[width,height,border-radius,box-shadow] duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] [interpolate-size:allow-keywords] motion-reduce:transition-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300",
                collapsed ? "size-11 rounded-[22px]" : "h-auto w-fit rounded-[20px] @max-md:w-full",
              )}
            >
              <div
                id={contentId}
                inert={collapsed}
                aria-hidden={collapsed || undefined}
                className={cn(
                  "col-start-1 row-start-1 flex min-w-0 flex-col transition-[opacity,filter,scale] duration-200 ease-out",
                  collapsed ? "pointer-events-none scale-[0.96] opacity-0 blur-xs" : "blur-none scale-100 opacity-100",
                )}
              >
                {above}
                {above && <div aria-hidden="true" className="mx-2 h-px shrink-0 bg-border" />}
                <ControlBar state={state} actions={actions} docked controlsId={contentId} onCollapse={() => toggleDock(true)} />
              </div>
              <button
                type="button"
                inert={!collapsed}
                aria-label={t.viewer.showControls}
                aria-expanded="false"
                aria-controls={contentId}
                className={cn(
                  "absolute inset-0 grid place-items-center rounded-[22px] text-muted-foreground outline-none transition-[opacity,filter,scale,color] duration-200 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-4",
                  collapsed ? "scale-100 opacity-100 blur-none delay-120" : "pointer-events-none scale-[0.25] opacity-0 blur-xs",
                )}
                onClick={() => toggleDock(false)}
              >
                <ChevronUpIcon aria-hidden="true" />
              </button>
            </div>
            <ViewerSession key={instanceKey(viewer)} viewer={viewer} actions={actions} />
          </>
        )}
        {footer}
      </div>
    </div>
  );
}

const DOCK_KEY = "arch-viewer-dock";
const LABELS_KEY = "arch-viewer-labels";
/** Dispatch with `bubbles: true` from inside the dock to expand it before focusing. */
export const DOCK_EXPAND_EVENT = "arch:dock-expand";

/** Short and stable for the same saved edits, so a session starts over once new ones are saved. */
function editsKey(edits: object) {
  const text = JSON.stringify(edits);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `${text.length}.${h >>> 0}`;
}

const instanceKeys = new WeakMap<ViewerInstance, number>();
let instanceCount = 0;
function instanceKey(viewer: ViewerInstance) {
  if (!instanceKeys.has(viewer)) instanceKeys.set(viewer, ++instanceCount);
  return instanceKeys.get(viewer);
}

function ViewerSession({ viewer, actions }: { viewer: ViewerInstance; actions: ViewerActions }) {
  useMountEffect(() => {
    // A new version of the project opens in the look chosen last, when it still has that option.
    const remembered = rememberedDesignOption();
    if (remembered && viewer.designOptions().some((option) => option.id === remembered)) viewer.setDesignOption(remembered);
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
