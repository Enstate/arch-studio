import { threadTitle } from "../lib/thread-title";
import { Button } from "@arch/ui/components/button";
import { Spinner } from "@arch/ui/components/spinner";
import { CircleAlertIcon, MessageCircleIcon, PackageIcon, SquarePenIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { StudioThread } from "../lib/model";
import type { studioText } from "../lib/messages";
import { relativeTime, useStudioFormat } from "../lib/locale";
import { SectionHeader } from "./intake-overview";
import { starters } from "./rounds";
import { ProjectBadge } from "./thread-sidebar";

type Copy = typeof studioText.en;
const recent = (thread: StudioThread) => [thread.latestCompletedAt, thread.latestRequestAt, thread.createdAt].filter(Boolean).sort().at(-1) ?? "";

/** Where a project opens: start a conversation, pick up an earlier one, share it. The overview follows. */
export function ProjectHome({projectName, clientName, threads, openThread, startConversation, starting, share, children, t}: {projectName: string; clientName?: string; threads: StudioThread[]; openThread: (thread: StudioThread) => void; startConversation?: (request?: string) => void; starting: boolean; share?: () => void; children?: ReactNode; t: Copy}) {
  const format = useStudioFormat();
  const now = Date.now();
  const sorted = [...threads].sort((a, b) => recent(b).localeCompare(recent(a)));
  return <>
    <header className="flex flex-wrap items-center gap-3">
      <ProjectBadge name={projectName} className="size-9 rounded-lg text-xs" />
      <div className="grid min-w-0 flex-1 gap-0.5"><h2 className="truncate text-lg font-medium">{projectName}</h2>{clientName && <p className="truncate text-muted-foreground">{clientName}</p>}</div>
      <div className="flex flex-wrap items-center gap-2">
        {share && <Button size="sm" variant="outline" onClick={share}><PackageIcon />{t.shareProject}</Button>}
        {startConversation && <Button size="sm" disabled={starting} onClick={() => startConversation()}>{starting ? <Spinner /> : <SquarePenIcon />}{t.newThread}</Button>}
      </div>
    </header>
    {startConversation && <section className="grid gap-3">
      <SectionHeader title={t.getStarted} />
      <div className="grid gap-2 sm:grid-cols-2">{starters(t).map(starter => <button type="button" key={starter.title} disabled={starting} onClick={() => startConversation(starter.request)} className="grid gap-1 rounded-lg border px-4 py-3 text-left outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-60">
        <span className="flex items-center gap-2 font-medium"><starter.icon className="size-4 text-muted-foreground" />{starter.title}</span>
        <span className="text-xs text-muted-foreground">{starter.hint}</span>
      </button>)}</div>
    </section>}
    <section className="grid gap-2">
      <SectionHeader title={t.threads} count={threads.length} />
      {sorted.length ? <ul className="-mx-2.5 grid gap-px">{sorted.map(thread => <li key={thread.id} className="list-none"><button type="button" onClick={() => openThread(thread)} className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring/50">
        {thread.status === "working" ? <Spinner className="size-4 text-sky-600 dark:text-sky-400" /> : thread.status === "approval" || thread.status === "failed" ? <CircleAlertIcon className="size-4 text-amber-600 dark:text-amber-300" /> : <MessageCircleIcon className="size-4 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate">{threadTitle(thread.title, t)}</span>
        {thread.branch !== "main" && <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">{thread.branch}</span>}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{relativeTime(Date.parse(recent(thread)), now, format)}</span>
      </button></li>)}</ul>
        : <p className="text-muted-foreground">{t.noConversations}</p>}
    </section>
    {children}
  </>;
}
