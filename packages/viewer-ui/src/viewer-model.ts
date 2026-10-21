import { preloadViewer as preload } from "@arch/viewer/preload";
import type { DesignOptionInfo, LevelInfo, RoomInfo, ViewerInstance, ViewerMode, ViewerState } from "@arch/viewer/react";
import { useSyncExternalStore } from "react";

export type { DesignOptionInfo, LevelInfo, RoomInfo, ViewerInstance, ViewerMode, ViewerState };

/** The last design option chosen; a new version of the project opens in the same look. */
const DESIGN_OPTION_KEY = "arch-viewer-design-option";

export function rememberedDesignOption() {
  try {
    return localStorage.getItem(DESIGN_OPTION_KEY);
  } catch {
    return null;
  }
}

const SAMPLE_PLAN_URL = "/viewer/plans/sample-house/plan.json";

/** MOCKED. Only the sample house has a render to use as poster; other plans load without one. */
export const posterFor = (planUrl: string | null) => (planUrl === SAMPLE_PLAN_URL ? "/landing/living-day-1600.webp" : null);

export const ASSET_BASE = "/viewer/library/";

/** Starts loading three.js, the capability check, the library index and the plan without mounting anything. */
export function preloadViewer(planUrl?: string | null, assetBase = ASSET_BASE) {
  preload({ planUrl, assetBase });
}

const noop = () => () => {};

export function useViewerState(viewer: ViewerInstance | null): ViewerState | null {
  return useSyncExternalStore(
    viewer?.subscribe ?? noop,
    () => viewer?.getState() ?? null,
    () => null,
  );
}

export const MODES: { mode: ViewerMode; key: string }[] = [
  { mode: "plan", key: "1" },
  { mode: "dollhouse", key: "2" },
  { mode: "walk", key: "3" },
];

/** The viewer's day runs from 00:00 (t = 0) to 24:00 (t = 1); the slider moves in quarter hours up to 23:45. */
export const TIME_STEPS = 24 * 4;
const LAST_STEP = (TIME_STEPS - 1) / TIME_STEPS;
/** Where the day and night toggle jumps when it has no earlier time to return to. */
const NIGHT_TIME = 21 / 24;
const DAY_TIME = 13 / 24;

export function clockLabel(t: number) {
  const minutes = Math.round(t * TIME_STEPS) * 15;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function subscribeFullscreen(listener: () => void) {
  document.addEventListener("fullscreenchange", listener);
  return () => document.removeEventListener("fullscreenchange", listener);
}

export function useFullscreen() {
  return useSyncExternalStore(
    subscribeFullscreen,
    () => document.fullscreenElement !== null,
    () => false,
  );
}

export const canFullscreen = () => typeof document !== "undefined" && document.fullscreenEnabled;

/** The whole document goes fullscreen, so menus and tooltips portalled to <body> stay visible. */
export function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

/** UI-level commands. Direct steering (mode, room) pauses a running tour, as canvas input does. */
export function viewerActions(viewer: ViewerInstance) {
  const pauseTour = () => {
    if (viewer.getState().tour.status === "playing") viewer.tour.pause();
  };
  const setTime = (t: number) => viewer.setTime(Math.min(LAST_STEP, Math.max(0, t)));
  // The day and night toggle returns to the time it left, so pressing it twice changes nothing.
  let before: { time: number; night: boolean } | null = null;
  return {
    setMode(mode: ViewerMode) {
      pauseTour();
      viewer.setMode(mode);
    },
    toggleTour() {
      const { status } = viewer.getState().tour;
      if (status === "playing") return viewer.tour.pause();
      if (status !== "paused") viewer.setCut(true);
      viewer.tour.play();
    },
    toggleCut() {
      const { mode, cut } = viewer.getState();
      if (mode !== "dollhouse") {
        pauseTour();
        viewer.setMode("dollhouse");
        viewer.setCut(true);
      } else viewer.setCut(!cut);
    },
    setFurniture: (visible: boolean) => viewer.setFurniture(visible),
    setRoof: (visible: boolean) => viewer.setRoof(visible),
    /** Like the cut, the roof belongs to the dollhouse: from another view it opens 3D without the roof. */
    toggleRoof() {
      const { mode, roof } = viewer.getState();
      if (roof === null) return;
      if (mode !== "dollhouse") {
        pauseTour();
        viewer.setMode("dollhouse");
        viewer.setRoof(false);
      } else viewer.setRoof(!roof);
    },
    toggleFurniture: () => viewer.setFurniture(!viewer.getState().furniture),
    toggleNight() {
      const { time, night } = viewer.getState();
      const back = before && before.night !== night ? before.time : night ? DAY_TIME : NIGHT_TIME;
      before = { time, night };
      setTime(back);
    },
    setTime,
    nudgeTime: (hours: number) => setTime(viewer.getState().time + hours / 24),
    focusRoom(id: string) {
      pauseTour();
      viewer.focusRoom(id);
    },
    setLevel(id: string) {
      pauseTour();
      viewer.setLevel(id);
    },
    setDesignOption(id: string) {
      viewer.setDesignOption(id);
      try {
        localStorage.setItem(DESIGN_OPTION_KEY, id);
      } catch {
        // Blocked storage: the choice lasts for this view only.
      }
    },
  };
}

export type ViewerActions = ReturnType<typeof viewerActions>;

/** Keyboard shortcuts of the viewer, for a shortcuts sheet or command palette. */
export const VIEWER_SHORTCUTS = [
  { id: "modes", keys: [["1"], ["2"], ["3"]] },
  { id: "tour", keys: [["T"]] },
  { id: "night", keys: [["L"]] },
  { id: "cut", keys: [["C"]] },
  { id: "roof", keys: [["R"]] },
  { id: "furniture", keys: [["H"]] },
  { id: "time", keys: [["["], ["]"]] },
  { id: "fullscreen", keys: [["F"]] },
  { id: "walk", keys: [["W", "A", "S", "D"]] },
  { id: "fly", keys: [["W", "A", "S", "D", "Q", "E"]] },
  { id: "door", keys: [["E"]] },
] as const;
