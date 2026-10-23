import { useSyncExternalStore } from "react";

/** A file waiting in the composer. Images carry a blob URL for their thumbnail. */
export type DraftAttachment = {file: File; url: string | null};

// Each conversation keeps its unsent request until it is sent. The text survives restarts in
// localStorage. Files can't be stored there, so attachments last until the page reloads.
const prefix = "arch-draft:";
const draftKey = (projectId: string, threadId: string) => `${prefix}${projectId}:${threadId}`;
const texts = new Map<string, string>();
const attachments = new Map<string, DraftAttachment[]>();
const noAttachments: DraftAttachment[] = [];
const listeners = new Set<() => void>();
const notify = () => {for (const listener of listeners) listener();};
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {listeners.delete(listener);};
}
// Another Studio window edited a draft.
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith(prefix)) {
    if (event.key) texts.delete(event.key); else texts.clear();
    notify();
  }
});

function draftText(key: string) {
  let text = texts.get(key);
  if (text === undefined) {
    try {text = localStorage.getItem(key) ?? "";} catch {text = "";}
    texts.set(key, text);
  }
  return text;
}
function storeText(key: string, text: string) {
  texts.set(key, text);
  // A full or unavailable localStorage still keeps the draft for this session.
  try {if (text) localStorage.setItem(key, text); else localStorage.removeItem(key);} catch {}
}

/** Puts a request in a conversation's composer, such as a suggestion that started it. */
export function saveComposerDraft(projectId: string, threadId: string, text: string) {
  storeText(draftKey(projectId, threadId), text);
  notify();
}

/** Empties a sent draft. Files added while it was sending stay. */
export function clearComposerDraft(projectId: string, threadId: string, sent: readonly DraftAttachment[]) {
  const key = draftKey(projectId, threadId);
  storeText(key, "");
  for (const item of sent) if (item.url) URL.revokeObjectURL(item.url);
  const remaining = (attachments.get(key) ?? []).filter(item => !sent.includes(item));
  if (remaining.length) attachments.set(key, remaining); else attachments.delete(key);
  notify();
}

export function useComposerDraft(projectId: string, threadId: string) {
  const key = draftKey(projectId, threadId);
  const text = useSyncExternalStore(subscribe, () => draftText(key), () => "");
  const files = useSyncExternalStore(subscribe, () => attachments.get(key) ?? noAttachments, () => noAttachments);
  return {
    text,
    files,
    setText: (value: string) => {storeText(key, value); notify();},
    attach: (added: DraftAttachment[]) => {if (added.length) {attachments.set(key, [...(attachments.get(key) ?? []), ...added]); notify();}},
    detach: (item: DraftAttachment) => {
      if (item.url) URL.revokeObjectURL(item.url);
      attachments.set(key, (attachments.get(key) ?? []).filter(other => other !== item));
      notify();
    },
  };
}
export type ComposerDraft = ReturnType<typeof useComposerDraft>;
