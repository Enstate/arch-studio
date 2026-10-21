import type { AgentProvider, AgentProviderStatus } from "@arch/agent";
import { Button } from "@arch/ui/components/button";
import { Spinner } from "@arch/ui/components/spinner";
import { cn } from "@arch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, CheckIcon, PlayIcon, ChevronDownIcon, CircleAlertIcon, EyeIcon, FileTextIcon, GitBranchIcon, GlobeIcon, HammerIcon, ImageIcon, MessageCircleIcon, PaperclipIcon, ScanSearchIcon, SquarePenIcon, TerminalIcon, WrenchIcon, XIcon } from "lucide-react";
import { type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { Dialog, DialogContent, DialogTitle } from "@arch/ui/components/dialog";
import { agentProviders, answerApproval, threadAgent, discardChanges, interruptRound, resumeRound, roundActivity, roundImage, roundTimeline, startRound } from "../lib/server";
import type { RoundActivity, RoundEvent, RoundSummary, StudioBranch, StudioVersion } from "../lib/model";
import type { studioText } from "../lib/messages";
import { type ModelChoice, type ModelSettings, ModelPicker, settingValue, TraitsPicker } from "./model-picker";

// The timeline and composer follow T3 Code's MessagesTimeline and ChatComposer
// (apps/web/src/components/chat, MIT): user bubbles, unboxed agent text and compact tool rows.

type Copy = typeof studioText.en;
type Entry = { kind: "round"; round: RoundSummary; at: string } | { kind: "version"; version: StudioVersion; at: string };
type ApprovalEvent = Extract<RoundEvent, { type: "approval" }>;
type WorkEvent = Extract<RoundEvent, { type: "tool" | "approval-resolved" | "build" | "retry" | "approval" | "image" }>;
type ImageEvent = Extract<RoundEvent, { type: "image" }>;
type Segment = { kind: "work"; events: WorkEvent[] } | { kind: "text"; itemId: string; text: string };

/** Versions reachable from a branch head, newest first. A branch shares its fork point's history. */
export function branchVersions(versions: StudioVersion[], headId: string | null) {
  const byId = new Map(versions.map(version => [version.id, version]));
  const lineage: StudioVersion[] = [];
  for (let current = headId ? byId.get(headId) : undefined; current; current = current.parentId ? byId.get(current.parentId) : undefined) lineage.push(current);
  return lineage;
}

/** One cache entry per round. The server rewrites the newest text event while it streams. */
function useRoundActivity(roundId: string | undefined, live: boolean) {
  const queryClient = useQueryClient();
  const key = ["studio-round-activity", roundId];
  return useQuery({
    queryKey: key,
    enabled: !!roundId,
    staleTime: live ? 0 : Infinity,
    refetchInterval: query => query.state.data?.round.status === "running" ? 1000 : false,
    queryFn: async (): Promise<RoundActivity> => {
      const previous = queryClient.getQueryData<RoundActivity>(key);
      const next = await roundActivity({data: {roundId: roundId!, after: previous ? Math.max(0, previous.events.length - 1) : 0}});
      // Refresh what the finished round changed. Invalidating this query too would cancel
      // this fetch and repeat it against the same stale cache, forever.
      if (previous?.round.status === "running" && next.round.status !== "running") void queryClient.invalidateQueries({predicate: query => query.queryKey[0] !== "studio-round-activity"});
      return previous ? {...next, from: 0, events: [...previous.events.slice(0, next.from), ...next.events]} : next;
    },
  });
}

/** The project's working surface: what was asked, what the agent did and what each round rendered. */
export function Rounds({projectId, threadId, branch, versions, versionLabel, openVersion, compare, forkFrom, ensureGrant, t}: {projectId: string; threadId: string; branch: StudioBranch; versions: StudioVersion[]; versionLabel: (version: StudioVersion) => string; openVersion: (id: string) => void; compare: (base: string, target: string) => void; forkFrom: (checkpointId: string) => void; ensureGrant: (then: () => void) => void; t: Copy}) {
  const timeline = useQuery({queryKey: ["studio-rounds", projectId], queryFn: () => roundTimeline({data: {projectId}}), refetchInterval: query => query.state.data?.some(round => round.status === "running") ? 2000 : 5000});
  const lineage = branchVersions(versions, branch.headId);
  const rounds = (timeline.data ?? []).filter(round => round.threadId === threadId);
  const roundCheckpoints = new Set((timeline.data ?? []).map(round => round.checkpointId));
  // Saved versions without a round came from a manual build, the CLI or an import.
  const entries: Entry[] = [
    ...rounds.map(round => ({kind: "round" as const, round, at: round.startedAt})),
    ...lineage.filter(version => !roundCheckpoints.has(version.id)).map(version => ({kind: "version" as const, version, at: version.createdAt})),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const running = rounds.find(round => round.status === "running");
  const forkPoint = branch.forkedFrom ? versions.find(version => version.id === branch.forkedFrom) : undefined;
  const version = (id: string | null) => versions.find(item => item.id === id);
  // The draft lives here so a critique can become the next request.
  const [draft, setDraft] = useState<{threadId: string; text: string}>({threadId, text: ""});
  const request = draft.threadId === threadId ? draft.text : "";
  const setRequest = (text: string) => setDraft({threadId, text});
  return <div className="flex min-h-0 flex-1 flex-col">
    {/* Reversed flow keeps the newest activity in view while it streams, without scroll effects. */}
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"><div className="mx-auto w-full max-w-3xl px-3 pt-6 pb-4 sm:px-5">
      {forkPoint && <FoldRow><GitBranchIcon className="size-3" />{t.forkedFrom} {versionLabel(forkPoint)}</FoldRow>}
      {!entries.length && !timeline.isPending && <div className="grid gap-1 py-16 text-center text-sm"><p className="text-foreground">{t.roundsEmpty}</p><p className="text-xs text-muted-foreground">{t.roundsEmptyHint}</p></div>}
      {entries.map(entry => entry.kind === "version"
        ? <FoldRow key={entry.version.id}><span className="flex-1">{t.savedVersion} · {versionLabel(entry.version)}</span>{entry.version.hasArtifact && <button type="button" className="hover:text-foreground" onClick={() => openVersion(entry.version.id)}>{t.openModel}</button>}</FoldRow>
        : <RoundTurn key={entry.round.id} projectId={projectId} round={entry.round} resumable={entry.round.id === rounds.at(-1)?.id && !running} ensureGrant={ensureGrant} version={version(entry.round.checkpointId)} branch={branch} label={versionLabel} openVersion={openVersion} compare={compare} forkFrom={forkFrom} revise={text => setRequest(`${t.reviseRequest}\n\n${text}`)} t={t} />)}
    </div></div>
    <div className="shrink-0 px-3 pb-3 sm:px-5 sm:pb-4">
      <Composer key={threadId} projectId={projectId} threadId={threadId} branch={branch} running={running} request={request} setRequest={setRequest} canCritique={!!lineage.find(item => item.hasArtifact)} ensureGrant={ensureGrant} t={t} />
    </div>
  </div>;
}

function FoldRow({children}: {children: ReactNode}) {
  return <div className="pb-4"><div className="flex items-center gap-1.5 border-b border-border/60 px-1 pb-2 pt-1 text-xs tabular-nums text-muted-foreground">{children}</div></div>;
}

/** Text items stay prose; consecutive tool, approval and build events form one work group. */
function segments(events: RoundEvent[]): Segment[] {
  const result: Segment[] = [];
  for (const event of events) {
    if (event.type === "session" || event.type === "completed") continue;
    const last = result.at(-1);
    if (event.type === "text") {
      if (last?.kind === "text" && last.itemId === event.itemId) last.text += event.delta;
      else result.push({kind: "text", itemId: event.itemId, text: event.delta});
    } else if (last?.kind === "work") last.events.push(event);
    else result.push({kind: "work", events: [event]});
  }
  return result;
}

function RoundTurn({projectId, round, resumable, ensureGrant, version, branch, label, openVersion, compare, forkFrom, revise, t}: {projectId: string; round: RoundSummary; resumable: boolean; ensureGrant: (then: () => void) => void; version?: StudioVersion; branch: StudioBranch; label: (version: StudioVersion) => string; openVersion: (id: string) => void; compare: (base: string, target: string) => void; forkFrom: (checkpointId: string) => void; revise: (text: string) => void; t: Copy}) {
  const live = round.status === "running";
  const activity = useRoundActivity(round.id, live);
  const queryClient = useQueryClient();
  const discard = useMutation({mutationFn: () => discardChanges({data: {projectId, name: round.branch}}), onSuccess: () => queryClient.invalidateQueries()});
  const resume = useMutation({mutationFn: () => resumeRound({data: {projectId, roundId: round.id}}), onSuccess: () => queryClient.invalidateQueries({queryKey: ["studio-rounds", projectId]})});
  const canResume = resumable && round.kind === "request" && round.provider !== null && (round.status === "interrupted" || round.status === "failed");
  const parts = segments(activity.data?.events ?? []);
  const lastText = parts.findLastIndex(part => part.kind === "text");
  const stills = version?.outputs.filter(output => output.kind === "still").slice(0, 4) ?? [];
  return <div data-studio-round={round.status}>
    <UserRow round={round} t={t} />
    {parts.map((part, index) => part.kind === "text"
      ? <div key={`text:${part.itemId}`} className={index === lastText && !live ? "pb-4" : "pb-2"}>
          <div className="relative min-w-0 px-1 py-0.5"><ChatMarkdown text={part.text} /></div>
        </div>
      : <div key={`work:${index}`} className="pb-2"><WorkGroup roundId={round.id} events={part.events} live={live} cwd={branch.directory} t={t} /></div>)}
    {live && <WorkingRow startedAt={round.startedAt} t={t} />}
    {round.error && <div className="pb-2"><WorkGroup roundId={round.id} events={[{type: "build", status: "failed", error: round.error, checkpointId: null}]} live={false} cwd={branch.directory} heading={t.roundFailed} t={t} /></div>}
    {!live && <div className="group/assistant pb-6">
      {!!stills.length && <div className="mb-2 grid max-w-[560px] grid-cols-2 gap-2 px-1">{stills.map(still => <button type="button" key={still.id} onClick={() => openVersion(version!.id)} className="overflow-hidden rounded-lg border border-border/80 bg-background/70"><img src={still.url} alt={still.label} loading="lazy" className="block aspect-video w-full object-cover" /></button>)}</div>}
      <div className="flex flex-wrap items-center gap-0.5 px-1 text-xs tabular-nums text-muted-foreground">
        {round.status === "interrupted" && <span className="pe-2">{version ? t.stoppedSaved : t.roundInterrupted}</span>}
        {canResume && <Button size="xs" variant="outline" className="me-1" disabled={resume.isPending} onClick={() => ensureGrant(() => resume.mutate())}><PlayIcon />{t.continueRound}</Button>}
        {version && <span className="pe-1.5">{label(version)}</span>}
        {version?.hasArtifact && <Button size="xs" variant="ghost" onClick={() => openVersion(version.id)}>{t.openModel}</Button>}
        {version?.parentId && round.kind !== "critique" && <Button size="xs" variant="ghost" onClick={() => compare(version.parentId!, version.id)}>{t.compareWithPrevious}</Button>}
        {version && version.id !== branch.headId && <Button size="xs" variant="ghost" onClick={() => forkFrom(version.id)}><GitBranchIcon />{t.continueHere}</Button>}
        {round.kind === "critique" && round.summary && <Button size="xs" variant="ghost" onClick={() => revise(round.summary!)}>{t.reviseFromCritique}</Button>}
        {round.status === "failed" && round.kind === "request" && <Button size="xs" variant="ghost" disabled={discard.isPending} onClick={() => discard.mutate()} title={t.discardHint}>{t.discardChanges}</Button>}
        <span className="ms-auto opacity-0 transition-opacity duration-200 group-hover/assistant:opacity-100">{round.model}{round.completedAt && ` · ${new Date(round.completedAt).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}`}</span>
      </div>
      {(discard.error ?? resume.error) && <p role="alert" className="px-1 pt-1 text-xs text-destructive">{(discard.error ?? resume.error)!.message}</p>}
    </div>}
  </div>;
}

function UserRow({round, t}: {round: RoundSummary; t: Copy}) {
  return <div className="group flex flex-col items-end gap-1 pb-4">
    <div className="relative max-w-[80%] rounded-2xl bg-accent p-3">
      {!!round.attachments.length && <div className="mb-2 flex flex-wrap gap-1.5">{round.attachments.map(item => <span key={item.sha256} className="inline-flex items-center gap-1 rounded-md border border-border/80 bg-background/70 px-1.5 py-0.5 text-[11px] text-muted-foreground">{item.mimeType.startsWith("image/") ? <ImageIcon className="size-3" /> : <FileTextIcon className="size-3" />}{item.name}</span>)}</div>}
      {round.kind === "critique" && <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-muted-foreground"><ScanSearchIcon className="size-3" />{t.critique}</p>}
      <p className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">{round.request}</p>
    </div>
    <div className="flex w-full max-w-[80%] items-center justify-end pe-1 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100">{new Date(round.startedAt).toLocaleString([], {dateStyle: "short", timeStyle: "short"})}</div>
  </div>;
}

function ChatMarkdown({text}: {text: string}) {
  return <div className="chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80"><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown></div>;
}

/** "Working for 12s". The activity query repaints every second while the round runs. */
function WorkingRow({startedAt, t}: {startedAt: string; t: Copy}) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return <div className="py-0.5 pb-4 pl-1.5">
    <div className="flex items-center gap-2 pt-1 text-[11px] tabular-nums text-muted-foreground/70">
      <span className="inline-flex items-center gap-[3px]">
        <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30" />
        <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 [animation-delay:200ms]" />
        <span className="h-1 w-1 animate-status-pulse rounded-full bg-muted-foreground/30 [animation-delay:400ms]" />
      </span>
      <span>{t.workingFor} {elapsed}</span>
    </div>
  </div>;
}

type WorkEntry = {id: string; icon: typeof TerminalIcon; heading: string; preview: string | null; body: string | null; state: "running" | "done" | "failed" | "none"; error?: boolean};

/** Tool details arrive as "Tool: input". Show the part a person reads: a command, a path or a query. */
function toolPreview(detail: string | null, cwd: string) {
  if (!detail) return {name: "", preview: null, body: null};
  const separator = detail.indexOf(": ");
  const name = separator > 0 ? detail.slice(0, separator) : "";
  const rest = separator > 0 ? detail.slice(separator + 2) : detail;
  if (rest === "{}") return {name, preview: null, body: null};
  let preview = rest;
  try {
    const input = JSON.parse(rest) as Record<string, unknown>;
    const value = [input.command, input.file_path, input.path, input.pattern, input.url, input.query, input.notebook_path].find(item => typeof item === "string");
    preview = typeof value === "string" ? value : rest;
  } catch {
    // Long inputs arrive truncated and no longer parse. Read the leading field directly.
    const field = /"(command|file_path|path|pattern|url|query|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rest);
    if (field) preview = field[2]!.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  const local = (value: string) => value.split(`${cwd}/`).join("").split(cwd).join(".");
  const shown = local(preview);
  return {name, preview: shown.split("\n")[0]!.slice(0, 300), body: rest.length > shown.length + 40 || rest.includes("\n") ? local(rest) : null};
}

function toolIcon(name: string, title: string) {
  const value = `${name} ${title}`.toLowerCase();
  if (/bash|command|shell|exec/.test(value)) return TerminalIcon;
  if (/write|edit|file change|patch/.test(value)) return SquarePenIcon;
  if (/read|glob|grep|\bls\b|view/.test(value)) return EyeIcon;
  if (/web|fetch|search/.test(value)) return GlobeIcon;
  if (/agent|task/.test(value)) return BotIcon;
  return WrenchIcon;
}

function workEntries(events: WorkEvent[], live: boolean, cwd: string, t: Copy): WorkEntry[] {
  // Tool items report start and finish separately. Keep each item once, at its latest state.
  const entries = new Map<string, WorkEntry>();
  // A build reports start and outcome. Show one row that settles, as tool rows do.
  let build = 0;
  for (const [index, event] of events.entries()) {
    if (event.type === "tool") {
      const {name, preview, body} = toolPreview(event.detail, cwd);
      const previous = entries.get(event.itemId);
      entries.set(event.itemId, {id: event.itemId, icon: toolIcon(name, event.title), heading: name || event.title, preview: preview ?? previous?.preview ?? null, body: body ?? previous?.body ?? null, state: event.status === "started" ? live ? "running" : "none" : event.status === "failed" ? "failed" : "done"});
    } else if (event.type === "approval-resolved") {
      // Pending approvals live in the composer. The timeline records the decision.
      const request = events.find((item): item is ApprovalEvent => item.type === "approval" && item.requestId === event.requestId);
      const {preview, body} = toolPreview(request?.detail ?? null, cwd);
      entries.set(`approval:${event.requestId}`, {id: `approval:${event.requestId}`, icon: TerminalIcon, heading: event.decision === "accept" ? t.approved : t.declined, preview, body, state: event.decision === "accept" ? "done" : "failed"});
    } else if (event.type === "build") {
      if (event.status === "started") build = index;
      entries.set(`build:${build}`, {id: `build:${build}`, icon: event.status === "failed" ? CircleAlertIcon : HammerIcon, heading: event.status === "started" ? t.buildStarted : event.status === "completed" ? t.buildCompleted : event.status === "skipped" ? t.buildSkipped : t.buildFailed, preview: event.error?.split("\n")[0] ?? null, body: event.error && event.error.includes("\n") ? event.error : null, state: event.status === "started" ? live ? "running" : "none" : event.status === "failed" ? "failed" : "done", error: event.status === "failed"});
    } else if (event.type === "retry") {
      entries.set(`retry:${index}`, {id: `retry:${index}`, icon: MessageCircleIcon, heading: t.retrying, preview: null, body: event.prompt, state: "none"});
    }
  }
  return [...entries.values()];
}

const visibleWork = 6;
function WorkGroup({roundId, events, live, cwd, heading, t}: {roundId: string; events: WorkEvent[]; live: boolean; cwd: string; heading?: string; t: Copy}) {
  const [expanded, setExpanded] = useState(false);
  const entries = workEntries(events, live, cwd, t).map(entry => heading ? {...entry, heading} : entry);
  const images = events.filter((event): event is ImageEvent => event.type === "image");
  if (!entries.length && !images.length) return null;
  const hidden = expanded ? 0 : Math.max(0, entries.length - visibleWork);
  return <section className="-mx-1 space-y-0.5 px-1 py-0.5">
    {entries.length > visibleWork && <button type="button" className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65"><ChevronDownIcon className={cn("size-3.5 shrink-0 opacity-70 transition-transform duration-200", expanded && "rotate-180")} /></span>
      <span className="font-medium text-foreground/82">{expanded ? t.showFewerTools : `+${hidden} ${t.previousTools}`}</span>
    </button>}
    <div className="space-y-px">{entries.slice(hidden).map(entry => <WorkRow key={entry.id} entry={entry} />)}</div>
    {!!images.length && <div className="flex flex-wrap gap-2 px-0.5 pt-1.5 pb-0.5">{images.map(image => <ViewedImage key={`${image.itemId}:${image.sha256}`} roundId={roundId} image={image} />)}</div>}
  </section>;
}

/** What the agent looked at, as it was when it looked. */
function ViewedImage({roundId, image}: {roundId: string; image: ImageEvent}) {
  const [open, setOpen] = useState(false);
  const source = useQuery({queryKey: ["studio-round-image", roundId, image.sha256], queryFn: () => roundImage({data: {roundId, sha256: image.sha256}}), staleTime: Infinity, gcTime: 5 * 60_000});
  return <>
    <button type="button" title={image.name} onClick={() => setOpen(true)} disabled={!source.data} className="h-24 overflow-hidden rounded-lg border border-border/80 bg-background/70 transition-colors hover:border-border">
      {source.data ? <img src={source.data} alt={image.name} className="block h-full w-auto max-w-56 object-contain" /> : <span className="grid h-full w-32 place-items-center"><Spinner className="size-3.5 text-muted-foreground" /></span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[92vh] w-auto max-w-[92vw] gap-2 p-2 sm:max-w-[92vw]">
      <DialogTitle className="px-1 text-xs font-normal text-muted-foreground">{image.name}</DialogTitle>
      {source.data && <img src={source.data} alt={image.name} className="max-h-[84vh] max-w-full rounded-md object-contain" />}
    </DialogContent></Dialog>
  </>;
}

function WorkRow({entry}: {entry: WorkEntry}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = !!entry.body;
  const Icon = entry.icon;
  // Selecting text in the expanded body must not collapse the row.
  const toggle = canExpand ? {role: "button" as const, tabIndex: 0, onClick: (event: MouseEvent) => {if (!(event.target as Element).closest("[data-work-body]")) setExpanded(value => !value);}, onKeyDown: (event: KeyboardEvent) => {if (event.key === "Enter" || event.key === " ") {event.preventDefault(); setExpanded(value => !value);}}} : {};
  return <div className={cn("flex flex-col rounded-md px-0.5 py-0.5 transition-colors", canExpand && "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70")} {...toggle}>
    <div className="flex select-none items-center gap-1.5">
      <span className={cn("flex size-5 shrink-0 items-center justify-center", entry.error ? "text-destructive" : "text-muted-foreground/65")}><Icon className="block size-3.5 shrink-0 stroke-[1.8] opacity-80" aria-hidden /></span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <p className="flex w-full min-w-0 items-baseline gap-1.5 text-[12px] leading-5">
          <span className={cn("min-w-0 shrink truncate font-medium", entry.error ? "text-destructive" : "text-foreground/82")}>{entry.heading}</span>
          {entry.preview && <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{entry.preview}</span>}
        </p>
        <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
          <span className="flex size-4 shrink-0 items-center justify-center">{canExpand ? <ChevronDownIcon className={cn("size-3 shrink-0 opacity-70 transition-transform duration-200", expanded && "rotate-180")} aria-hidden /> : null}</span>
          <span className="flex size-4 shrink-0 items-center justify-center">{entry.state === "failed" ? <XIcon className="block size-3 shrink-0 text-destructive" aria-label="Failed" /> : entry.state === "done" ? <CheckIcon className="block size-3 shrink-0" aria-label="Completed" /> : entry.state === "running" ? <Spinner className="size-3" /> : null}</span>
        </div>
      </div>
    </div>
    {expanded && entry.body && <div data-work-body className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5">
      <pre className="max-h-64 cursor-text select-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">{entry.body}</pre>
    </div>}
  </div>;
}

/** Images go to the agent as images. Documents become project references the agent reads. */
type Attachment = {file: File; url: string | null};
const imageType = /^image\/(png|jpeg|webp|gif)$/;
const documentName = /\.(pdf|svg|txt|md|json)$/i;
function Composer({projectId, threadId, branch, running, request, setRequest, canCritique, ensureGrant, t}: {projectId: string; threadId: string; branch: StudioBranch; running?: RoundSummary; request: string; setRequest: (text: string) => void; canCritique: boolean; ensureGrant: (then: () => void) => void; t: Copy}) {
  const queryClient = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const providers = useQuery({queryKey: ["studio-agent-providers"], queryFn: () => agentProviders(), staleTime: 30_000});
  const saved = useQuery({queryKey: ["studio-thread-agent", projectId, threadId], queryFn: () => threadAgent({data: {projectId, threadId}}), staleTime: Infinity});
  const activity = useRoundActivity(running?.id, true);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [chosen, setChosen] = useState<ModelChoice>();
  const [chosenSettings, setChosenSettings] = useState<ModelSettings>();
  // A branch with a session keeps its provider, like a T3 Code thread. Other agents start on a new branch.
  const lockedTo = saved.data?.locked ? saved.data.provider : undefined;
  const ready = providers.data?.filter((item: AgentProviderStatus) => item.installed && item.authenticated !== false && item.models.length && (!lockedTo || item.provider === lockedTo)) ?? [];
  const available = (value?: {provider: AgentProvider; model: string}) => value && ready.some(item => item.provider === value.provider && item.models.some(model => model.id === value.model)) ? value : undefined;
  // New branches start on the first current model, which is Opus 5.5 when Claude is available.
  const firstCurrent = ready.flatMap(item => item.models.filter(model => !model.legacy).map(model => ({provider: item.provider, model: model.id})))[0];
  const selection = available(chosen) ?? available(saved.data ?? undefined) ?? firstCurrent ?? (ready[0] ? {provider: ready[0].provider, model: ready[0].models[0]!.id} : undefined);
  const selectedModel = selection ? ready.find(item => item.provider === selection.provider)?.models.find(model => model.id === selection.model) : undefined;
  const savedSettings = saved.data && selection && saved.data.provider === selection.provider && saved.data.model === selection.model ? saved.data.settings : {};
  const settings = chosenSettings ?? savedSettings;
  const resolvedSettings = Object.fromEntries((selectedModel?.settings ?? []).map(setting => [setting.id, settingValue(setting, settings)]));
  const events = running ? activity.data?.events ?? [] : [];
  const resolved = new Set(events.flatMap(event => event.type === "approval-resolved" ? [event.requestId] : []));
  const approvals = events.filter((event): event is ApprovalEvent => event.type === "approval" && !resolved.has(event.requestId));
  const approval = approvals[0];
  const start = useMutation({
    mutationFn: (kind: "request" | "critique") => {
      const data = new FormData();
      data.set("projectId", projectId); data.set("threadId", threadId); data.set("kind", kind);
      data.set("request", kind === "critique" ? t.critiqueRequest : request);
      data.set("provider", selection!.provider); data.set("model", selection!.model); data.set("settings", JSON.stringify(resolvedSettings));
      if (kind === "request") for (const item of attachments) data.append("attachments", item.file);
      return startRound({data});
    },
    onSuccess: async (_value, kind) => {
      if (kind === "request") {setRequest(""); for (const item of attachments) if (item.url) URL.revokeObjectURL(item.url); setAttachments([]);}
      await queryClient.invalidateQueries({queryKey: ["studio-rounds", projectId]});
      await queryClient.invalidateQueries({queryKey: ["studio-threads"]});
    },
  });
  const answer = useMutation({mutationFn: (value: {requestId: string; decision: "accept" | "decline"}) => answerApproval({data: {roundId: running!.id, ...value}}), onSuccess: () => activity.refetch()});
  const interrupt = useMutation({mutationFn: () => interruptRound({data: {roundId: running!.id}})});
  const addFiles = (files: Iterable<File>) => setAttachments(current => [...current, ...[...files].filter(item => imageType.test(item.type) ? item.size <= 10 * 1024 * 1024 : documentName.test(item.name) && item.size <= 100 * 1024 * 1024).map(item => ({file: item, url: imageType.test(item.type) ? URL.createObjectURL(item) : null}))].slice(0, 20));
  const removeAttachment = (attachment: Attachment) => {if (attachment.url) URL.revokeObjectURL(attachment.url); setAttachments(current => current.filter(item => item !== attachment));};
  const canSend = !running && !start.isPending && !!selection && !!request.trim();
  const send = () => {if (canSend) ensureGrant(() => start.mutate("request"));};
  const drop = (event: DragEvent) => {event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files);};
  return <form className="mx-auto w-full min-w-0 max-w-3xl" onSubmit={event => {event.preventDefault(); send();}} onDragOver={event => {event.preventDefault(); setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={drop}>
    <div className="chat-composer-glass-shell relative mx-auto w-full max-w-3xl">
      <div className="chat-composer-glass-host relative z-10 w-full rounded-[22px]">
        <div className="group relative z-10 rounded-[22px] p-px">
          <div className={cn("rounded-[20px] transition-[background-color] duration-200", dragging && "bg-accent/45 ring-1 ring-primary/70")}>
            {approval && <div className="rounded-t-[19px] border-b border-border/65 bg-muted/20">
              <div className="px-4 py-3.5 sm:px-5 sm:py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm uppercase tracking-[0.2em]">{t.pendingApproval}</span>
                  <span className="text-sm font-medium">{approval.kind === "command" ? t.commandApproval : approval.kind === "file-read" ? t.fileReadApproval : approval.kind === "file-change" ? t.fileChangeApproval : approval.title}</span>
                  {approvals.length > 1 && <span className="text-xs text-muted-foreground">1/{approvals.length}</span>}
                </div>
                {approval.detail && <div className="mt-3 rounded-lg border border-border/65 bg-background/70 p-3">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">{approval.detail.split(`${branch.directory}/`).join("")}</pre>
                </div>}
              </div>
            </div>}
            {!approval && <div className="relative px-3 pb-2 pt-3.5 sm:px-4 sm:pt-4">
              {!!attachments.length && <div className="mb-3 flex flex-wrap gap-2">{attachments.map(item => <div key={`${item.file.name}:${item.file.size}:${item.file.lastModified}`} className={cn("relative h-16 overflow-hidden rounded-lg border border-border/80 bg-background", item.url ? "w-16" : "flex w-40 items-center gap-2 px-2.5 pr-7")}>
                {item.url ? <img src={item.url} alt={item.file.name} className="h-full w-full object-cover" /> : <><FileTextIcon className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 truncate text-xs text-foreground/80" title={item.file.name}>{item.file.name}</span></>}
                <Button type="button" variant="ghost" size="icon-xs" className="absolute right-1 top-1 bg-background/80 hover:bg-background/90" onClick={() => removeAttachment(item)} aria-label={`${t.removeFile}: ${item.file.name}`}><XIcon /></Button>
              </div>)}</div>}
              <textarea aria-label={t.composerPlaceholder} placeholder={running ? t.roundBusy : t.composerPlaceholder} value={request} onChange={event => setRequest(event.target.value)} onPaste={event => addFiles(event.clipboardData.files)} onKeyDown={event => {if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); send();}}} rows={3} maxLength={20000} className="block max-h-50 min-h-17.5 w-full resize-none overflow-y-auto whitespace-pre-wrap bg-transparent text-[16px] leading-relaxed text-foreground placeholder:text-muted-foreground/35 focus:outline-none sm:text-[14px]" />
            </div>}
            {approval ? <div className="flex items-center justify-end gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <Button type="button" size="sm" variant="ghost" disabled={interrupt.isPending} onClick={() => interrupt.mutate()}>{t.interrupt}</Button>
              <Button type="button" size="sm" variant="outline" disabled={answer.isPending} onClick={() => answer.mutate({requestId: approval.requestId, decision: "decline"})}>{t.decline}</Button>
              <Button type="button" size="sm" disabled={answer.isPending} onClick={() => answer.mutate({requestId: approval.requestId, decision: "accept"})}>{t.approve}</Button>
            </div>
            : <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2 px-2.5 pb-2.5 sm:px-3 sm:pb-3">
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none]">
                {!ready.length && providers.data ? <Button type="button" size="sm" variant="ghost" disabled className="shrink-0 gap-2 px-2 text-muted-foreground/70"><CircleAlertIcon className="size-4" />{t.noProvider}</Button>
: <>
                  {providers.data && <ModelPicker providers={providers.data} value={selection} lockedTo={lockedTo} onChange={next => {setChosen(next); setChosenSettings({});}} t={t} />}
                  <TraitsPicker model={selectedModel} settings={settings} onChange={setChosenSettings} t={t} />
                </>}
                <Button type="button" size="icon-sm" variant="ghost" className="rounded-full text-muted-foreground" aria-label={t.attachFiles} title={t.attachFiles} onClick={() => file.current?.click()}><PaperclipIcon /></Button>
                <input ref={file} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif,.pdf,.svg,.txt,.md,.json" className="sr-only" tabIndex={-1} onChange={event => {addFiles(event.target.files ?? []); event.target.value = "";}} />
                <Button type="button" size="sm" variant="ghost" className="rounded-full text-muted-foreground" disabled={!!running || start.isPending || !selection || !canCritique} onClick={() => start.mutate("critique")}><ScanSearchIcon />{t.critique}</Button>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                {running ? <button type="button" onClick={() => interrupt.mutate()} disabled={interrupt.isPending} aria-label={t.interrupt} className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs transition-all duration-150 hover:scale-105 hover:bg-destructive disabled:opacity-50">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="8" height="8" rx="1.5" /></svg>
                </button>
                : <button type="submit" disabled={!canSend} aria-label={t.send} className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-primary/90 text-primary-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer hover:scale-105 hover:bg-primary disabled:pointer-events-none disabled:opacity-30 disabled:shadow-none sm:h-8 sm:w-8">
                  {start.isPending ? <Spinner className="size-3.5" /> : <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </button>}
              </div>
            </div>}
          </div>
        </div>
      </div>
    </div>
    {(start.error || answer.error) && <p role="alert" className="px-4 pt-2 text-xs text-destructive">{(start.error ?? answer.error)!.message}</p>}
  </form>;
}
