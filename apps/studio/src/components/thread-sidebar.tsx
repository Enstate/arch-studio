import { threadTitle } from "../lib/thread-title";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from "@arch/ui/components/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@arch/ui/components/popover";
import { cn } from "@arch/ui/lib/utils";
import { AlarmClockIcon, AlarmClockOffIcon, ArchiveRestoreIcon, CheckIcon, ChevronDownIcon, CircleCheckIcon, CircleDashedIcon, Undo2Icon } from "lucide-react";
import { type MouseEvent, type ReactNode, useState } from "react";
import type { StudioThread } from "../lib/model";
import type { studioText } from "../lib/messages";
import { type StudioFormat, relativeTime, useStudioFormat } from "../lib/locale";
import { ClaudeIcon, OpenAIIcon } from "./model-picker";

// Ported from T3 Code's SidebarV2, Sidebar.logic, Sidebar.snooze and threadSettled
// (apps/web/src/components and packages/client-runtime, MIT).

type Copy = typeof studioText.en;
const autoSettleDays = 3;
const time = (value: string | null | undefined) => value ? Date.parse(value) : 0;
const lastActivity = (thread: StudioThread) => Math.max(time(thread.latestRequestAt), time(thread.latestCompletedAt), time(thread.createdAt));

/** A snoozed thread wakes early when it needs the user: an approval, a failure or a finished round. */
function wokeAt(thread: StudioThread) {
  if (!thread.snoozedAt) return null;
  if (thread.status === "waiting") return Date.now();
  return time(thread.latestCompletedAt) > time(thread.snoozedAt) ? time(thread.latestCompletedAt) : null;
}
export function threadSnoozed(thread: StudioThread, now: number) {
  return time(thread.snoozedUntil) > now && wokeAt(thread) === null;
}
export function threadSettled(thread: StudioThread, now: number) {
  if (thread.status === "waiting" || thread.status === "working") return false;
  if (thread.settledOverride === "settled") return true;
  if (thread.settledOverride === "active") return false;
  return now - lastActivity(thread) > autoSettleDays * 24 * 60 * 60 * 1000;
}
function threadUnread(thread: StudioThread) {
  return !!thread.latestCompletedAt && !!thread.lastVisitedAt && time(thread.latestCompletedAt) > time(thread.lastVisitedAt);
}
function threadWoke(thread: StudioThread) {
  const woke = wokeAt(thread);
  return woke !== null && time(thread.snoozedUntil) > 0 && (!thread.lastVisitedAt || time(thread.lastVisitedAt) < woke);
}

function duration(since: string | null, now: number, format: StudioFormat) {
  const seconds = Math.max(0, Math.floor((now - time(since)) / 1000));
  if (seconds < 60) return format.duration(seconds, "second");
  if (seconds < 3600) return format.duration(Math.floor(seconds / 60), "minute");
  return `${format.duration(Math.floor(seconds / 3600), "hour")} ${format.duration(Math.floor((seconds % 3600) / 60), "minute")}`;
}

/** Snooze presets from T3 Code: an hour, this evening, tomorrow morning, next Monday. */
export function snoozePresets(t: Copy, now = new Date()) {
  const at = (date: Date, hours: number) => {const next = new Date(date); next.setHours(hours, 0, 0, 0); return next;};
  const presets = [{label: t.snoozeHour, until: new Date(now.getTime() + 60 * 60 * 1000)}];
  const evening = at(now, 18);
  if (evening.getTime() - now.getTime() > 60 * 60 * 1000) presets.push({label: t.snoozeEvening, until: evening});
  const tomorrow = at(new Date(now.getTime() + 24 * 60 * 60 * 1000), 9);
  presets.push({label: t.snoozeTomorrow, until: tomorrow});
  const monday = at(now, 9);
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7));
  presets.push({label: t.snoozeNextWeek, until: monday});
  return presets;
}

const badgeColors = ["bg-sky-500/80", "bg-emerald-500/80", "bg-amber-500/80", "bg-violet-500/80", "bg-rose-500/80", "bg-teal-500/80", "bg-orange-500/80", "bg-indigo-500/80"];
/** Two letters and a stable color per project, where T3 Code shows a favicon. */
export function ProjectBadge({name, className}: {name: string; className?: string}) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : name.slice(0, 2)).toUpperCase();
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return <span aria-hidden="true" className={cn("inline-grid size-4 shrink-0 place-items-center rounded-[4px] text-[7.5px] font-semibold leading-none text-white", badgeColors[hash % badgeColors.length], className)}>{letters}</span>;
}
function ProviderMark({thread}: {thread: StudioThread}) {
  if (!thread.provider) return null;
  const Icon = thread.provider === "claude" ? ClaudeIcon : OpenAIIcon;
  return <span className="inline-flex shrink-0 items-center opacity-60" title={thread.model ?? undefined}><Icon className="size-3.5" /></span>;
}

