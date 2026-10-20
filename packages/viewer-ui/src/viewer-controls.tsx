import { Kbd } from "@arch/ui/components/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@arch/ui/components/popover";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@arch/ui/components/sheet";
import { Slider } from "@arch/ui/components/slider";
import { Switch } from "@arch/ui/components/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@arch/ui/components/tooltip";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useIsMobile } from "@arch/ui/hooks/use-mobile";
import { useMountEffect } from "@arch/ui/hooks/use-mount-effect";
import { cn } from "@arch/ui/lib/utils";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  FootprintsIcon,
  HouseIcon,
  type LucideIcon,
  MapIcon,
  MaximizeIcon,
  MinimizeIcon,
  MoonIcon,
  PauseIcon,
  PlayIcon,
  ScissorsIcon,
  SunIcon,
  TagIcon,
} from "lucide-react";
import { type ReactElement, type ReactNode, useId, useMemo, useState } from "react";

import { type Messages, useFormat, useT } from "./locale";

import {
  canFullscreen,
  clockLabel,
  MODES,
  TIME_STEPS,
  toggleFullscreen,
  useFullscreen,
  VIEWER_SHORTCUTS,
  type ViewerActions,
  type ViewerInstance,
  type ViewerMode,
  type ViewerState,
} from "./viewer-model";

const MODE_ICONS: Record<ViewerMode, LucideIcon> = {
  plan: MapIcon,
  dollhouse: HouseIcon,
  walk: FootprintsIcon,
};

export const pillItem =
  "relative inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-xl px-2.5 text-xs font-medium text-muted-foreground outline-none transition-[background-color,color,scale] duration-150 ease-out hover:bg-foreground/7 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] aria-pressed:bg-foreground/13 aria-pressed:text-foreground pointer-coarse:h-11 [&_svg]:size-3.5";

export const pillIcon = cn(pillItem, "w-7 px-0 pointer-coarse:w-11 pointer-coarse:px-0 [&_svg]:size-4");

/** Plain-key shortcuts stay quiet while a dialog or menu has focus. */
const insideOverlay = (event: KeyboardEvent) =>
  event.target instanceof Element && event.target.closest("[role=dialog],[role=menu],[role=listbox]") !== null;

