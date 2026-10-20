import type { ProjectIntakePlan, ProjectManifest } from "@arch/project";
import { cn } from "@arch/ui/lib/utils";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { studioText } from "../lib/messages";
import { FileKindIcon, FileRow, FileSource, type ProjectFile } from "./project-files";

type Copy = typeof studioText.en;
type Piece = ProjectIntakePlan["pieces"][number];
type Status = Piece["status"];
type Assumptions = ProjectManifest["assumptions"];

const briefPreviewLength = 260;
const documentPreviewCount = 6;
const dotColors: Record<Status, string> = { blocked: "bg-amber-500", ready: "bg-emerald-500", planned: "bg-muted-foreground/40" };

function StatusDot({ status, className }: { status: Status; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-1.5 shrink-0 rounded-full", dotColors[status], className)} />;
}
function statusLabel(status: Status, t: Copy) {
  return status === "blocked" ? t.intakeBlocked : status === "ready" ? t.intakeReady : t.intakePlanned;
}

function SectionHeader({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return <div className="flex min-h-7 items-center gap-2">
    <h3 className="text-ui font-medium">{title}</h3>
    {count !== undefined && <span className="text-ui tabular-nums text-muted-foreground">{count}</span>}
    <span className="flex-1" />
    {action}
  </div>;
}
function SectionLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button type="button" onClick={onClick} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 max-md:h-11">{children}<ArrowRightIcon className="size-3.5" /></button>;
}

/** Shared notice for a missing or invalid plan. Returns null when the plan is usable. */
function IntakeNotice({ intake, error, t }: { intake: ProjectIntakePlan | null; error: string | null; t: Copy }) {
  if (error) return <div role="alert" className="grid gap-3 rounded-lg border border-amber-500/30 px-4 py-3 text-ui">
    <p>{t.intakeInvalid}</p>
    <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground">{error}</pre>
  </div>;
  if (!intake) return <p className="text-ui text-muted-foreground">{t.intakeMissing}</p>;
  return null;
}

/** Document links inside a piece. Each opens the in-app viewer. */
function DocumentLinks({ ids, documents, files, openFile, t }: { ids: string[]; documents: ProjectIntakePlan["documents"]; files: ProjectFile[]; openFile: (key: string) => void; t: Copy }) {
  const linked = ids.flatMap(id => documents.filter(document => document.id === id));
  if (!linked.length) return null;
  return <div className="flex flex-wrap gap-1.5">{linked.map(document => {
    const file = files.find(file => file.path === document.path && (file.page ?? 1) === document.page);
    return <button type="button" key={document.id} disabled={!file?.url} onClick={() => {if (file?.url) openFile(file.key);}} title={file?.url ? file.fileName : t.fileNotInVersion} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-md border px-2 text-xs text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-60 max-md:h-9"><FileKindIcon kind={file?.kind ?? "other"} className="size-3.5 shrink-0" /><span className="truncate">{file?.label ?? document.label}</span>{!file?.url && <span className="shrink-0">{t.fileUnavailable}</span>}</button>;
  })}</div>;
}

/** Expandable piece row: the next action stays visible, scope and links open on demand. */
function PieceRow({ piece, index, pieces, documents, files, openFile, showStatus, t }: { piece: Piece; index?: number; pieces: Piece[]; documents: ProjectIntakePlan["documents"]; files: ProjectFile[]; openFile: (key: string) => void; showStatus: boolean; t: Copy }) {
  const dependencies = piece.dependsOn.map(id => pieces.find(item => item.id === id)?.label).filter(Boolean);
  return <li><details data-studio-piece={piece.id} className="group">
    <summary className="flex cursor-pointer list-none items-start gap-3 rounded-md px-2 py-2.5 outline-none hover:bg-foreground/4 focus-visible:ring-1 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
      {index !== undefined && <span className="w-5 shrink-0 pt-px text-right text-xs tabular-nums text-muted-foreground">{index}</span>}
      <StatusDot status={piece.status} className="mt-[0.45rem]" />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-ui font-medium">{piece.label}</span>
          {showStatus && <span className={cn("text-xs", piece.status === "blocked" ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground")}>{statusLabel(piece.status, t)}</span>}
        </span>
        <span className="line-clamp-1 text-ui text-muted-foreground group-open:line-clamp-none group-open:text-foreground">{piece.nextAction}</span>
      </span>
      <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
    </summary>
    <div className={cn("grid gap-3 pt-1 pr-2 pb-4 text-ui", index !== undefined ? "pl-[3.25rem]" : "pl-6")}>
      <div className="grid gap-1"><p className="text-xs text-muted-foreground">{t.intakeScope}</p><p className="whitespace-pre-wrap text-muted-foreground">{piece.scope}</p></div>
      {!!dependencies.length && <p className="text-xs text-muted-foreground">{t.intakeDependencies}: {dependencies.join(", ")}</p>}
      <DocumentLinks ids={piece.documentIds} documents={documents} files={files} openFile={openFile} t={t} />
    </div>
  </details></li>;
}

/** Expandable assumption row in the same one-line shape as a piece. The full text opens on demand. */
function AssumptionRow({ assumption, showStatus, t }: { assumption: Assumptions[number]; showStatus: boolean; t: Copy }) {
  const confirmed = assumption.status === "confirmed";
  return <li><details data-studio-assumption={assumption.id} className="group">
    <summary className="flex cursor-pointer list-none items-start gap-3 rounded-md px-2 py-2.5 outline-none hover:bg-foreground/4 focus-visible:ring-1 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
      <span aria-hidden="true" className={cn("mt-[0.45rem] size-1.5 shrink-0 rounded-full", confirmed ? "bg-muted-foreground/40" : "bg-amber-500")} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        {showStatus && <span className={cn("text-xs", confirmed ? "text-muted-foreground" : "text-amber-700 dark:text-amber-400")}>{confirmed ? t.intakeConfirmed : t.intakeUnconfirmed}</span>}
        <span className="line-clamp-1 whitespace-pre-wrap text-ui group-open:line-clamp-none">{assumption.description}</span>
      </span>
      <ChevronRightIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
    </summary>
  </details></li>;
}

function Brief({ intake, t }: { intake: ProjectIntakePlan; t: Copy }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = intake.brief.length > briefPreviewLength || intake.brief.includes("\n") || !!intake.style;
  return <section aria-label={t.intakeBrief} className="grid gap-3">
    <p className={cn("whitespace-pre-wrap text-[0.9375rem] leading-relaxed text-pretty", !expanded && "line-clamp-3")}>{intake.brief}</p>
    {expanded && intake.style && <div className="grid gap-1"><h3 className="text-xs text-muted-foreground">{t.intakeStyle}</h3><p className="whitespace-pre-wrap leading-relaxed text-muted-foreground">{intake.style}</p></div>}
    {expandable && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="justify-self-start rounded-md text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring/50 max-md:py-2">{expanded ? t.intakeShowLess : t.intakeShowMore}</button>}
  </section>;
}

type OverviewProps = {
  intake: ProjectIntakePlan | null;
  error: string | null;
  assumptions: Assumptions;
  /** Files of the selected saved version, labelled by that version's own plan. */
  files: ProjectFile[];
  versionLabel?: string;
  filesError: string | null;
  openFile: (key: string) => void;
  openFiles: () => void;
  openWork: () => void;
  t: Copy;
};

/** Project overview: short brief, the saved documents, open questions, then a work status summary. */
export function IntakeOverview({ intake, error, assumptions, files, versionLabel, filesError, openFile, openFiles, openWork, t }: OverviewProps) {
  const usable = error ? null : intake;
  const pieces = usable?.pieces ?? [];
  const blocked = pieces.filter(piece => piece.status === "blocked");
  const unconfirmed = assumptions.filter(assumption => assumption.status !== "confirmed");
  const counts = (["blocked", "ready", "planned"] as const).map(status => ({ status, count: pieces.filter(piece => piece.status === status).length })).filter(item => item.count);
  return <div data-studio-intake className="grid gap-10">
    {usable ? <Brief intake={usable} t={t} /> : <IntakeNotice intake={intake} error={error} t={t} />}
    <section aria-label={t.intakeDocuments} data-studio-documents className="grid gap-2">
      <SectionHeader title={t.intakeDocuments} count={files.length} action={!!files.length && <SectionLink onClick={openFiles}>{t.intakeViewFiles}</SectionLink>} />
      <FileSource versionLabel={versionLabel} error={filesError} t={t} />
      {!files.length ? <p className="text-ui text-muted-foreground">{t.noFiles}</p> : <ul className="-mx-2 grid gap-px">{files.slice(0, documentPreviewCount).map(file => <FileRow key={file.key} file={file} open={() => openFile(file.key)} t={t} />)}</ul>}
    </section>
    {!!(blocked.length + unconfirmed.length) && <section aria-label={t.intakeQuestions} data-studio-questions className="grid gap-2">
      <SectionHeader title={t.intakeQuestions} count={blocked.length + unconfirmed.length} />
      <ul className="-mx-2 grid gap-px">
        {blocked.map(piece => <PieceRow key={piece.id} piece={piece} pieces={pieces} documents={usable?.documents ?? []} files={files} openFile={openFile} showStatus={false} t={t} />)}
        {unconfirmed.map(assumption => <AssumptionRow key={assumption.id} assumption={assumption} showStatus={false} t={t} />)}
      </ul>
    </section>}
    {usable && <section aria-label={t.intakePieces} data-studio-work-summary className="grid gap-2">
      <SectionHeader title={t.intakePieces} count={pieces.length} action={!!pieces.length && <SectionLink onClick={openWork}>{t.intakeViewWork}</SectionLink>} />
      {!pieces.length ? <p className="text-ui text-muted-foreground">{t.intakeEmpty}</p> : <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">{counts.map(item => <span key={item.status} className="inline-flex items-center gap-1.5"><StatusDot status={item.status} />{statusLabel(item.status, t)} <span className="tabular-nums">{item.count}</span></span>)}</p>}
    </section>}
  </div>;
}

/** Full work plan in the agent's order, followed by every recorded assumption. */
export function WorkPlan({ intake, error, assumptions, files, openFile, t }: Pick<OverviewProps, "intake" | "error" | "assumptions" | "files" | "openFile" | "t">) {
  const notice = <IntakeNotice intake={intake} error={error} t={t} />;
  return <div data-studio-work className="grid gap-10">
    <h2 className="sr-only">{t.intakePieces}</h2>
    {error || !intake ? notice : <section aria-label={t.intakePieces} className="grid gap-2">
      <SectionHeader title={t.intakePieces} count={intake.pieces.length} />
      {!intake.pieces.length ? <p className="text-ui text-muted-foreground">{t.intakeEmpty}</p> : <ol className="-mx-2 grid gap-px">{intake.pieces.map((piece, index) => <PieceRow key={piece.id} piece={piece} index={index + 1} pieces={intake.pieces} documents={intake.documents} files={files} openFile={openFile} showStatus t={t} />)}</ol>}
    </section>}
    {!!assumptions.length && <section aria-label={t.intakeAssumptions} className="grid gap-2">
      <SectionHeader title={t.intakeAssumptions} count={assumptions.length} />
      <ul className="-mx-2 grid gap-px">{assumptions.map(assumption => <AssumptionRow key={assumption.id} assumption={assumption} showStatus t={t} />)}</ul>
    </section>}
  </div>;
}
