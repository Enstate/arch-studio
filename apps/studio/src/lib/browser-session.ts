export const studioSessionHeader = "X-Arch-Studio-Session";
const storageKey = "arch-studio-session";

export function studioSession() {
  return typeof window === "undefined" ? null : window.sessionStorage.getItem(storageKey);
}

export function rememberStudioSession(secret: string) {
  window.sessionStorage.setItem(storageKey, secret);
}
