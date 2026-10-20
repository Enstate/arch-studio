import type { ReviewNote } from "@arch/project";
import { ArchMark } from "@arch/ui/components/arch-logo";
import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@arch/ui/components/dropdown-menu";
import { Input } from "@arch/ui/components/input";
import { ProjectLayout, ProjectPage, ProjectSidebar, projectIconButton, projectNavItem } from "@arch/ui/components/project-layout";
import { Textarea } from "@arch/ui/components/textarea";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useIsMobile } from "@arch/ui/hooks/use-mobile";
import { UiLabelsProvider } from "@arch/ui/lib/ui-labels";
import { useTheme } from "@arch/ui/lib/theme";
import { ViewerSurface, ViewerLocaleProvider, type ViewerInstance } from "@arch/viewer-ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, ChevronsUpDownIcon, HammerIcon, InfoIcon, MenuIcon, PanelLeftIcon, PlusIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { brief, buildVersion, catalog, createClient, createProject, handoff, openVersion, projectDetails, restoreSource, saveNote } from "../lib/server";
import type { StudioCatalog, StudioProjectSummary, StudioVersion } from "../lib/model";
import { type Locale, studioText } from "../lib/messages";
import { SourceSetup } from "./source-setup";

type Copy = typeof studioText.en;
type Section = "preview" | "source" | "versions" | "outputs" | "notes" | "files" | "handoff";
export function Studio() {
  const [locale, setLocale] = useState<Locale>(() => typeof document !== "undefined" && document.cookie.includes("arch-locale=en") ? "en" : "de");
  const t = studioText[locale];
  function changeLocale() { const next = locale === "de" ? "en" : "de"; document.cookie = `arch-locale=${next}; Path=/; SameSite=Lax`; setLocale(next); }
  return <ViewerLocaleProvider locale={locale}><UiLabelsProvider value={{ close: t.close, loading: t.loading, toggleSidebar: t.toggleSidebar, navigation: t.mobileTitle, navigationDescription: t.mobileDescription, scrollToEnd: t.scrollToEnd, scrollToStart: t.scrollToStart }}><Clients t={t} locale={locale} changeLocale={changeLocale} /></UiLabelsProvider></ViewerLocaleProvider>;
}
function Clients({t, locale, changeLocale}: {t: Copy; locale: Locale; changeLocale: () => void}) {
  const queryClient = useQueryClient();
  const clients = useQuery({queryKey: ["studio-catalog"], queryFn: () => catalog(), refetchInterval: 5000});
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const client = clients.data?.clients.find(item => item.id === selected) ?? clients.data?.clients[0];
  const create = useMutation({mutationFn: (fields: FormData) => createClient({data: {id: String(fields.get("key")), name: String(fields.get("name"))}}), onSuccess: async id => { setSelected(id); setCreating(false); await queryClient.invalidateQueries(); }});
  const header = <DropdownMenu><DropdownMenuTrigger aria-label={t.clients} className="flex h-7.5 max-w-full min-w-0 items-center gap-2 rounded-[7px] pr-2 pl-1.5 text-sm font-semibold hover:bg-foreground/7 max-md:h-11"><span aria-hidden="true" className="grid size-4.5 shrink-0 place-items-center rounded-[5px] bg-foreground text-background"><ArchMark className="h-2" /></span><span className="min-w-0 truncate">{client?.name ?? t.clients}</span><ChevronsUpDownIcon className="size-3.5 text-muted-foreground" /></DropdownMenuTrigger><DropdownMenuContent className="w-64">{clients.data?.clients.map(item => <DropdownMenuItem key={item.id} onClick={() => setSelected(item.id)}><span className="flex-1 truncate">{item.name}</span>{client?.id === item.id && <CheckIcon />}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onClick={() => {create.reset(); setCreating(true);}}><PlusIcon />{t.newClient}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
  return <><Workspace key={client?.id ?? "empty"} clientId={client?.id} catalog={clients.data} t={t} header={header} footer={<StudioFooter t={t} locale={locale} changeLocale={changeLocale} />} pending={clients.isPending} error={clients.isError} retry={() => {void clients.refetch();}} createClient={() => setCreating(true)} /><Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>{t.newClient}</DialogTitle><DialogDescription>{t.clientKeyHint}</DialogDescription></DialogHeader><form onSubmit={event => {event.preventDefault(); create.mutate(new FormData(event.currentTarget));}} className="grid gap-4 text-ui"><label className="grid gap-2">{t.clientName}<Input name="name" required maxLength={160} /></label><label className="grid gap-2">{t.clientKey}<Input name="key" required maxLength={80} pattern="[a-z0-9][a-z0-9-]*" /></label>{create.error && <p role="alert" className="text-destructive">{create.error.message}</p>}<Button type="submit" disabled={create.isPending}>{create.isPending ? t.loading : t.newClient}</Button></form></DialogContent></Dialog></>;
}
function StudioFooter({t, locale, changeLocale}: {t: Copy; locale: Locale; changeLocale: () => void}) {
  const {theme, setTheme} = useTheme();
  return <><p className="px-2 py-2 text-xs text-muted-foreground">{t.local}</p><DropdownMenu><DropdownMenuTrigger className={projectNavItem}><ArchMark /><span className="flex-1">{t.studio}</span><ChevronsUpDownIcon /></DropdownMenuTrigger><DropdownMenuContent side="top"><DropdownMenuItem onClick={changeLocale}>{t.language}<span className="ml-auto">{locale === "de" ? "English" : "Deutsch"}</span></DropdownMenuItem>{(["system", "light", "dark"] as const).map(value => <DropdownMenuItem key={value} onClick={() => setTheme(value)}><span className="flex-1">{t[value]}</span>{theme === value && <CheckIcon />}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></>;
}
function Workspace({clientId, catalog: data, t, header, footer, pending, error, retry, createClient: newClient}: {clientId?: string; catalog?: StudioCatalog; t: Copy; header: ReactNode; footer: ReactNode; pending: boolean; error: boolean; retry: () => void; createClient: () => void}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string>();
  const [search, setSearch] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  const searchInput = useRef<HTMLInputElement>(null);
  const projects = data?.projects.filter(item => item.clientId === clientId) ?? [];
  const project = projects.find(item => item.id === selected) ?? projects[0];
  const create = useMutation({mutationFn: (name: string) => createProject({data: {clientId: clientId!, name}}), onSuccess: async id => {setSelected(id); setNewProjectOpen(false); await queryClient.invalidateQueries();}});
  const toggleSidebar = () => isMobile ? setMobileOpen(open => !open) : setSidebarOpen(open => !open);
  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+k", () => {if (isMobile) setMobileOpen(true); else setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus());});
  useHotkey("n", () => {if (clientId) setNewProjectOpen(true);});
  const toggle = <button type="button" className={projectIconButton} onClick={toggleSidebar} aria-label={t.hideSidebar}><PanelLeftIcon /></button>;
  const navigation = isMobile || !sidebarOpen ? <button type="button" className={projectIconButton} onClick={toggleSidebar} aria-label={t.openMenu}>{isMobile ? <MenuIcon /> : <PanelLeftIcon />}</button> : undefined;
  const sidebar = <ProjectSidebar header={header} toggle={toggle} footer={footer}><div className="relative mb-2.5"><SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" /><Input ref={searchInput} value={search} onChange={event => setSearch(event.target.value)} aria-label={t.search} placeholder={t.search} className="h-8 pl-8 text-ui" /></div><button type="button" className={projectNavItem} disabled={!clientId} onClick={() => {create.reset(); setNewProjectOpen(true);}}><PlusIcon />{t.newProject}</button><button type="button" className={projectNavItem} onClick={() => setImportOpen(true)}>{t.restore}</button><nav className="mt-4 min-h-0 flex-1 overflow-y-auto" aria-label={t.projects}><h2 className="px-2 py-2 text-xs text-muted-foreground">{t.projects}</h2>{projects.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(item => <button type="button" key={item.id} aria-current={project?.id === item.id ? "page" : undefined} className={projectNavItem} onClick={() => {setSelected(item.id); setMobileOpen(false);}}><span className="truncate">{item.name}</span></button>)}{!projects.length && <p className="px-2 text-xs text-muted-foreground">{t.noProjects}</p>}</nav></ProjectSidebar>;
  return <><ProjectLayout sidebar={sidebar} sidebarOpen={sidebarOpen} isMobile={isMobile} mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen} labels={{skipToContent: t.skipToContent, sidebar: t.sidebar, mobileTitle: t.mobileTitle, mobileDescription: t.mobileDescription}}>{error ? <ProjectPage title={t.studio} navigation={navigation}><div className="m-auto grid gap-3"><p role="alert">{t.error}</p><Button onClick={retry}>{t.retry}</Button></div></ProjectPage> : project ? <Project key={project.id} project={project} t={t} navigation={navigation} /> : <ProjectPage title={t.studio} navigation={navigation}><div className="m-auto grid max-w-sm gap-4 p-6 text-center text-ui"><p>{pending ? t.loading : clientId ? t.noProjects : t.noClients}</p><Button disabled={pending} onClick={() => clientId ? setNewProjectOpen(true) : newClient()}>{clientId ? t.newProject : t.newClient}</Button><Button variant="outline" onClick={() => setImportOpen(true)}>{t.restore}</Button></div></ProjectPage>}</ProjectLayout><Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}><DialogContent><DialogHeader><DialogTitle>{t.newProject}</DialogTitle></DialogHeader><form className="grid gap-4" onSubmit={event => {event.preventDefault(); create.mutate(String(new FormData(event.currentTarget).get("name")));}}><label className="grid gap-2">{t.name}<Input name="name" required /></label>{create.error && <p role="alert">{create.error.message}</p>}<Button type="submit" disabled={create.isPending}>{t.create}</Button></form></DialogContent></Dialog><Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>{t.restore}</DialogTitle></DialogHeader><Handoff t={t} /></DialogContent></Dialog></>;
}
function Project({project, t, navigation}: {project: StudioProjectSummary; t: Copy; navigation: ReactNode}) {
  const queryClient = useQueryClient();
  const details = useQuery({queryKey: ["studio-project", project.id], queryFn: () => projectDetails({data: {projectId: project.id}}), refetchInterval: 5000});
  const [versionId, setVersionId] = useState<string>();
  if (!versionId && details.data?.versions[0]) setVersionId(details.data.versions[0].id);
  const [section, setSection] = useState<Section>("preview");
  const [confirmBuild, setConfirmBuild] = useState(false);
  const version = details.data?.versions.find(item => item.id === versionId) ?? details.data?.versions[0];
  const source = details.data?.source;
  const build = useMutation({mutationFn: () => buildVersion({data: {sourceId: source!.manifest.id, projectId: project.id, authorizeSourceExecution: true}}), onSuccess: async value => {setVersionId(value.versionId); setSection("preview"); setConfirmBuild(false); await queryClient.invalidateQueries();}});
  const sections: Section[] = ["preview", "source", "versions", "outputs", "notes", "files", "handoff"];
  const actions = <>{!!details.data?.versions.length && <select aria-label={t.versions} className="h-7 max-w-32 rounded-md border bg-background px-2 text-xs" value={version?.id ?? ""} onChange={event => setVersionId(event.target.value)}>{details.data.versions.map(item => <option key={item.id} value={item.id}>{item.checkpointId.slice(0,12)}</option>)}</select>}<Button size="sm" variant="outline" disabled={!source || build.isPending} onClick={() => setConfirmBuild(true)}><HammerIcon /><span className="max-sm:sr-only">{build.isPending ? t.building : t.build}</span></Button><a href="https://arch.enstate-labs.workers.dev/staff" target="_blank" rel="noreferrer" aria-label={t.hosted} className={projectIconButton}><ArrowUpRightIcon /></a><DropdownMenu><DropdownMenuTrigger className={projectIconButton} aria-label={t.projectSections}><InfoIcon /></DropdownMenuTrigger><DropdownMenuContent align="end">{sections.map(value => <DropdownMenuItem key={value} onClick={() => setSection(value)}><span className="flex-1">{value === "preview" ? t.viewProject : t[value]}</span>{section === value && <CheckIcon />}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></>;
  return <><ProjectPage title={project.name} navigation={navigation} actions={actions}>{details.isError ? <div className="m-auto grid gap-3"><p role="alert">{details.error.message}</p><Button onClick={() => {void details.refetch();}}>{t.retry}</Button></div> : section === "preview" && version?.hasArtifact ? <VersionPreview key={version.id} version={version} t={t} /> : <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto grid w-full max-w-3xl gap-6 px-6 py-8 text-ui"><header className="flex items-center gap-3"><h2 className="flex-1 text-lg font-medium">{section === "preview" ? t.source : t[section]}</h2>{section !== "preview" && <Button size="sm" variant="ghost" onClick={() => setSection("preview")}>{t.viewProject}</Button>}</header>{details.isPending ? <p role="status">{t.loading}</p> : <>
    {(section === "source" || section === "preview") && <div className="grid gap-4"><p className="text-muted-foreground">{source?.directory ?? t.noSources}</p>{section === "preview" && <p className="text-muted-foreground">{t.noArtifact}</p>}<SourceSetup projectId={project.id} attached={!!source} t={t} /></div>}
    {section === "versions" && <div className="grid gap-3">{!details.data?.versions.length && <p>{t.noVersions}</p>}{details.data?.versions.map(item => <button type="button" key={item.id} onClick={() => {setVersionId(item.id); setSection("preview");}} className="rounded-xl border p-4 text-left hover:bg-accent"><span className="block font-mono text-xs">{item.checkpointId.slice(0,12)}</span><span className="text-xs text-muted-foreground">{item.hasArtifact ? t.ready : t.sourceCheckpoint}</span></button>)}</div>}
    {section === "outputs" && (version ? <VersionMedia version={version} t={t} /> : <p>{t.noVersions}</p>)}
    {section === "files" && <div className="grid gap-3"><p className="text-muted-foreground">{t.filesHint}</p>{!version?.references.length && <p>{t.noFiles}</p>}{version?.references.map(file => <a key={file.path} href={file.url} target="_blank" rel="noreferrer" className="rounded-lg border p-3 underline underline-offset-4">{file.label}</a>)}</div>}
    {section === "notes" && (version ? <Notes key={version.id} projectId={project.id} version={version} notes={details.data?.notes ?? []} t={t} /> : <p>{t.noVersions}</p>)}
    {section === "handoff" && <Handoff key={version?.id} checkpointId={version?.checkpointId} t={t} />}
    </>}</div></div>}</ProjectPage><Dialog open={confirmBuild} onOpenChange={value => {if (!build.isPending) setConfirmBuild(value);}}><DialogContent><DialogHeader><DialogTitle>{t.build}</DialogTitle><DialogDescription>{t.executionConfirmation}</DialogDescription></DialogHeader><p className="break-all font-mono text-xs">{source?.directory}</p>{build.error && <p role="alert" className="text-destructive">{build.error.message}</p>}<div className="flex justify-end gap-2"><Button variant="ghost" disabled={build.isPending} onClick={() => setConfirmBuild(false)}>{t.cancel}</Button><Button disabled={!source || build.isPending} onClick={() => build.mutate()}>{build.isPending ? t.building : t.authorizeBuild}</Button></div></DialogContent></Dialog></>;
}
function VersionPreview({version, t}: {version: StudioVersion; t: Copy}) {
  const preview = useQuery({queryKey: ["studio-preview", version.checkpointId], queryFn: () => openVersion({data: {checkpointId: version.checkpointId}}), staleTime: 60_000, retry: false});
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const currentViewer = useRef<ViewerInstance | null>(null);
  const onViewer = useCallback((viewer: ViewerInstance | null) => {
    currentViewer.current = viewer;
    setReady(false);
    if (viewer) void viewer.ready.then(() => {
      if (currentViewer.current === viewer) setReady(true);
    }).catch(() => {
      if (currentViewer.current === viewer) setError(t.error);
    });
  }, [t.error]);
  return <div data-studio-preview={error ? "error" : ready ? "ready" : "pending"} className="relative size-full min-h-0">{preview.data ? <ViewerSurface planUrl={preview.data.planUrl} assetBase={preview.data.assetBase} artifactId={preview.data.artifactHash} onViewer={onViewer} /> : <div className="grid size-full place-items-center p-6"><div className="grid gap-3 text-center text-ui"><p role={preview.isError ? "alert" : "status"}>{preview.isError ? preview.error.message : t.preparing}</p>{preview.isError && <Button onClick={() => {void preview.refetch();}}>{t.retry}</Button>}</div></div>}{preview.data && <p role="status" className="pointer-events-none absolute top-3 right-3 rounded-lg bg-background/90 px-3 py-2 text-xs shadow-sm">{error || (ready ? t.ready : t.preparing)}</p>}</div>;
}
function VersionMedia({version, t}: {version: StudioVersion; t: Copy}) {
  if (!version.outputs.length) return <p className="text-muted-foreground">{t.noOutputs}</p>;
  return <div className="space-y-4">{version.outputs.map(output => <figure key={output.id} className="space-y-2">{output.kind === "still" ? <a href={output.url} target="_blank" rel="noreferrer"><img src={output.url} alt={output.label} loading="lazy" className="w-full rounded-lg border object-contain" /></a> : <video src={output.url} aria-label={output.label} controls muted playsInline preload="metadata" className="w-full rounded-lg border" />}<figcaption>{output.label}<a href={output.url} download target="_blank" rel="noreferrer" className="block text-xs underline">{t.openOutput}</a></figcaption></figure>)}</div>;
}
function Notes({projectId, version, notes, t}: {projectId: string; version: StudioVersion; notes: ReviewNote[]; t: Copy}) {
  const queryClient = useQueryClient();
  const save = useMutation({mutationFn: (body: string) => saveNote({data: {projectId, checkpointId: version.checkpointId, body}}), onSuccess: () => queryClient.invalidateQueries({queryKey: ["studio-project", projectId]})});
  const selected = notes.filter(note => note.checkpointId === version.checkpointId);
  return <div className="grid gap-5"><p className="text-xs text-muted-foreground">{t.notesHint}</p><form className="grid gap-2" onSubmit={async event => {event.preventDefault(); const form = event.currentTarget; try {await save.mutateAsync(String(new FormData(form).get("body"))); form.reset();} catch { /* Mutation error is rendered below. */ }}}><Textarea name="body" aria-label={t.comment} required maxLength={8000} disabled={save.isPending} /><Button type="submit" disabled={save.isPending}>{save.isPending ? t.loading : t.save}</Button></form>{save.error && <p role="alert" className="text-destructive">{save.error.message}</p>}{!selected.length && <p>{t.noComments}</p>}{selected.map(note => <article key={note.id} className="space-y-2 border-b pb-4"><p className="text-xs text-muted-foreground">{note.author} · {note.createdAt}</p><p className="whitespace-pre-wrap">{note.body}</p></article>)}</div>;
}
function Handoff({checkpointId, t}: {checkpointId?: string; t: Copy}) {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const action = useMutation({mutationFn: async ({kind, fields}: {kind: "brief" | "export" | "restore"; fields?: FormData}) => {
    if (kind === "brief") return brief({data: {checkpointId: checkpointId!}});
    if (kind === "export") return handoff({data: {checkpointId: checkpointId!, directory: String(fields!.get("directory"))}});
    await restoreSource({data: {bundle: String(fields!.get("bundle")), directory: String(fields!.get("directory"))}}); await queryClient.invalidateQueries(); return t.done;
  }, onSuccess: setText});
  return <div className="grid gap-4"><p className="text-xs text-muted-foreground">{t.hostedHint}</p>{checkpointId && <><Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({kind: "brief"})}>{t.brief}</Button><form className="grid gap-2" onSubmit={event => {event.preventDefault(); action.mutate({kind: "export", fields: new FormData(event.currentTarget)});}}><Input name="directory" required aria-label={t.destination} placeholder={t.destination} /><Button type="submit" disabled={action.isPending}>{t.export}</Button></form></>}<form className="grid gap-2" onSubmit={event => {event.preventDefault(); action.mutate({kind: "restore", fields: new FormData(event.currentTarget)});}}><Input name="bundle" required aria-label={t.bundle} placeholder={t.bundle} /><Input name="directory" required aria-label={t.destination} placeholder={t.destination} /><Button type="submit" variant="outline" disabled={action.isPending}>{t.restore}</Button></form>{action.error && <p role="alert" className="text-destructive">{action.error.message}</p>}<pre className="overflow-auto whitespace-pre-wrap text-xs">{text}</pre></div>;
}