export type ThreadActionHandler = (thread: StudioThread, action: {kind: "rename"; title: string} | {kind: "settle"} | {kind: "unsettle"} | {kind: "snooze"; until: string} | {kind: "unsnooze"} | {kind: "unread"} | {kind: "archive"} | {kind: "unarchive"} | {kind: "newThread"}) => void;

/** Live threads as cards, then Snoozed, Settled and Archived shelves, across every project. */
export function ThreadList({threads, archived, selectedId, select, act, now, t}: {threads: StudioThread[]; archived: StudioThread[]; selectedId?: string; select: (thread: StudioThread) => void; act: ThreadActionHandler; now: number; t: Copy}) {
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [settledOpen, setSettledOpen] = useState(true);
  const [settledLimit, setSettledLimit] = useState(10);
  const snoozed = threads.filter(thread => threadSnoozed(thread, now)).sort((a, b) => time(a.snoozedUntil) - time(b.snoozedUntil));
  const settled = threads.filter(thread => !threadSnoozed(thread, now) && threadSettled(thread, now)).sort((a, b) => (time(b.settledAt) || lastActivity(b)) - (time(a.settledAt) || lastActivity(a)));
  const active = threads.filter(thread => !snoozed.includes(thread) && !settled.includes(thread)).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  // A collapsed shelf still shows the thread you are on.
  const shelf = (items: StudioThread[], open: boolean) => open ? items : items.filter(thread => thread.id === selectedId);
  const visibleSettled = shelf(settled, settledOpen);
  return <div className="flex flex-col">
    <ul className="flex flex-col gap-px">{active.map(thread => <ThreadCard key={thread.id} thread={thread} selected={thread.id === selectedId} select={select} act={act} now={now} t={t} />)}</ul>
    {!!snoozed.length && <>
      <ShelfHeader label={snoozedOpen ? t.snoozed : `${t.snoozed} (${snoozed.length})`} open={snoozedOpen} toggle={() => setSnoozedOpen(value => !value)} tone="blue" />
      <ul className="flex flex-col gap-px">{shelf(snoozed, snoozedOpen).map(thread => <SlimRow key={thread.id} thread={thread} selected={thread.id === selectedId} select={select} act={act} now={now} t={t} kind="snoozed" />)}</ul>
    </>}
    {!!settled.length && <>
      <ShelfHeader label={settledOpen ? t.settled : `${t.settled} (${settled.length})`} open={settledOpen} toggle={() => setSettledOpen(value => !value)} tone="muted" />
      <ul className="flex flex-col gap-px">{(settledOpen ? visibleSettled.slice(0, settledLimit) : visibleSettled).map(thread => <SlimRow key={thread.id} thread={thread} selected={thread.id === selectedId} select={select} act={act} now={now} t={t} kind="settled" />)}</ul>
      {settledOpen && settled.length > settledLimit && <button type="button" className="mt-1 px-2.5 text-left text-xs text-muted-foreground hover:text-foreground" onClick={() => setSettledLimit(limit => limit + 25)}>{t.showMore.replace("{count}", String(Math.min(25, settled.length - settledLimit)))}</button>}
    </>}
    {!!archived.length && <>
      <ShelfHeader label={archivedOpen ? t.archivedThreads : `${t.archivedThreads} (${archived.length})`} open={archivedOpen} toggle={() => setArchivedOpen(value => !value)} tone="muted" />
      {archivedOpen && <ul className="flex flex-col gap-px">{[...archived].sort((a, b) => time(b.archivedAt) - time(a.archivedAt)).map(thread => <ArchivedRow key={thread.id} thread={thread} act={act} now={now} t={t} />)}</ul>}
    </>}
  </div>;
}

