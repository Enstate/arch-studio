import { StudioFailure } from "./studio-failure";
import { Button } from "@arch/ui/components/button";
import { DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@arch/ui/components/collapsible";
import { Field, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { Spinner } from "@arch/ui/components/spinner";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, DownloadIcon, FolderOpenIcon, GitBranchIcon } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { brief, exportProject, handoff, openProjectFile, restoreSource, stageProjectFile } from "../lib/server";
import type { studioText } from "../lib/messages";
import { useStudioFormat } from "../lib/locale";
import { variantName } from "./project-panel";

type Copy = typeof studioText.en;
export const projectFileType = ".archproject";

/** A folded section for the hosted platform's folder handoff. Most people never open it. */
function Advanced({title, children}: {title: string; children: ReactNode}) {
  return <Collapsible className="border-t pt-3">
    <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"><span className="flex-1">{title}</span><ChevronDownIcon className="size-3.5 transition-transform group-data-[panel-open]:rotate-180" /></CollapsibleTrigger>
    <CollapsibleContent className="pt-3">{children}</CollapsibleContent>
  </Collapsible>;
}

/** One file with the whole project, saved through the browser or the desktop save dialog. */
export function ShareProject({projectId, checkpointId, t}: {projectId: string; checkpointId?: string; t: Copy}) {
  const format = useStudioFormat();
  const save = useMutation({mutationFn: () => exportProject({data: {projectId}}), onSuccess: value => {
    const link = document.createElement("a");
    link.href = value.url; link.download = value.fileName;
    link.click();
  }});
  const size = save.data && format.number(Math.max(0.1, save.data.bytes / 1024 / 1024), {style: "unit", unit: "megabyte", unitDisplay: "short", maximumFractionDigits: 1});
  return <div className="grid gap-4 text-ui">
    <p className="text-muted-foreground">{t.shareHint}</p>
    <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <><Spinner />{t.preparingProjectFile}</> : <><DownloadIcon />{t.saveProjectFile}</>}</Button>
    {save.data && <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground"><CheckIcon className="size-3.5" />{t.projectFileReady.replace("{name}", save.data.fileName).replace("{size}", size ?? "")}</p>}
    {!!save.data?.unsaved.length && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{t.shareUnsaved.replace("{names}", save.data.unsaved.map(name => variantName(name, t)).join(", "))}</p>}
    {save.error && <StudioFailure className="text-destructive" error={save.error} />}
    {checkpointId && <Advanced title={t.hostedOptions}><HostedExport checkpointId={checkpointId} t={t} /></Advanced>}
  </div>;
}

/**
 * Opens a project file someone sent. Studio reads it first and says what it holds, or, for a
 * project already here, what it adds. Applying only adds; the new project still asks before
 * running its code.
 */
export function OpenProject({path, opened, t}: {path?: string; opened: (projectId: string) => void; t: Copy}) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({mutationFn: (file: File) => {const data = new FormData(); data.set("file", file); return stageProjectFile({data});}});
  const sent = useQuery({queryKey: ["studio-opened-project-file", path], queryFn: () => stageProjectFile({data: {path: path!}}), enabled: !!path, staleTime: Infinity, gcTime: 0, retry: false});
  const preview = path ? sent.data : upload.data;
  const reading = path ? sent.isPending : upload.isPending;
  const readError = path ? sent.error : upload.error;
  const apply = useMutation({mutationFn: (uploadId: string) => openProjectFile({data: {uploadId}}), onSuccess: async value => {await queryClient.invalidateQueries(); opened(value.projectId);}});
  const choose = <>
    <Button disabled={upload.isPending} onClick={() => input.current?.click()}>{upload.isPending ? <><Spinner />{t.readingProjectFile}</> : <><FolderOpenIcon />{t.chooseProjectFile}</>}</Button>
    <input ref={input} type="file" accept={projectFileType} className="sr-only" tabIndex={-1} onChange={event => {const file = event.target.files?.[0]; event.target.value = ""; if (file) {apply.reset(); upload.mutate(file);}}} />
  </>;
  if (!preview) return <><DialogHeader><DialogTitle>{t.openProjectFile}</DialogTitle></DialogHeader><div className="grid gap-4 text-ui">
    {path ? <p role="status" className="flex items-center gap-2 text-muted-foreground">{reading && <Spinner />}{reading ? t.readingProjectFile : t.openProjectFileHint}</p> : <p className="text-muted-foreground">{t.openProjectFileHint}</p>}
    {(!path || readError) && choose}
    {readError && <StudioFailure className="text-destructive" error={readError} />}
    {!path && <Advanced title={t.restoreHandoffFolder}><HostedRestore t={t} /></Advanced>}
  </div></>;
  const changes = preview.changes;
  const upToDate = !!changes && !changes.versions && !changes.conversations && !changes.notes && !changes.variants.length;
  const title = (upToDate ? t.projectUpToDate : changes ? t.updateProjectTitle : t.openProjectTitle).replace("{name}", preview.existing?.name ?? preview.name);
  const counts = changes ? [[t.newVersions, changes.versions], [t.newConversations, changes.conversations], [t.newNotes, changes.notes]] as const : [[t.versions, preview.versions], [t.threads, preview.conversations], [t.notes, preview.notes]] as const;
  const variant = (name: string) => variantName(name, t);
  return <><DialogHeader><DialogTitle>{title}</DialogTitle>{!changes && preview.clientName && <DialogDescription>{preview.clientName}</DialogDescription>}</DialogHeader><div className="grid gap-4 text-ui">
    {upToDate ? <p className="text-muted-foreground">{t.alreadyHaveEverything}</p> : <>
      {changes && <p className="text-muted-foreground">{t.alreadyHaveProject}</p>}
      <dl className="flex flex-wrap gap-2">{counts.filter(([, count]) => !changes || count > 0).map(([label, count]) => <div key={label} className="grid min-w-28 flex-1 gap-0.5 rounded-lg border px-3 py-2"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="text-lg font-medium tabular-nums">{count}</dd></div>)}</dl>
      {!!changes?.variants.length && <ul className="grid gap-1.5">{changes.variants.map(item => <li key={item.name} className="flex items-start gap-2"><GitBranchIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /><span>{(item.outcome === "updated" ? t.variantUpdated : item.outcome === "added" ? t.variantAdded : t.variantKeptSeparately).replace("{name}", variant(item.name)).replace("{as}", item.as ?? "")}</span></li>)}</ul>}
      <p className="text-xs text-muted-foreground">{changes ? t.nothingRemoved : t.asksBeforeRunning}</p>
    </>}
    {apply.error && <StudioFailure className="text-destructive" error={apply.error} />}
    <div className="flex justify-end gap-2">
      {!path && !upToDate && <Button variant="ghost" disabled={apply.isPending} onClick={() => {upload.reset(); apply.reset();}}>{t.back}</Button>}
      <Button disabled={apply.isPending} onClick={() => upToDate && preview.existing ? opened(preview.existing.projectId) : apply.mutate(preview.uploadId)}>{apply.isPending ? <Spinner /> : null}{upToDate || !changes ? t.openProjectAction : t.updateProjectAction}</Button>
    </div>
  </div></>;
}

