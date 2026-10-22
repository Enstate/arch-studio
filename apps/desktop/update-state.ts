export type DesktopUpdate = {
  currentVersion: string;
  status: "disabled" | "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "installing" | "error";
  version?: string;
  percent?: number;
  message?: string;
  operation?: "check" | "download" | "install";
};

export interface DesktopBridge {
  chooseProjectDirectory(): Promise<string | null>;
  getUpdateState(): Promise<DesktopUpdate>;
  checkForUpdate(): Promise<DesktopUpdate>;
  downloadUpdate(): Promise<DesktopUpdate>;
  installUpdate(): Promise<DesktopUpdate>;
  onUpdateState(listener: (state: DesktopUpdate) => void): () => void;
  /** The app menu's Settings item. Optional for builds that predate it. */
  onOpenSettings?(listener: () => void): () => void;
  /** Project files opened from Finder or Explorer, including the one that launched the app. Optional for older builds. */
  onProjectFile?(listener: (path: string) => void): () => void;
}

declare global {
  interface Window { archDesktop?: DesktopBridge }
}