function ShelfHeader({label, open, toggle, tone}: {label: string; open: boolean; toggle: () => void; tone: "blue" | "muted"}) {
  return <button type="button" aria-expanded={open} onClick={toggle} className="mt-3 mb-1 flex w-full cursor-pointer items-center gap-2 px-2.5 text-left">
    <span className={cn("text-xs font-medium", tone === "blue" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/50")}>{label}</span>
    <span className={cn("h-px flex-1", tone === "blue" ? "bg-blue-500/20 dark:bg-blue-400/15" : "bg-border/60")} />
    <ChevronDownIcon className={cn("size-3 text-muted-foreground/60 transition-transform", open && "rotate-180")} />
  </button>;
}

function rowSurface(selected: boolean, receded: boolean) {
  return cn("group/v2-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none focus-visible:ring-1 focus-visible:ring-ring/50", selected ? "bg-foreground/9" : receded ? "text-muted-foreground/75 hover:bg-foreground/5" : "bg-transparent hover:bg-foreground/5");
}

function ThreadMenu({thread, act, rename, t, children}: {thread: StudioThread; act: ThreadActionHandler; rename: () => void; t: Copy; children: ReactNode}) {
  const settled = thread.settledOverride === "settled";
  const snoozed = time(thread.snoozedUntil) > Date.now();
  return <ContextMenu>
    <ContextMenuTrigger render={<div />}>{children}</ContextMenuTrigger>
    <ContextMenuContent className="w-56">
      <ContextMenuItem onClick={() => act(thread, {kind: "newThread"})}>{t.newThreadOnBranch.replace("{branch}", thread.branch)}</ContextMenuItem>
      <ContextMenuSeparator />
      {settled ? <ContextMenuItem onClick={() => act(thread, {kind: "unsettle"})}>{t.unsettleThread}</ContextMenuItem> : <ContextMenuItem onClick={() => act(thread, {kind: "settle"})}>{t.settleThread}</ContextMenuItem>}
      {snoozed ? <ContextMenuItem onClick={() => act(thread, {kind: "unsnooze"})}>{t.wakeThread}</ContextMenuItem>
        : <ContextMenuSub><ContextMenuSubTrigger disabled={thread.status === "waiting"}>{t.snooze}</ContextMenuSubTrigger><ContextMenuSubContent>{snoozePresets(t).map(preset => <ContextMenuItem key={preset.label} onClick={() => act(thread, {kind: "snooze", until: preset.until.toISOString()})}>{preset.label}</ContextMenuItem>)}</ContextMenuSubContent></ContextMenuSub>}
      <ContextMenuItem onClick={rename}>{t.renameThread}</ContextMenuItem>
      <ContextMenuItem onClick={() => act(thread, {kind: "unread"})}>{t.markUnread}</ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={thread.status === "working" || thread.status === "waiting"} onClick={() => act(thread, {kind: "archive"})}>{t.archiveThread}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>;
}

function SnoozeButton({thread, act, t}: {thread: StudioThread; act: ThreadActionHandler; t: Copy}) {
  const format = useStudioFormat();
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button type="button" aria-label={t.snooze} title={t.snooze} onClick={(event: MouseEvent) => event.stopPropagation()} className="grid h-5 w-6 place-items-center rounded text-muted-foreground hover:bg-foreground/8 hover:text-foreground" />}><AlarmClockIcon className="size-3.5" /></PopoverTrigger>
    <PopoverContent align="end" className="w-48 gap-0 p-1" onClick={(event: MouseEvent) => event.stopPropagation()}>
      {snoozePresets(t).map(preset => <button type="button" key={preset.label} className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-ui hover:bg-accent" onClick={() => {setOpen(false); act(thread, {kind: "snooze", until: preset.until.toISOString()});}}><span>{preset.label}</span><span className="text-xs text-muted-foreground">{format.date(preset.until, {weekday: "short", hour: "numeric"})}</span></button>)}
    </PopoverContent>
  </Popover>;
}

/** Inline rename, as in T3 Code: Enter or leaving the field saves, Escape cancels, empty is ignored. */
function TitleEditor({thread, act, done, className, t}: {thread: StudioThread; act: ThreadActionHandler; done: () => void; className?: string; t: Copy}) {
  const commit = (value: string) => {const title = value.trim(); if (title && title !== threadTitle(thread.title, t)) act(thread, {kind: "rename", title}); done();};
  return <input ref={node => {if (node && document.activeElement !== node) {node.focus(); node.select();}}} defaultValue={threadTitle(thread.title, t)} aria-label={t.renameThread} maxLength={120} onClick={event => event.stopPropagation()} onKeyDown={event => {event.stopPropagation(); if (event.key === "Enter") commit(event.currentTarget.value); if (event.key === "Escape") done();}} onBlur={event => commit(event.currentTarget.value)} className={cn("min-w-0 flex-1 rounded-sm bg-background px-1 outline-none ring-1 ring-ring/60", className)} />;
}

function ThreadCard({thread, selected, select, act, now, t}: {thread: StudioThread; selected: boolean; select: (thread: StudioThread) => void; act: ThreadActionHandler; now: number; t: Copy}) {
  const format = useStudioFormat();
  const [editing, setEditing] = useState(false);
  const unread = !selected && threadUnread(thread);
  const woke = !selected && threadWoke(thread);
  const inFlight = thread.status === "working";
  const receded = !unread && !woke && thread.status !== "waiting" && thread.status !== "failed";
  const status = thread.status === "waiting" ? <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300">{t.statusWaiting}</span>
    : thread.status === "working" ? <span className="inline-flex items-center gap-1 font-medium text-sky-600 dark:text-sky-400"><CircleDashedIcon className="size-3.5" />{t.statusWorking} <span className="font-mono tabular-nums">{duration(thread.workingSince, now, format)}</span></span>
    : thread.status === "failed" ? <span className="inline-flex items-center gap-1 font-medium text-red-700 dark:text-red-300">{t.statusFailed}</span>
    : woke ? <span className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-300"><AlarmClockIcon className="size-3.5" />{t.statusWoke}</span>
    : unread ? <span className="inline-flex items-center gap-1 font-medium text-emerald-700 dark:text-emerald-300"><CircleCheckIcon className="size-3.5" />{t.statusDone}</span>
    : null;
  return <li className="list-none py-0.5" data-studio-thread={thread.id}>
    <ThreadMenu thread={thread} act={act} rename={() => setEditing(true)} t={t}>
{/* biome-ignore lint/a11y/useSemanticElements: the card holds its own Snooze and Settle buttons, which cannot nest inside a button. */}
      <div role="button" tabIndex={0} aria-current={selected ? "page" : undefined} aria-label={`${threadTitle(thread.title, t)}, ${thread.projectName}`} onClick={() => select(thread)} onKeyDown={event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); select(thread);}}}
        className={cn(rowSurface(selected, receded), inFlight && !selected && "opacity-70 transition-opacity hover:opacity-100")}>
        <div className="relative z-10 h-[4.875rem] px-2.5 py-2">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <ProjectBadge name={thread.projectName} />
            <span className={cn("min-w-0 flex-1 truncate text-xs text-muted-foreground/85", unread || woke ? "font-medium" : "font-normal")} title={`${thread.clientName} · ${thread.projectName}`}>{thread.projectName}</span>
            <span className="group/v2-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
              <span className="self-center tabular-nums text-muted-foreground/65 transition-opacity group-hover/v2-row:absolute group-hover/v2-row:right-0 group-hover/v2-row:opacity-0">{status ?? relativeTime(lastActivity(thread), now, format)}</span>
              <span className="absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:static focus-within:opacity-100 group-hover/v2-row:static group-hover/v2-row:opacity-100">
                {thread.status !== "waiting" && <SnoozeButton thread={thread} act={act} t={t} />}
                <button type="button" onClick={event => {event.stopPropagation(); act(thread, {kind: "settle"});}} disabled={thread.status === "working" || thread.status === "waiting"} className="inline-flex h-5 items-center gap-1 rounded px-1.5 text-muted-foreground hover:bg-foreground/8 hover:text-foreground disabled:opacity-40"><CheckIcon className="size-3.5" />{t.settle}</button>
              </span>
            </span>
          </div>
          <div className="mt-1 flex min-w-0">{editing ? <TitleEditor t={t} thread={thread} act={act} done={() => setEditing(false)} className="text-sm font-medium" /> : <>{/* biome-ignore lint/a11y/noStaticElementInteractions: double-click rename is a shortcut; keyboard users rename from the thread menu. */}<span onDoubleClick={event => {event.stopPropagation(); setEditing(true);}} className={cn("min-w-0 flex-1 truncate text-sm font-medium", unread || woke ? "text-foreground" : receded ? "text-muted-foreground/80" : "text-foreground/90")}>{threadTitle(thread.title, t)}</span></>}</div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/75">
            <span className="min-w-0 flex-1 truncate whitespace-nowrap">{thread.branch === "main" ? t.mainDesign : thread.branch}{thread.primary && thread.branch !== "main" && ` · ${t.primaryBranch}`}</span>
            <span className="pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"><ProviderMark thread={thread} /></span>
          </div>
        </div>
      </div>
    </ThreadMenu>
  </li>;
}

