export type DesktopUpdate = {
  currentVersion: string;
  status: "disabled" | "idle" | "checking" | "available" | "up-to-date" | "downloading" | "downloaded" | "installing" | "error";
  version?: string;
  percent?: number;
  message?: string;
  operation?: "check" | "download" | "install";
};

/** Claude Code installation and sign-in run by the desktop app. */
export type AgentSetup = {
  provider: "claude";
  status: "idle" | "installing" | "installed" | "install-failed" | "signing-in" | "waiting-for-code" | "signed-in" | "sign-in-failed" | "terminal";
  /** The installer's latest output lines while it runs or after it fails. */
  lines: string[];
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
  /** Claude Code setup. Optional for builds that predate it. Each call resolves when its step ends. */
  getAgentSetup?(): Promise<AgentSetup>;
  installAgent?(provider: "claude"): Promise<AgentSetup>;
  signInAgent?(provider: "claude"): Promise<AgentSetup>;
  submitAgentSignInCode?(code: string): Promise<AgentSetup>;
  /** Opens the waiting sign-in page again, for when the browser didn't show it. */
  openAgentSignInPage?(): Promise<AgentSetup>;
  cancelAgentSignIn?(): Promise<AgentSetup>;
  onAgentSetup?(listener: (state: AgentSetup) => void): () => void;
}

declare global {
  interface Window { archDesktop?: DesktopBridge }
}
