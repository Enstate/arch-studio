import type { ProjectIntakePlan } from "@arch/project";
import { buttonVariants } from "@arch/ui/components/button";
import { projectIconButton } from "@arch/ui/components/project-layout";
import { cn } from "@arch/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, FileTextIcon, FolderOpenIcon, ImageIcon } from "lucide-react";
import { type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@arch/ui/components/button";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { addReferences } from "../lib/server";
import type { studioText } from "../lib/messages";
import type { StudioVersion } from "../lib/model";

type Copy = typeof studioText.en;
type FileKind = "pdf" | "image" | "text" | "other";
type DocumentRole = ProjectIntakePlan["documents"][number]["role"];

/** One viewable entry: an intake document page, or a saved reference outside the plan. */
export type ProjectFile = {
  key: string;
  path: string;
  label: string;
  fileName: string;
  page?: number;
  detail: string;
  role?: DocumentRole;
  duplicateOf?: string;
  kind: FileKind;
  url?: string;
};

const kinds = new Map<string, FileKind>([["pdf", "pdf"], ["png", "image"], ["jpg", "image"], ["jpeg", "image"], ["webp", "image"], ["txt", "text"], ["md", "text"], ["json", "text"], ["svg", "text"]]);
const textLimit = 200_000;

function fileKind(path: string): FileKind {
  return kinds.get(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ?? "other";
}
function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}
function inlineLocation(url: string, page?: number) {
  const location = new URL(url);
  location.searchParams.set("inline", "1");
  if (page) location.hash = `page=${page}&view=FitH&navpanes=0`;
  return location.href;
}

/**
 * Intake documents resolved against one version's saved references, plus the saved files the plan does not mention.
 * Pass the plan saved with that version so a later plan never labels earlier bytes. Duplicates follow the other documents.
 */
export function projectFiles(intake: ProjectIntakePlan | null, references: StudioVersion["references"], t: Copy) {
  const planned = new Set(intake?.documents.map(document => document.path));
  const pages = new Map<string, number>();
  for (const document of intake?.documents ?? []) pages.set(document.path, (pages.get(document.path) ?? 0) + 1);
  const all = intake?.documents ?? [];
  const ordered = [...all.filter(document => document.role !== "duplicate"), ...all.filter(document => document.role === "duplicate")];
  const documents: ProjectFile[] = ordered.map(document => ({
    key: document.id,
    path: document.path,
    label: document.label,
    fileName: fileName(document.path),
    page: document.page,
    detail: [document.level, document.revision, (document.page > 1 || pages.get(document.path)! > 1) && `${t.intakePage} ${document.page}`].filter(Boolean).join(" · "),
    role: document.role,
    duplicateOf: intake?.documents.find(item => item.id === document.duplicateOf)?.label,
    kind: fileKind(document.path),
    url: references.find(reference => reference.path === document.path)?.url,
  }));
  const others: ProjectFile[] = references.filter(reference => !planned.has(reference.path)).map(reference => ({
    key: `reference:${reference.path}`,
    path: reference.path,
    label: reference.label,
    fileName: fileName(reference.path),
    detail: reference.label === fileName(reference.path) ? "" : fileName(reference.path),
    kind: fileKind(reference.path),
    url: reference.url,
  }));
  return { documents, others };
}

function roleTag(file: ProjectFile, t: Copy) {
  if (file.role === "duplicate") return t.intakeDuplicateTag;
  if (file.role === "supporting") return t.intakeSupporting;
  // Unclassified is the normal state of new files, not something to act on.
  return undefined;
}

export function FileKindIcon({ kind, className }: { kind: FileKind; className?: string }) {
  const Icon = kind === "image" ? ImageIcon : kind === "other" ? FileIcon : FileTextIcon;
  return <Icon aria-hidden="true" className={className} />;
}

/** Where the listed files come from, and a notice when that version's document list could not be read. */
export function FileSource({ versionLabel, error, t, className }: { versionLabel?: string; error: string | null; t: Copy; className?: string }) {
  if (!versionLabel && !error) return null;
  return <div className={cn("grid gap-1.5", className)}>
    {versionLabel && <p className="text-xs text-muted-foreground">{t.filesSavedIn} {versionLabel}</p>}
    {error && <p role="status" data-studio-files-metadata-error className="rounded-md border border-amber-500/30 px-2.5 py-1.5 text-xs text-muted-foreground">{t.versionFilesInvalid}</p>}
  </div>;
}

/** A single compact row: the name opens the in-app viewer. Originals live in the project folder. */
export function FileRow({ file, active, open, t }: { file: ProjectFile; active?: boolean; open: () => void; t: Copy }) {
  const tag = roleTag(file, t);
  return <li data-studio-file={file.key} className="flex items-center gap-0.5">
    <button type="button" onClick={open} aria-current={active ? "true" : undefined} title={file.fileName} className={cn("flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring/50 aria-[current=true]:bg-foreground/9 max-md:py-2.5", file.role === "duplicate" && "opacity-65")}>
      <FileKindIcon kind={file.kind} className="size-4 shrink-0 text-muted-foreground" />
      <span className="grid min-w-0 flex-1">
        <span className="truncate text-ui">{file.label}</span>
        {file.detail && <span className="truncate text-xs text-muted-foreground">{file.detail}</span>}
      </span>
      {tag && <span className="shrink-0 text-xs text-muted-foreground">{tag}</span>}
      {!file.url && <span className="shrink-0 text-xs text-muted-foreground">{t.fileUnavailable}</span>}
    </button>
  </li>;
}

function FileNotice({ file, message, t }: { file: ProjectFile; message: string; t: Copy }) {
  return <div className="grid size-full place-items-center p-6">
    <div className="grid max-w-sm justify-items-center gap-3 text-center text-ui">
      <FileKindIcon kind={file.kind} className="size-6 text-muted-foreground" />
      <p className="text-muted-foreground">{message}</p>
      {file.url && <a href={file.url} download className={buttonVariants({ variant: "outline", size: "sm" })}><DownloadIcon />{t.download}</a>}
    </div>
  </div>;
}

function ImagePreview({ file, src, t }: { file: ProjectFile; src: string; t: Copy }) {
  const [failed, setFailed] = useState(false);
  const [actualSize, setActualSize] = useState(false);
  if (failed) return <FileNotice file={file} message={t.fileLoadFailed} t={t} />;
  return <div className={cn("size-full overflow-auto bg-foreground/[0.03] p-4", !actualSize && "grid place-items-center")}>
    <button type="button" onClick={() => setActualSize(value => !value)} aria-label={actualSize ? t.fitImage : t.actualSize} className={cn("block outline-none focus-visible:ring-2 focus-visible:ring-ring/50", actualSize ? "cursor-zoom-out" : "size-full cursor-zoom-in")}>
      <img src={src} alt={file.label} onError={() => setFailed(true)} className={cn("mx-auto", actualSize ? "max-w-none" : "size-full object-contain")} />
    </button>
  </div>;
}

function TextPreview({ file, src, t }: { file: ProjectFile; src: string; t: Copy }) {
  const text = useQuery({
    queryKey: ["studio-reference-text", src],
    queryFn: async () => {
      const response = await fetch(src, { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error(t.fileLoadFailed);
      return response.text();
    },
    staleTime: Infinity,
    retry: false,
  });
  if (text.isError) return <FileNotice file={file} message={t.fileLoadFailed} t={t} />;
  if (!text.data && text.isPending) return <p role="status" className="p-6 text-ui text-muted-foreground">{t.loading}</p>;
  const value = text.data ?? "";
  return <div className="size-full overflow-auto">
    {value.length > textLimit && <p className="border-b px-6 py-2 text-xs text-muted-foreground">{t.fileTruncated}</p>}
    <pre className="whitespace-pre-wrap break-words p-6 font-mono text-xs leading-relaxed">{value.slice(0, textLimit)}</pre>
  </div>;
}

type PdfAvailability = "available" | "missing" | "unsupported";

/** Checks the inline PDF response with HEAD before framing it, so a 404 or a non-PDF body shows a notice instead of an error page. */
function PdfPreview({ file, src, t }: { file: ProjectFile; src: string; t: Copy }) {
  const location = src.split("#")[0];
  const probe = useQuery({
    queryKey: ["studio-reference-pdf", location],
    queryFn: async (): Promise<PdfAvailability> => {
      const response = await fetch(location, { method: "HEAD", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
      if (response.status === 415) return "unsupported";
      if (!response.ok) return "missing";
      return response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/pdf" ? "available" : "unsupported";
    },
    staleTime: Infinity,
    retry: false,
  });
  if (probe.isError || probe.data === "missing") return <FileNotice file={file} message={t.fileLoadFailed} t={t} />;
  if (probe.data === "unsupported") return <FileNotice file={file} message={t.fileNoPreview} t={t} />;
  if (probe.isPending) return <p role="status" className="p-6 text-ui text-muted-foreground">{t.loading}</p>;
  // Remount on page changes because some PDF viewers ignore fragment-only navigation.
  return <iframe key={src} src={src} title={file.label} referrerPolicy="no-referrer" className="size-full border-0 bg-foreground/[0.03]" />;
}

function FilePreview({ file, t }: { file: ProjectFile; t: Copy }) {
  if (!file.url) return <FileNotice file={file} message={t.fileNotInVersion} t={t} />;
  if (file.kind === "other") return <FileNotice file={file} message={t.fileNoPreview} t={t} />;
  const src = inlineLocation(file.url, file.kind === "pdf" ? file.page ?? 1 : undefined);
  // Keyed by the immutable URL so a failed or zoomed state never carries over to other bytes.
  if (file.kind === "image") return <ImagePreview key={src} file={file} src={src} t={t} />;
  if (file.kind === "text") return <TextPreview file={file} src={src} t={t} />;
  if (typeof navigator !== "undefined" && navigator.pdfViewerEnabled === false) return <FileNotice file={file} message={t.pdfUnsupported} t={t} />;
  return <PdfPreview file={file} src={src} t={t} />;
}

/** In-app viewer for one project file with previous/next, download and back controls. */
export function FileViewer({ file, position, total, select, close, reveal, t }: { file: ProjectFile; position: number; total: number; select: (offset: number) => void; close?: () => void; reveal?: (path: string) => void; t: Copy }) {
  const meta = [file.fileName, file.page && file.kind === "pdf" && `${t.intakePage} ${file.page}`, file.duplicateOf && `${t.intakeDuplicate}: ${file.duplicateOf}`].filter(Boolean).join(" · ");
  return <section data-studio-file-viewer={file.key} aria-label={file.label} className="flex size-full min-h-0 min-w-0 flex-col">
    <header className="flex min-h-12 shrink-0 items-center gap-1 border-b px-2 py-1.5">
      {close && <button type="button" onClick={close} className={projectIconButton} aria-label={t.allFiles} title={t.allFiles}><ArrowLeftIcon /></button>}
      <div className="grid min-w-0 flex-1 px-1.5">
        <h3 className="truncate text-ui font-medium">{file.label}</h3>
        <p className="truncate text-xs text-muted-foreground" title={[meta, file.detail].filter(Boolean).join(" · ")}>{meta}</p>
      </div>
      {total > 1 && <div className="flex items-center">
        <button type="button" className={projectIconButton} onClick={() => select(-1)} disabled={position === 0} aria-label={t.previousFile} title={t.previousFile}><ChevronLeftIcon /></button>
        <span className="min-w-10 text-center text-xs tabular-nums text-muted-foreground max-sm:hidden">{position + 1} / {total}</span>
        <button type="button" className={projectIconButton} onClick={() => select(1)} disabled={position === total - 1} aria-label={t.nextFile} title={t.nextFile}><ChevronRightIcon /></button>
      </div>}
      {reveal && <button type="button" onClick={() => reveal(file.path)} aria-label={`${t.showInFolder}: ${file.label}`} title={t.showInFolder} className={projectIconButton}><FolderOpenIcon /></button>}
      {file.url && <a href={file.url} download aria-label={`${t.download}: ${file.label}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-1 max-md:size-11 max-md:p-0")}><DownloadIcon /><span className="max-md:sr-only">{t.download}</span></a>}
    </header>
    <div className="relative min-h-0 flex-1"><FilePreview file={file} t={t} /></div>
  </section>;
}

const wideQuery = "(min-width: 64rem)";
function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(wideQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function useWideLayout() {
  return useSyncExternalStore(subscribeWide, () => window.matchMedia(wideQuery).matches, () => false);
}

/** Files section: list and viewer side by side on wide screens, one at a time on narrow screens. */
export function ProjectFiles({ documents, others, versionLabel, filesError, selected, select, action, reveal, t }: { documents: ProjectFile[]; others: ProjectFile[]; versionLabel?: string; filesError: string | null; selected?: string; select: (key: string | undefined) => void; action?: ReactNode; reveal?: (path: string) => void; t: Copy }) {
  const wide = useWideLayout();
  const files = [...documents, ...others];
  const active = files.find(file => file.key === selected) ?? (wide ? files.find(file => file.url) ?? files[0] : undefined);
  const position = active ? files.indexOf(active) : -1;
  if (!files.length) return <div className="grid flex-1 place-items-center p-6"><div className="grid max-w-sm justify-items-center gap-2 text-center text-ui"><FileIcon aria-hidden="true" className="size-6 text-muted-foreground" /><h2 className="font-medium">{t.files}</h2><p className="text-muted-foreground">{action ? t.noFilesYet : t.noFiles}</p>{action}</div></div>;
  const list = (items: ProjectFile[]) => <ul className="grid gap-px">{items.map(file => <FileRow key={file.key} file={file} active={file.key === active?.key} open={() => select(file.key)} t={t} />)}</ul>;
  return <div data-studio-files className="grid min-h-0 flex-1 lg:grid-cols-[minmax(17rem,21rem)_minmax(0,1fr)]">
    <nav aria-label={t.files} className={cn("min-h-0 overflow-y-auto p-2 lg:border-r", active && "max-lg:hidden")}>
      <h2 className="sr-only">{t.files}</h2>
      <div className="flex items-start gap-2 px-2 pt-1 pb-3"><FileSource versionLabel={versionLabel} error={filesError} t={t} className="min-w-0 flex-1" />{action}</div>
      {!!documents.length && <div className="grid gap-1"><p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{t.intakeDocuments} · {documents.length}</p>{list(documents)}</div>}
      {!!others.length && <div className={cn("grid gap-1", !!documents.length && "mt-4")}><p className="px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{documents.length ? t.otherFiles : t.files} · {others.length}</p>{list(others)}</div>}
    </nav>
    <div className={cn("min-h-0 min-w-0", !active && "max-lg:hidden")}>
      {active ? <FileViewer key={active.key} file={active} position={position} total={files.length} select={offset => select(files[position + offset]?.key)} close={wide ? undefined : () => select(undefined)} reveal={reveal} t={t} /> : <p className="grid size-full place-items-center text-ui text-muted-foreground">{t.selectFile}</p>}
    </div>
  </div>;
}

/** Adds references to a branch between rounds. They become unresolved intake documents and a new version. */
export function AddFiles({ projectId, branch, disabled, reveal, t }: { projectId: string; branch: string; disabled?: boolean; reveal?: () => void; t: Copy }) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const add = useMutation({
    mutationFn: (files: File[]) => {
      const data = new FormData();
      data.set("projectId", projectId); data.set("branch", branch);
      for (const file of files) data.append("files", file);
      return addReferences({ data });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["studio-project", projectId] }),
  });
  return <div className="grid justify-items-center gap-1">
    <div className="flex items-center gap-1">
      {reveal && <button type="button" onClick={reveal} aria-label={t.openFolder} title={t.openFolder} className={projectIconButton}><FolderOpenIcon /></button>}
      <Button type="button" size="sm" variant="outline" disabled={disabled || add.isPending} onClick={() => input.current?.click()}><PlusIcon />{add.isPending ? t.addingFiles : t.addFiles}</Button>
    </div>
    <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.svg,.txt,.md,.json" className="sr-only" tabIndex={-1} onChange={event => {const files = [...event.target.files ?? []]; event.target.value = ""; if (files.length) add.mutate(files);}} />
    {add.error && <p role="alert" className="max-w-60 text-xs text-destructive">{add.error.message}</p>}
  </div>;
}