function SlimRow({thread, selected, select, act, now, t, kind}: {thread: StudioThread; selected: boolean; select: (thread: StudioThread) => void; act: ThreadActionHandler; now: number; t: Copy; kind: "snoozed" | "settled"}) {
  const format = useStudioFormat();
  const [editing, setEditing] = useState(false);
  return <li className="list-none" data-studio-thread={thread.id}>
    <ThreadMenu thread={thread} act={act} rename={() => setEditing(true)} t={t}>
{/* biome-ignore lint/a11y/useSemanticElements: the card holds its own Snooze and Settle buttons, which cannot nest inside a button. */}
      {/* biome-ignore lint/a11y/useSemanticElements: the row holds its own Wake or Un-settle button, which cannot nest inside a button. */}
      <div role="button" tabIndex={0} aria-current={selected ? "page" : undefined} aria-label={`${threadTitle(thread.title, t)}, ${thread.projectName}`} onClick={() => select(thread)} onKeyDown={event => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); select(thread);}}}
        className={cn(rowSurface(selected, true), "flex h-9 items-center gap-2.5 px-2.5")}>
        <ProjectBadge name={thread.projectName} className="opacity-40 grayscale group-hover/v2-row:opacity-100 group-hover/v2-row:grayscale-0" />
        {editing ? <TitleEditor t={t} thread={thread} act={act} done={() => setEditing(false)} className="text-sm" /> : <>{/* biome-ignore lint/a11y/noStaticElementInteractions: double-click rename is a shortcut; keyboard users rename from the thread menu. */}<span onDoubleClick={event => {event.stopPropagation(); setEditing(true);}} className="min-w-0 flex-1 truncate text-sm">{threadTitle(thread.title, t)}</span></>}
        <span className="relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end text-xs">
          <span className={cn("tabular-nums transition-opacity group-hover/v2-row:opacity-0", kind === "snoozed" ? "text-blue-600 dark:text-blue-400" : "text-muted-foreground/65")}>{kind === "snoozed" ? relativeTime(time(thread.snoozedUntil), now, format) : relativeTime(time(thread.settledAt) || lastActivity(thread), now, format)}</span>
          <button type="button" aria-label={kind === "snoozed" ? t.wakeThread : t.unsettleThread} title={kind === "snoozed" ? t.wakeThread : t.unsettleThread} onClick={event => {event.stopPropagation(); act(thread, {kind: kind === "snoozed" ? "unsnooze" : "unsettle"});}} className="absolute inset-y-0 right-0 grid w-7 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground group-hover/v2-row:opacity-100">{kind === "snoozed" ? <AlarmClockOffIcon className="size-3.5" /> : <Undo2Icon className="size-3.5" />}</button>
        </span>
      </div>
    </ThreadMenu>
  </li>;
}