export function Hint({ label, keys, children }: { label: string; keys?: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="top" sideOffset={8}>
        {label}
        {keys && <Kbd>{keys}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

const tourLabel = (status: ViewerState["tour"]["status"], t: Messages) =>
  status === "playing" ? t.viewer.tour.pause : status === "paused" ? t.viewer.tour.resume : t.viewer.tour.start;

const TOUR_WORDS = ["tour", "pause", "resume"] as const;

/** All three words share one grid cell, so the centred pill keeps its width when the word changes. */
function TourWord({ current }: { current: (typeof TOUR_WORDS)[number] }) {
  const words = useT().viewer.tour.words;
  return (
    <span aria-hidden="true" className="hidden @md:inline-grid">
      {TOUR_WORDS.map((word) => (
        <span key={word} className={cn("col-start-1 row-start-1 text-left", word !== current && "invisible")}>
          {words[word]}
        </span>
      ))}
    </span>
  );
}

/** The floating pill: view modes and the tour. */
export function ControlBar({
  state,
  actions,
  docked = false,
  onCollapse,
  controlsId,
}: {
  state: ViewerState;
  actions: ViewerActions;
  /** Inside a shared card that owns the surface. */
  docked?: boolean;
  /** Shows a chevron at the end that hides the card. */
  onCollapse?: () => void;
  controlsId?: string;
}) {
  const t = useT();
  const { status } = state.tour;
  const playing = status === "playing";
  // The tour owns the camera while it plays or pauses, so no view mode is the current one.
  const touring = playing || status === "paused";
  return (
    <div
      role="toolbar"
      aria-label={t.viewer.toolbar}
      className={cn(
        "pointer-events-auto flex max-w-full items-center overflow-x-auto [scrollbar-width:none] @max-md:justify-between",
        docked ? "gap-1 p-2" : "gap-0.5 rounded-2xl bg-popover p-1 text-popover-foreground shadow-popover",
      )}
    >
      <fieldset className="flex gap-0.5">
        <legend className="sr-only">{t.viewer.view}</legend>
        {MODES.map(({ mode, key }) => {
          const Icon = MODE_ICONS[mode];
          return (
            <Hint key={mode} label={t.viewer.modes[mode]} keys={key}>
              <button
                type="button"
                aria-pressed={!touring && state.mode === mode}
                className={cn(pillItem, "@md:pl-2 @max-md:w-7 @max-md:px-0 pointer-coarse:@max-md:w-11")}
                onClick={() => actions.setMode(mode)}
              >
                <Icon aria-hidden="true" />
                <span className="@max-md:sr-only">{t.viewer.modes[mode]}</span>
              </button>
            </Hint>
          );
        })}
      </fieldset>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
      <Hint label={tourLabel(status, t)} keys="T">
        <button
          type="button"
          aria-label={tourLabel(status, t)}
          aria-pressed={touring}
          className={cn(pillItem, "pointer-coarse:min-w-11 @md:pl-2")}
          onClick={actions.toggleTour}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
          <TourWord current={playing ? "pause" : status === "paused" ? "resume" : "tour"} />
        </button>
      </Hint>
      {onCollapse && (
        <Hint label={t.viewer.hideControls}>
          <button
            type="button"
            aria-label={t.viewer.hideControls}
            aria-expanded="true"
            aria-controls={controlsId}
            className={pillIcon}
            onClick={onCollapse}
          >
            <ChevronDownIcon aria-hidden="true" />
          </button>
        </Hint>
      )}
    </div>
  );
}

/** A boolean kept in localStorage; reads are safe during server rendering and in private modes. */
export function readStoredFlag(key: string, on: string) {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(key) === on;
  } catch {
    return false;
  }
}

export function storeFlag(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

const TOOLS_KEY = "arch-viewer-tools";

/** Top-right card: time of day, cut, labels, fullscreen and "Mehr". Collapses toward the right edge. */
export function ToolsCard({
  viewer,
  state,
  actions,
  labelsHidden,
  onToggleLabels,
  hidden = false,
}: {
  viewer: ViewerInstance;
  state: ViewerState;
  actions: ViewerActions;
  labelsHidden: boolean;
  onToggleLabels: () => void;
  /** Out of the way while a side panel covers the right edge; the collapsed state stays as it was. */
  hidden?: boolean;
}) {
  const t = useT();
  const contentId = useId();
  const [collapsed, setCollapsed] = useState(() => readStoredFlag(TOOLS_KEY, "collapsed"));
  const setTools = (next: boolean) => {
    setCollapsed(next);
    storeFlag(TOOLS_KEY, next ? "collapsed" : "open");
  };
  const labelsLabel = labelsHidden ? t.viewer.showLabels : t.viewer.hideLabels;
  return (
    <div
      inert={hidden}
      aria-hidden={hidden || undefined}
      className={cn(
        "max-w-full shrink-0 transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none",
        hidden ? "pointer-events-none translate-x-3 opacity-0" : "translate-x-0 opacity-100",
      )}
    >
      <div
        className={cn(
          "pointer-events-auto relative grid max-w-full shrink-0 origin-right grid-cols-1 overflow-hidden bg-popover text-popover-foreground shadow-overlay transition-[width,height,border-radius] duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] [interpolate-size:allow-keywords] motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300",
          collapsed ? "size-11 rounded-[22px]" : "h-auto w-fit rounded-[20px]",
        )}
      >
        <div
          id={contentId}
          role="toolbar"
          aria-label={t.viewer.tools}
          inert={collapsed}
          aria-hidden={collapsed || undefined}
          className={cn(
            "col-start-1 row-start-1 flex min-w-0 items-center gap-1 p-2 transition-[opacity,filter,scale] duration-200 ease-out",
            collapsed ? "pointer-events-none scale-[0.96] opacity-0 blur-xs" : "blur-none scale-100 opacity-100",
          )}
        >
          <Hint label={t.viewer.hideTools}>
            <button
              type="button"
              aria-label={t.viewer.hideTools}
              aria-expanded="true"
              aria-controls={contentId}
              className={pillIcon}
              onClick={() => setTools(true)}
            >
              <ChevronRightIcon aria-hidden="true" />
            </button>
          </Hint>
          <div className="hidden items-center @xl:flex">
            <TimeControl state={state} actions={actions} className="w-52 pr-1" />
          </div>
          <DayNightButton state={state} actions={actions} className="@xl:hidden" />
          <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
          <Hint label={t.viewer.cut} keys="C">
            <button
              type="button"
              aria-label={t.viewer.cut}
              aria-pressed={state.mode === "dollhouse" && state.cut}
              className={cn(pillIcon, "@max-md:hidden")}
              onClick={actions.toggleCut}
            >
              <ScissorsIcon />
            </button>
          </Hint>
          <Hint label={labelsLabel}>
            <button type="button" aria-label={t.viewer.hideLabels} aria-pressed={labelsHidden} className={pillIcon} onClick={onToggleLabels}>
              <TagIcon />
            </button>
          </Hint>
          <FullscreenButton />
          <MoreMenu viewer={viewer} state={state} actions={actions} />
        </div>
        <button
          type="button"
          inert={!collapsed}
          aria-label={t.viewer.showTools}
          aria-expanded="false"
          aria-controls={contentId}
          className={cn(
            "absolute inset-0 grid place-items-center rounded-[22px] text-muted-foreground outline-none transition-[opacity,filter,scale,color] duration-200 ease-out hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&_svg]:size-4",
            collapsed ? "scale-100 opacity-100 blur-none delay-120" : "pointer-events-none scale-[0.25] opacity-0 blur-xs",
          )}
          onClick={() => setTools(false)}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

const swapIcon =
  "col-start-1 row-start-1 transition-[opacity,scale,filter] duration-200 ease-out motion-reduce:transition-none";

/** Sun by day, moon at night; a click jumps to the evening or back to the time it left. */
function DayNightButton({ state, actions, className }: { state: ViewerState; actions: ViewerActions; className?: string }) {
  const t = useT();
  const label = state.night ? t.viewer.toDay : t.viewer.toNight;
  return (
    <Hint label={label} keys="L">
      <button type="button" aria-label={label} className={cn(pillIcon, "grid place-items-center", className)} onClick={actions.toggleNight}>
        <SunIcon aria-hidden="true" className={cn(swapIcon, state.night && "scale-25 opacity-0 blur-[2px]")} />
        <MoonIcon aria-hidden="true" className={cn(swapIcon, !state.night && "scale-25 opacity-0 blur-[2px]")} />
      </button>
    </Hint>
  );
}

function TimeControl({ state, actions, className }: { state: ViewerState; actions: ViewerActions; className?: string }) {
  const t = useT();
  const clock = clockLabel(state.time);
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <DayNightButton state={state} actions={actions} />
      <Slider
        min={0}
        max={TIME_STEPS - 1}
        step={1}
        value={Math.round(state.time * TIME_STEPS)}
        onValueChange={(value) => actions.setTime((value as number) / TIME_STEPS)}
        getAriaLabel={() => t.viewer.timeOfDay}
        getAriaValueText={() => t.viewer.clock(clock)}
        className="min-w-0 flex-1 pointer-coarse:py-3 [&_[data-slot=slider-track]]:bg-foreground/12"
      />
      <span className="ml-1 w-9 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{clock}</span>
    </div>
  );
}

function MoreMenu({ viewer, state, actions }: { viewer: ViewerInstance; state: ViewerState; actions: ViewerActions }) {
  const isMobile = useIsMobile();
  const t = useT();
  const [open, setOpen] = useState(false);
  const trigger = (
    <button type="button" aria-label={t.viewer.more} className={pillIcon}>
      <EllipsisIcon />
    </button>
  );
  if (isMobile) {
    return (
      <>
        <button type="button" aria-label={t.viewer.more} className={pillIcon} onClick={() => setOpen(true)}>
          <EllipsisIcon />
        </button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            showCloseButton={false}
            className="gap-0 rounded-t-2xl px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
          >
            <SheetTitle className="sr-only">{t.viewer.moreTitle}</SheetTitle>
            <SheetDescription className="sr-only">{t.viewer.moreDescription}</SheetDescription>
            <MorePanel viewer={viewer} state={state} actions={actions} touch onRoom={() => setOpen(false)} />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent side="top" align="end" sideOffset={10} className="w-72 gap-0 rounded-xl p-1.5">
        <MorePanel viewer={viewer} state={state} actions={actions} />
      </PopoverContent>
    </Popover>
  );
}

const rowHeight = "min-h-9 pointer-coarse:min-h-11 in-data-[touch]:min-h-11";

function PanelRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex items-center gap-3 px-2 text-ui", rowHeight, className)}>{children}</div>;
}

function PanelHeading({ children }: { children: ReactNode }) {
  return <p className="px-2 pt-2.5 pb-1 text-2xs font-medium text-muted-foreground">{children}</p>;
}

function MorePanel({
  viewer,
  state,
  actions,
  touch = false,
  onRoom,
}: {
  viewer: ViewerInstance;
  state: ViewerState;
  actions: ViewerActions;
  /** Phone sheet: taller rows, no keyboard hints. */
  touch?: boolean;
  onRoom?: () => void;
}) {
  const id = useId();
  const t = useT();
  const format = useFormat();
  const rooms = useMemo(() => viewer.rooms(), [viewer]);
  const fullscreen = useFullscreen();
  const keys = !touch;
  return (
    <div data-touch={touch || undefined} className="flex flex-col">
      <PanelRow>
        <label htmlFor={`${id}-cut`} className="flex-1">
          {t.viewer.cut}
        </label>
        {keys && <Kbd className="pointer-coarse:hidden">C</Kbd>}
        <Switch
          id={`${id}-cut`}
          checked={state.mode === "dollhouse" && state.cut}
          onCheckedChange={actions.toggleCut}
        />
      </PanelRow>
      <PanelRow>
        <span className="w-20 shrink-0">{t.viewer.timeOfDay}</span>
        <TimeControl state={state} actions={actions} className="flex-1" />
      </PanelRow>
      {canFullscreen() && (
        <PanelRow className="p-0">
          <button
            type="button"
            className={cn(
              "flex flex-1 items-center gap-3 rounded-lg px-2 text-left outline-none transition-[background-color] duration-150 ease-out hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring",
              rowHeight,
            )}
            onClick={toggleFullscreen}
          >
            <span className="flex-1">{fullscreen ? t.viewer.exitFullscreen : t.viewer.fullscreen}</span>
            {keys && <Kbd className="pointer-coarse:hidden">F</Kbd>}
            {fullscreen ? <MinimizeIcon className="size-4 text-muted-foreground" /> : <MaximizeIcon className="size-4 text-muted-foreground" />}
          </button>
        </PanelRow>
      )}

      <PanelHeading>{t.viewer.rooms}</PanelHeading>
      <ul aria-label={t.viewer.rooms} className="flex flex-col">
        {rooms.map((room) => (
          <li key={room.id}>
            <button
              type="button"
              aria-pressed={state.room === room.id}
              className="flex min-h-8 w-full items-center gap-3 rounded-lg px-2 text-left text-ui outline-none transition-[background-color] duration-150 ease-out hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-foreground/8 pointer-coarse:min-h-11 in-data-[touch]:min-h-11"
              onClick={() => {
                actions.focusRoom(room.id);
                onRoom?.();
              }}
            >
              <span className="min-w-0 flex-1 truncate">{room.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{format.area(room.area)}</span>
            </button>
          </li>
        ))}
      </ul>

      <div className={cn("pointer-coarse:hidden", !keys && "hidden")}>
        <PanelHeading>{t.viewer.shortcutsHeading}</PanelHeading>
        <dl className="px-2 pb-1.5">
          {VIEWER_SHORTCUTS.map((item) => (
            <div key={item.id} className="flex h-7 items-center justify-between gap-3 text-xs text-muted-foreground">
              <dt className="truncate">{t.viewer.shortcuts[item.id]}</dt>
              <dd className="flex shrink-0 gap-1">
                {item.keys.flat().map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/** Quiet room name and area: during the tour, and in walk mode for the room the visitor stands in. */
export function RoomLabel({ viewer, state }: { viewer: ViewerInstance; state: ViewerState }) {
  const format = useFormat();
  const rooms = useMemo(() => viewer.rooms(), [viewer]);
  const { tour } = state;
  const touring = state.mode === "dollhouse" && (tour.status === "playing" || tour.status === "paused");
  const walking = state.mode === "walk" ? rooms.find((r) => r.id === state.room) : undefined;
  const name = touring ? tour.roomName : walking?.name;
  const area = touring ? tour.roomArea : walking?.area;

  return (
    <div aria-live="polite" className="pointer-events-none">
      {name && (
        <div className="overflow-hidden rounded-lg bg-popover shadow-popover">
          <p className="flex items-baseline gap-2 px-3 py-1.5 text-ui">
            <span className="font-medium text-foreground">{name}</span>
            {area !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{format.area(area)}</span>}
          </p>
          {touring && (
            <div aria-hidden="true" className="h-0.5 bg-foreground/8">
              <div
                className="h-full origin-left bg-foreground/50 transition-transform duration-150 ease-linear"
                style={{ transform: `scaleX(${tour.progress})` }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const HINT_KEY = "arch-walk-hint";

// Embedded on a buyer's site, storage can be blocked outright (Safari, strict privacy settings).
function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    // The hint then shows again next visit.
  }
}

/** One-time walk help, shown the first time someone enters walk mode. */
export function WalkHint({ state }: { state: ViewerState }) {
  const [seen, setSeen] = useState(() => readFlag(HINT_KEY));
  if (seen || state.mode !== "walk") return null;
  const dismiss = () => {
    writeFlag(HINT_KEY);
    setSeen(true);
  };
  return <WalkHintCard onDismiss={dismiss} />;
}

function WalkHintCard({ onDismiss }: { onDismiss: () => void }) {
  const touch = matchMedia("(pointer: coarse)").matches;
  const hint = useT().viewer.walkHint;
  useMountEffect(() => {
    const timer = setTimeout(onDismiss, 7000);
    const onKey = (event: KeyboardEvent) => {
      if (/^(Key[WASD]|Arrow)/.test(event.code)) onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
    };
  });
  return (
    <p className="pointer-events-none flex items-center gap-2 rounded-lg bg-popover px-3 py-1.5 text-xs text-muted-foreground shadow-popover motion-safe:animate-in motion-safe:fade-in-0">
      {touch ? (
        hint.touch
      ) : (
        <>
          <span className="flex gap-0.5">
            {["W", "A", "S", "D"].map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
          {hint.move} · {hint.look} ·<Kbd>Esc</Kbd>
          {hint.release}
        </>
      )}
    </p>
  );
}

export function FullscreenButton({ className }: { className?: string }) {
  const fullscreen = useFullscreen();
  const t = useT();
  if (!canFullscreen()) return null;
  const label = fullscreen ? t.viewer.exitFullscreen : t.viewer.fullscreen;
  return (
    <Hint label={label} keys="F">
      <button
        type="button"
        aria-label={label}
        className={cn(pillIcon, className)}
        onClick={toggleFullscreen}
      >
        {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
      </button>
    </Hint>
  );
}

export function ViewerHotkeys({ actions }: { actions: ViewerActions }) {
  const on = (run: () => void) => (event: KeyboardEvent) => {
    if (!insideOverlay(event)) run();
  };
  useHotkey("1", on(() => actions.setMode("plan")));
  useHotkey("2", on(() => actions.setMode("dollhouse")));
  useHotkey("3", on(() => actions.setMode("walk")));
  useHotkey("t", on(actions.toggleTour));
  useHotkey("l", on(actions.toggleNight));
  useHotkey("c", on(actions.toggleCut));
  useHotkey("[", on(() => actions.nudgeTime(-1)));
  useHotkey("]", on(() => actions.nudgeTime(1)));
  useHotkey("f", on(() => canFullscreen() && toggleFullscreen()));
  return null;
}