/** The hosted platform's folder handoff for one version, and the brief an agent continues from. */
function HostedExport({checkpointId, t}: {checkpointId: string; t: Copy}) {
  const formId = useId();
  const [text, setText] = useState("");
  const action = useMutation({mutationFn: (request: {kind: "brief"} | {kind: "export"; directory: string}) => request.kind === "brief" ? brief({data: {checkpointId}}) : handoff({data: {checkpointId, directory: request.directory}}), onSuccess: setText});
  const form = useForm({defaultValues: {directory: ""}, onSubmit: ({value}) => {if (!action.isPending) action.mutate({kind: "export", ...value});}});
  return <div className="grid gap-3"><p className="text-xs text-muted-foreground">{t.hostedHint}</p>
    <form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}>
      <form.Field name="directory">{field => <Field className="gap-2"><FieldLabel htmlFor={`${formId}-export-directory`} className="text-xs font-normal">{t.destination}</FieldLabel><Input id={`${formId}-export-directory`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={action.isPending} /></Field>}</form.Field>
      <div className="flex gap-2"><Button type="submit" size="sm" variant="outline" disabled={action.isPending}>{t.export}</Button><Button type="button" size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate({kind: "brief"})}>{t.brief}</Button></div>
    </form>
    {action.error && <StudioFailure className="text-destructive" error={action.error} />}
    {text && <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">{text}</pre>}
  </div>;
}

function HostedRestore({t}: {t: Copy}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const restore = useMutation({mutationFn: async (value: {bundle: string; directory: string; activate: boolean}) => {await restoreSource({data: value}); await queryClient.invalidateQueries();}});
  const form = useForm({defaultValues: {bundle: "", directory: "", activate: false}, onSubmit: ({value}) => {if (!restore.isPending) restore.mutate(value);}});
  return <form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}>
    <form.Field name="bundle">{field => <Field className="gap-2"><FieldLabel htmlFor={`${formId}-restore-bundle`} className="text-xs font-normal">{t.bundle}</FieldLabel><Input id={`${formId}-restore-bundle`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={restore.isPending} /></Field>}</form.Field>
    <form.Field name="directory">{field => <Field className="gap-2"><FieldLabel htmlFor={`${formId}-restore-directory`} className="text-xs font-normal">{t.destination}</FieldLabel><Input id={`${formId}-restore-directory`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={restore.isPending} /></Field>}</form.Field>
    <form.Field name="activate">{field => <Field orientation="horizontal" className="items-start gap-2 text-xs"><input id={`${formId}-restore-activate`} type="checkbox" name={field.name} checked={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.checked)} autoComplete="off" className="mt-0.5" disabled={restore.isPending} /><FieldLabel htmlFor={`${formId}-restore-activate`} className="text-xs font-normal">{t.activateRestoredSource}</FieldLabel></Field>}</form.Field>
    <Button type="submit" size="sm" variant="outline" disabled={restore.isPending}>{restore.isSuccess ? t.done : t.restore}</Button>
    {restore.error && <StudioFailure className="text-destructive" error={restore.error} />}
  </form>;
}