/** An archived conversation can only be restored; it opens again from the live list. */
function ArchivedRow({thread, act, now, t}: {thread: StudioThread; act: ThreadActionHandler; now: number; t: Copy}) {
  const format = useStudioFormat();
  return <li className="group/v2-row flex h-9 list-none items-center gap-2.5 rounded-md px-2.5 text-muted-foreground/75 hover:bg-foreground/5" data-studio-thread={thread.id}>
    <ProjectBadge name={thread.projectName} className="opacity-40 grayscale" />
    <span className="min-w-0 flex-1 truncate text-sm" title={`${thread.projectName} · ${threadTitle(thread.title, t)}`}>{threadTitle(thread.title, t)}</span>
    <span className="relative flex h-6 shrink-0 items-center justify-end text-xs">
      <span className="tabular-nums text-muted-foreground/65 transition-opacity group-focus-within/v2-row:opacity-0 group-hover/v2-row:opacity-0">{relativeTime(time(thread.archivedAt), now, format)}</span>
      <button type="button" aria-label={`${t.unarchive}: ${threadTitle(thread.title, t)}`} onClick={() => act(thread, {kind: "unarchive"})} className="absolute inset-y-0 right-0 inline-flex items-center gap-1 rounded px-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 group-hover/v2-row:opacity-100"><ArchiveRestoreIcon className="size-3.5" />{t.unarchive}</button>
    </span>
  </li>;
}
