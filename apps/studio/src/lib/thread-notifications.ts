import type { StudioThread } from "./model";
import type { studioText } from "./messages";
import { threadTitle } from "./thread-title";

// Ported in spirit from T3 Code's ThreadNotificationCoordinator (apps/web, MIT):
// rounds take minutes, so Studio calls you back when you are in another app.

/** Browsers ask once, on the click that starts the first round. The desktop app is already allowed. */
export function requestThreadNotifications() {
  if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
}

/** A system notification for each conversation that finished, failed or needs the person while Studio was in the background. */
export function notifyThreadOutcomes(previous: StudioThread[] | undefined, next: StudioThread[], t: typeof studioText.en, open: (thread: StudioThread) => void) {
  if (!previous || typeof Notification === "undefined" || Notification.permission !== "granted" || document.hasFocus()) return;
  for (const thread of next) {
    const before = previous.find(item => item.id === thread.id)?.status;
    if (!before || before === thread.status) continue;
    const body = thread.status === "waiting" ? t.notifyWaiting
      : before !== "working" && before !== "waiting" ? null
      : thread.status === "failed" ? t.notifyFailed : t.notifyDone;
    if (!body) continue;
    const notification = new Notification(`${thread.projectName} · ${threadTitle(thread.title, t)}`, {body, tag: thread.id});
    notification.onclick = () => {window.focus(); open(thread);};
  }
}
