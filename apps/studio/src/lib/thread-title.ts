import type { studioText } from "./messages";

/** Default titles stay portable in saved projects and follow the app language on screen. */
export function threadTitle(title: string, t: Pick<typeof studioText.en, "newThread">) {
  return title === "New thread" ? t.newThread : title;
}
