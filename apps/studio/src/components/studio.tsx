import { threadTitle } from "../lib/thread-title";
import { StudioFailure } from "./studio-failure";
import { studioFailure } from "../lib/studio-errors";
import type { ReviewNote } from "@arch/project";
import { ArchMark } from "@arch/ui/components/arch-logo";
import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@arch/ui/components/dropdown-menu";
import { Field, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { ProjectLayout, ProjectPage, projectIconButton } from "@arch/ui/components/project-layout";
import { Textarea } from "@arch/ui/components/textarea";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useIsMobile } from "@arch/ui/hooks/use-mobile";
import { UiLabelsProvider } from "@arch/ui/lib/ui-labels";
import { useTheme } from "@arch/ui/lib/theme";
import { cn } from "@arch/ui/lib/utils";
import { ASSET_BASE, ViewerSurface, ViewerLocaleProvider, type ViewerEditing, type ViewerInstance } from "@arch/viewer-ui";
import { hasEdits, type PlanEdits } from "@arch/viewer/plan/edits";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, ChevronsUpDownIcon, HammerIcon, FolderOpenIcon, FolderPlusIcon, LanguagesIcon, MoreHorizontalIcon, PaletteIcon, MenuIcon, PanelLeftIcon, PlusIcon, SearchIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { revealInFolder, brief, buildGrant, buildVersion, catalog, projectEdits, saveEdits, createClient, createThread, threadList, updateThread, grantBuilds, handoff, makePrimary, openProjectFolder, openVersion, projectDetails, restoreSource, revokeBuilds, saveNote } from "../lib/server";
import { VIEWER_MISMATCH, type StudioProjectSummary, type StudioThread, type StudioVersion } from "../lib/model";
import { type Locale, studioText } from "../lib/messages";
import { languageNames, useStudioFormat, useStudioLocale } from "../lib/locale";
import { SourceSetup } from "./source-setup";
import { IntakeOverview, WorkPlan } from "./intake-overview";
import { AddFiles, ProjectFiles, projectFiles } from "./project-files";
import { DesktopUpdates } from "./desktop-updates";
import { NewProject } from "./new-project";
import { Rounds, branchVersions } from "./rounds";
import { Compare } from "./compare";
import { ProjectBadge, type ThreadActionHandler, ThreadList } from "./thread-sidebar";
import { ProjectPanel } from "./project-panel";

type Copy = typeof studioText.en;
type Section = "rounds" | "preview" | "intake" | "work" | "files" | "compare" | "source" | "outputs" | "notes";
export function Studio() {
  const {locale, selectLocale} = useStudioLocale();
  const t = studioText[locale];
  return <ViewerLocaleProvider locale={locale}><UiLabelsProvider value={{ close: t.close, loading: t.loading, toggleSidebar: t.toggleSidebar, navigation: t.mobileTitle, navigationDescription: t.mobileDescription, scrollToEnd: t.scrollToEnd, scrollToStart: t.scrollToStart }}><Shell t={t} locale={locale} changeLocale={selectLocale} /></UiLabelsProvider></ViewerLocaleProvider>;
}
type Filter = {kind: "all"} | {kind: "client"; id: string} | {kind: "project"; id: string};
/** Threads from every project in one list, as in T3 Code. Opening one puts you on its project. */
function Shell({t, locale, changeLocale}: {t: Copy; locale: Locale; changeLocale: (locale: Locale) => void}) {
  const queryClient = useQueryClient();
  const studio = useQuery({queryKey: ["studio-catalog"], queryFn: () => catalog(), refetchInterval: 5000});
  const threads = useQuery({queryKey: ["studio-threads"], queryFn: () => threadList(), refetchInterval: 2000});
  const [selection, setSelection] = useState<{threadId?: string; projectId?: string}>({});
  const [sections, setSections] = useState<Record<string, Section>>({});
  const [filter, setFilter] = useState<Filter>({kind: "all"});
  const [search, setSearch] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  const [directory, setDirectory] = useState("");
  const [folderError, setFolderError] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [creatingClient, setCreatingClient] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  const searchInput = useRef<HTMLInputElement>(null);
  const data = studio.data;
  const all = threads.data ?? [];
  const now = Date.now();
  // A selected project without a thread id opens its oldest thread once the list has it.
  // With nothing chosen yet, open the most recently active thread, as T3 Code opens recent work.
  const recent = (item: StudioThread) => [item.latestCompletedAt, item.latestRequestAt, item.createdAt].filter(Boolean).sort().at(-1) ?? "";
  const thread = all.find(item => item.id === selection.threadId)
    ?? (selection.projectId ? all.filter(item => item.projectId === selection.projectId).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
    : selection.threadId ? undefined : [...all].sort((a, b) => recent(b).localeCompare(recent(a)))[0]);
  const project = data?.projects.find(item => item.id === (thread?.projectId ?? selection.projectId));
  const sectionKey = thread?.id ?? project?.id ?? "";
  const section = sections[sectionKey] ?? "rounds";
  const setSection = (value: Section) => setSections(current => ({...current, [sectionKey]: value}));
  const visit = (target: StudioThread | undefined) => {if (target) void updateThread({data: {projectId: target.projectId, threadId: target.id, action: {kind: "visit"}}});};
  // Leaving a thread marks what you saw there as read, as does opening one.
  const select = (next: StudioThread) => {if (thread?.id !== next.id) visit(thread); visit(next); setSelection({threadId: next.id}); setMobileOpen(false);};
  const act = useMutation({mutationFn: ({target, action}: {target: StudioThread; action: Exclude<Parameters<ThreadActionHandler>[1], {kind: "newThread"}>}) => updateThread({data: {projectId: target.projectId, threadId: target.id, action}}), onSuccess: () => queryClient.invalidateQueries({queryKey: ["studio-threads"]})});
  const create = useMutation({mutationFn: (input: {projectId: string; branch?: string; fromCheckpoint?: string}) => createThread({data: input}), onSuccess: async (value, input) => {await queryClient.invalidateQueries({queryKey: ["studio-threads"]}); visit(thread); setSelection({threadId: value.threadId, projectId: input.projectId}); setSections(current => ({...current, [value.threadId]: "rounds"}));}});
  const handle: ThreadActionHandler = (target, action) => action.kind === "newThread" ? create.mutate({projectId: target.projectId, branch: target.branch}) : act.mutate({target, action});
  const openFolder = useMutation({mutationFn: (directory: string) => openProjectFolder({data: {directory}}), onSuccess: async value => {
    await queryClient.invalidateQueries();
    setSelection({projectId: value.projectId}); setFolderOpen(false);
  }});
  async function chooseFolder() {
    if (choosingFolder || openFolder.isPending) return;
    openFolder.reset(); setFolderError(false);
    if (!window.archDesktop) {setDirectory(""); setFolderOpen(true); return;}
    setChoosingFolder(true);
    try {
      const path = await window.archDesktop.chooseProjectDirectory();
      if (path) openFolder.mutate(path);
    } catch {setFolderError(true);} finally {setChoosingFolder(false);}
  }
  const createClientMutation = useMutation({mutationFn: (values: {name: string}) => createClient({data: {name: values.name}}), onSuccess: async id => {setFilter({kind: "client", id}); setCreatingClient(false); await queryClient.invalidateQueries();}});
  const clientForm = useForm({defaultValues: {name: ""}, onSubmit: ({value}) => {if (!createClientMutation.isPending) createClientMutation.mutate(value);}});
  const openNewClient = () => {createClientMutation.reset(); clientForm.reset(); setCreatingClient(true);};
  const openNewProject = () => {setMobileOpen(false); setNewProjectOpen(true);};
  // New threads go to the filtered project, else the project you are on; otherwise you pick one.
  const targetProject = filter.kind === "project" ? filter.id : project?.sourceId ? project.id : undefined;
  const newThread = (projectId: string) => create.mutate({projectId, ...(thread && thread.projectId === projectId ? {branch: thread.branch} : {})});
  const toggleSidebar = () => isMobile ? setMobileOpen(open => !open) : setSidebarOpen(open => !open);
  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+k", () => {if (isMobile) setMobileOpen(true); else setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus());});
  // A plain letter would fire while moving around the 3D view with the keyboard, creating stray threads.
  useHotkey("mod+shift+o", event => {if (!(event.target instanceof Element && event.target.closest("[role=dialog],[role=menu],[role=listbox]"))) {if (targetProject) newThread(targetProject); else openNewProject();}});
  const query = search.trim().toLocaleLowerCase();
  const visible = all.filter(item => (filter.kind === "all" || (filter.kind === "client" ? item.clientId === filter.id : item.projectId === filter.id)) && (!query || `${threadTitle(item.title, t)} ${item.projectName} ${item.clientName}`.toLocaleLowerCase().includes(query)));
  const unconnected = (data?.projects ?? []).filter(item => !item.sourceId && (filter.kind === "all" || (filter.kind === "client" ? item.clientId === filter.id : item.id === filter.id)) && (!query || item.name.toLocaleLowerCase().includes(query)));
  const filterLabel = filter.kind === "all" ? t.allProjects : filter.kind === "client" ? data?.clients.find(item => item.id === filter.id)?.name ?? t.allProjects : data?.projects.find(item => item.id === filter.id)?.name ?? t.allProjects;
  const sourceProjects = (data?.projects ?? []).filter(item => item.sourceId);
  const toggle = <button type="button" className={projectIconButton} onClick={toggleSidebar} aria-label={t.hideSidebar}><PanelLeftIcon /></button>;
  const navigation = isMobile || !sidebarOpen ? <button type="button" className={projectIconButton} onClick={toggleSidebar} aria-label={t.openMenu}>{isMobile ? <MenuIcon /> : <PanelLeftIcon />}</button> : undefined;
  const newThreadButton = targetProject
    ? <button type="button" className={projectIconButton} aria-label={t.newThread} title={t.newThread} disabled={create.isPending} onClick={() => newThread(targetProject)}><SquarePenIcon /></button>
    : <DropdownMenu><DropdownMenuTrigger className={projectIconButton} aria-label={t.newThread} title={t.newThread} disabled={!sourceProjects.length || create.isPending}><SquarePenIcon /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64"><div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{t.newThreadIn}</div>{sourceProjects.map(item => <DropdownMenuItem key={item.id} onClick={() => newThread(item.id)}><ProjectBadge name={item.name} /><span className="flex-1 truncate">{item.name}</span></DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>;
  const sidebar = <div className="studio-sidebar flex h-full w-full flex-col px-2.5 pb-2.5 md:w-(--sidebar-w)">
    <div className="studio-titlebar flex shrink-0 items-center gap-1">{toggle}<span className="flex min-w-0 items-center gap-2 px-1 text-sm font-semibold"><ArchMark className="h-3 shrink-0" /><span className="truncate">Arch Studio</span></span></div>
    <div className="flex items-center gap-0.5 py-1.5">
      <div className="relative min-w-0 flex-1"><SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input ref={searchInput} autoComplete="off" value={search} onChange={event => setSearch(event.target.value)} aria-label={t.search} placeholder={t.search} className="h-8 border-transparent bg-transparent pl-7 text-ui shadow-none hover:bg-foreground/5 focus-visible:bg-background" /></div>
      {newThreadButton}
    </div>
    <div className="flex items-center gap-0.5 pb-1">
      <DropdownMenu><DropdownMenuTrigger aria-label={t.filterProjects} data-active={filter.kind !== "all" || undefined} className="flex h-7.5 min-w-0 flex-1 items-center gap-2 rounded-[7px] pr-2 pl-1.5 text-sm font-medium hover:bg-foreground/7 max-md:h-11">
        {filter.kind === "project" ? <ProjectBadge name={filterLabel} /> : <span aria-hidden="true" className="grid size-4.5 shrink-0 place-items-center rounded-[5px] bg-foreground text-background"><ArchMark className="h-2" /></span>}
        <span className="min-w-0 flex-1 truncate text-left">{filterLabel}</span><ChevronsUpDownIcon className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger><DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
        <DropdownMenuItem onClick={() => setFilter({kind: "all"})}><span className="flex-1">{t.allProjects}</span>{filter.kind === "all" && <CheckIcon />}</DropdownMenuItem>
        {(data?.clients ?? []).filter(client => data?.projects.some(item => item.clientId === client.id)).map(client => <div key={client.id}>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setFilter({kind: "client", id: client.id})} className="text-xs font-medium text-muted-foreground"><span className="flex-1 truncate">{client.name}</span>{filter.kind === "client" && filter.id === client.id && <CheckIcon />}</DropdownMenuItem>
          {data!.projects.filter(item => item.clientId === client.id).map(item => <DropdownMenuItem key={item.id} onClick={() => setFilter({kind: "project", id: item.id})}><ProjectBadge name={item.name} /><span className="flex-1 truncate">{item.name}</span>{filter.kind === "project" && filter.id === item.id && <CheckIcon />}</DropdownMenuItem>)}
        </div>)}
        <DropdownMenuSeparator /><DropdownMenuItem onClick={openNewClient}><PlusIcon />{t.newClient}</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      <button type="button" className={projectIconButton} aria-label={t.openProjectFolder} title={t.openProjectFolder} disabled={choosingFolder || openFolder.isPending} onClick={() => {setMobileOpen(false); void chooseFolder();}}><FolderOpenIcon /></button>
      <button type="button" className={projectIconButton} aria-label={t.newProject} title={t.newProject} onClick={openNewProject}><FolderPlusIcon /></button>
    </div>
    {!folderOpen && (openFolder.error ? <StudioFailure className="px-2 py-1 text-xs text-destructive" error={openFolder.error} /> : folderError && <p role="alert" className="px-2 py-1 text-xs text-destructive">{t.error}</p>)}
    {create.error && <StudioFailure className="px-2 py-1 text-xs text-destructive" error={create.error} />}
    <nav className="mt-1 min-h-0 flex-1 overflow-y-auto" aria-label={t.threads}>
      <ThreadList threads={visible} selectedId={thread?.id} select={select} act={handle} now={now} t={t} />
      {!!unconnected.length && <>
        <div className="mt-3 mb-1 flex items-center gap-2 px-2.5"><span className="text-xs font-medium text-muted-foreground/50">{t.withoutSource}</span><span className="h-px flex-1 bg-border/60" /></div>
        <ul className="flex flex-col gap-px">{unconnected.map(item => <li key={item.id} className="list-none"><button type="button" aria-current={!thread && project?.id === item.id ? "page" : undefined} onClick={() => {setSelection({projectId: item.id}); setMobileOpen(false);}} className="flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-muted-foreground/75 hover:bg-foreground/5 aria-[current=page]:bg-foreground/9"><ProjectBadge name={item.name} className="opacity-40 grayscale" /><span className="min-w-0 flex-1 truncate">{item.name}</span></button></li>)}</ul>
      </>}
      {threads.isSuccess && !visible.length && !unconnected.length && <p className="px-2.5 py-2 text-xs text-muted-foreground">{all.length ? t.noMatches : t.noProjects}</p>}
    </nav>
    <StudioFooter t={t} locale={locale} changeLocale={changeLocale} restore={() => {setMobileOpen(false); setImportOpen(true);}} />
  </div>;
  const error = studio.isError || threads.isError;
  return <><div className="studio-shell"><ProjectLayout sidebar={sidebar} sidebarOpen={sidebarOpen} isMobile={isMobile} mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen} labels={{skipToContent: t.skipToContent, sidebar: t.sidebar, mobileTitle: t.mobileTitle, mobileDescription: t.mobileDescription}}>
    {error ? <ProjectPage title={t.studio} navigation={navigation}><div className="m-auto grid gap-3"><p role="alert">{t.error}</p><Button onClick={() => {void studio.refetch(); void threads.refetch();}}>{t.retry}</Button></div></ProjectPage>
      : project ? <Project key={`${project.id}:${thread?.id ?? ""}`} project={project} thread={thread} threads={all.filter(item => item.projectId === project.id)} openThread={select} openVariant={branch => {const existing = all.filter(item => item.projectId === project.id && item.branch === branch).sort((a, b) => recent(b).localeCompare(recent(a)))[0]; if (existing) select(existing); else create.mutate({projectId: project.id, branch});}} t={t} navigation={navigation} section={section} setSection={setSection} newThread={input => create.mutate({projectId: project.id, ...input})} />
      : <ProjectPage title={t.studio} navigation={navigation}><div className="m-auto grid max-w-sm gap-4 p-6 text-center text-ui"><p>{studio.isPending || threads.isPending ? t.loading : all.length ? t.selectThread : t.noProjects}</p><Button disabled={studio.isPending} onClick={openNewProject}>{t.newProject}</Button><Button variant="outline" onClick={() => setImportOpen(true)}>{t.restore}</Button></div></ProjectPage>}
  </ProjectLayout></div>
    <NewProject open={newProjectOpen} setOpen={setNewProjectOpen} clients={data?.clients ?? []} defaultClientId={filter.kind === "client" ? filter.id : project?.clientId} created={value => {void queryClient.invalidateQueries({queryKey: ["studio-threads"]}); setSelection({projectId: value.projectId});}} t={t} />
    <Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>{t.restore}</DialogTitle></DialogHeader><Handoff t={t} /></DialogContent></Dialog>
    <Dialog open={folderOpen} onOpenChange={open => {setFolderOpen(open); if (!open) openFolder.reset();}}><DialogContent><DialogHeader><DialogTitle>{t.openProjectFolder}</DialogTitle><DialogDescription>{t.inspectSource}</DialogDescription></DialogHeader><form autoComplete="off" className="grid gap-4" onSubmit={event => {event.preventDefault(); if (!openFolder.isPending) openFolder.mutate(directory);}}><Field><FieldLabel htmlFor="studio-open-folder">{t.folder}</FieldLabel><Input id="studio-open-folder" value={directory} onChange={event => setDirectory(event.target.value)} required maxLength={4096} disabled={openFolder.isPending} autoComplete="off" /></Field>{openFolder.error && <StudioFailure className="text-destructive" error={openFolder.error} />}<Button type="submit" disabled={openFolder.isPending}>{openFolder.isPending ? t.loading : t.register}</Button></form></DialogContent></Dialog>
    <Dialog open={creatingClient} onOpenChange={setCreatingClient}><DialogContent><DialogHeader><DialogTitle>{t.newClient}</DialogTitle></DialogHeader><form autoComplete="off" onSubmit={event => {event.preventDefault(); void clientForm.handleSubmit();}} className="grid gap-4 text-ui">
      <clientForm.Field name="name">{field => <Field className="gap-2"><FieldLabel htmlFor="studio-client-name" className="text-ui font-normal">{t.clientName}</FieldLabel><Input id="studio-client-name" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required maxLength={160} disabled={createClientMutation.isPending} /></Field>}</clientForm.Field>
      {createClientMutation.error && <StudioFailure className="text-destructive" error={createClientMutation.error} />}<Button type="submit" disabled={createClientMutation.isPending}>{createClientMutation.isPending ? t.loading : t.newClient}</Button></form></DialogContent></Dialog>
  </>;
}
function StudioFooter({t, locale, changeLocale, restore}: {t: Copy; locale: Locale; changeLocale: (locale: Locale) => void; restore: () => void}) {
  const {theme, setTheme} = useTheme();
  return <div className="flex items-center gap-1 pt-2">
    <DropdownMenu><DropdownMenuTrigger aria-label={t.settings} title={t.settings} className={projectIconButton}><SettingsIcon /></DropdownMenuTrigger><DropdownMenuContent side="top" align="start" className="w-56">
      <DropdownMenuSub><DropdownMenuSubTrigger><LanguagesIcon /><span className="flex-1">{t.language}</span><span className="text-xs text-muted-foreground">{languageNames[locale]}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className="w-44"><DropdownMenuRadioGroup value={locale} onValueChange={value => changeLocale(value as Locale)}>{(Object.keys(languageNames) as Locale[]).map(value => <DropdownMenuRadioItem closeOnClick key={value} value={value} className="studio-choice" lang={value}>{languageNames[value]}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
      <DropdownMenuSub><DropdownMenuSubTrigger><PaletteIcon /><span className="flex-1">{t.appearance}</span><span className="text-xs text-muted-foreground">{t[theme]}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className="w-44"><DropdownMenuRadioGroup value={theme} onValueChange={value => setTheme(value as "system" | "light" | "dark")}>{(["system", "light", "dark"] as const).map(value => <DropdownMenuRadioItem closeOnClick key={value} value={value} className="studio-choice">{t[value]}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
      <DropdownMenuSeparator /><DropdownMenuItem onClick={restore}>{t.restore}</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <div className="flex-1" /><DesktopUpdates t={t} />
  </div>;
}
const primaryViews = ["rounds", "preview", "intake", "work", "files"] as const;
const toolSections = ["compare", "outputs", "notes", "source"] as const;
/** Primary project navigation. The header copy shows on wide screens, the panel copy on narrow ones. */
function ProjectViews({view, setSection, hasModel, counts, t, className}: {view: Section; setSection: (section: Section) => void; hasModel: boolean; counts: {work: number; files: number}; t: Copy; className?: string}) {
  const labels = {rounds: t.tabRounds, preview: t.tabModel, intake: t.tabOverview, work: t.intakePieces, files: t.files};
  return <nav aria-label={t.projectViews} className={cn("flex items-center gap-0.5", className)}>{primaryViews.map(value => {
    const count = value === "work" ? counts.work : value === "files" ? counts.files : 0;
    return <button type="button" key={value} data-studio-view={value} aria-current={view === value ? "page" : undefined} disabled={value === "preview" && !hasModel} title={value === "preview" && !hasModel ? t.noModel : undefined} onClick={() => setSection(value)} className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-ui font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 aria-[current=page]:bg-foreground/11 aria-[current=page]:text-foreground max-lg:h-9 max-lg:flex-1 max-lg:px-1.5">{labels[value]}{!!count && <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">{count}</span>}</button>;
  })}</nav>;
}
function ScrollPage({children}: {children: ReactNode}) {
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto grid w-full max-w-3xl content-start gap-8 px-6 py-8 text-ui max-md:px-4 max-md:py-6">{children}</div></div>;
}
function Project({project, thread, threads, openThread, openVariant, t, navigation, section, setSection, newThread}: {project: StudioProjectSummary; thread?: StudioThread; threads: StudioThread[]; openThread: (thread: StudioThread) => void; openVariant: (branch: string) => void; t: Copy; navigation: ReactNode; section: Section; setSection: (section: Section) => void; newThread: (input: {branch?: string; fromCheckpoint?: string}) => void}) {
  const queryClient = useQueryClient();
  const {locale} = useStudioLocale();
  const details = useQuery({queryKey: ["studio-project", project.id], queryFn: () => projectDetails({data: {projectId: project.id}}), refetchInterval: 5000});
  const [versionId, setVersionId] = useState<string>();
  const [grantFor, setGrantFor] = useState<(() => void) | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [compared, setCompared] = useState<{base: string; target: string}>();
  const [fileKey, setFileKey] = useState<string>();
  const branches = details.data?.branches ?? [];
  // Every tab shows the branch folder the open thread works in.
  const branch = branches.find(item => item.name === thread?.branch) ?? branches.find(item => item.primary);
  const allVersions = details.data?.versions ?? [];
  // A branch shows its own history. Projects from older stores have one primary branch.
  const versions = branch ? branchVersions(allVersions, branch.headId) : allVersions;
  const latestVersion = versions.find(item => item.hasArtifact) ?? versions[0];
  const version = allVersions.find(item => item.id === versionId) ?? latestVersion;
  const source = details.data?.source;
  const intake = details.data?.intake ?? null;
  const intakeError = details.data?.intakeError ?? null;
  const assumptions = source?.manifest.assumptions ?? [];
  const build = useMutation({mutationFn: () => buildVersion({data: {sourceId: source!.manifest.id, projectId: project.id, branch: branch!.name, authorizeSourceExecution: true}}), onSuccess: async () => {setVersionId(undefined); setSection("preview"); await queryClient.invalidateQueries();}});
  // Hand edits belong to the branch folder; the viewer edits its latest version only.
  const edits = useQuery({queryKey: ["studio-edits", project.id, branch?.name], queryFn: () => projectEdits({data: {projectId: project.id, branch: branch!.name}}), enabled: !!branch && !!source});
  // The shared library comes from `bun run fetch-assets`. Without it, editing offers only the project's own pieces.
  const catalog = useQuery({queryKey: ["viewer-catalog"], queryFn: () => fetch(`${ASSET_BASE}index.json`, {method: "HEAD"}).then(response => response.ok, () => false), staleTime: Infinity});
  const [drafted, setDrafted] = useState<string>();
  const storeHandEdits = async (next: PlanEdits) => {
    try {
      await saveEdits({data: {projectId: project.id, branch: branch!.name, edits: next}});
    } catch (error) {
      throw new Error(studioFailure(error instanceof Error ? error : new Error(String(error)), locale).message);
    }
    setVersionId(undefined);
    await queryClient.invalidateQueries();
  };
  const saveHandEdits = async (next: PlanEdits) => {
    const granted = await buildGrant({data: {projectId: project.id, branch: branch!.name}}).then(value => value.granted, () => false);
    if (granted) return storeHandEdits(next);
    // Saving builds a version, so it waits for the build grant and then goes ahead by itself.
    ensureGrant(() => void storeHandEdits(next));
    throw new Error(t.grantBeforeSaving);
  };
  const editing: ViewerEditing | undefined = branch && source && edits.data && version?.id === latestVersion?.id ? {saved: edits.data, catalogBase: catalog.data ? ASSET_BASE : undefined, save: saveHandEdits} : undefined;
  const adopt = edits.data && hasEdits(edits.data) && thread ? () => {setDrafted(t.adoptHandEditsRequest); setSection("rounds");} : undefined;
  const grant = useMutation({mutationFn: () => grantBuilds({data: {projectId: project.id, branch: branch!.name}}), onSuccess: () => {const then = grantFor; setGrantFor(null); then?.();}});
  const revoke = useMutation({mutationFn: () => revokeBuilds({data: {projectId: project.id}})});
  const primary = useMutation({mutationFn: () => makePrimary({data: {projectId: project.id, name: branch!.name}}), onSuccess: () => queryClient.invalidateQueries()});
  // Execution confirmation is granted once per project and dependency set, then reused by rounds and builds.
  const ensureGrant = (then: () => void) => {
    if (!branch) return;
    grant.reset();
    void buildGrant({data: {projectId: project.id, branch: branch.name}}).then(value => value.granted ? then() : setGrantFor(() => then), () => setGrantFor(() => then));
  };
  const showVersion = (id: string) => {setVersionId(id); setSection("preview");};
  const reveal = (file?: string) => {if (branch) void revealInFolder({data: {projectId: project.id, branch: branch.name, ...(file ? {path: file} : {})}});};
  const compare = (base: string, target: string) => {setCompared({base, target}); setSection("compare");};
  const ordered = [...allVersions].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const versionLabel = (item: StudioVersion) => `${t.version} ${ordered.findIndex(version => version.id === item.id) + 1} · ${item.checkpointId.slice(0,7)}`;
  // Rounds are the working surface. Without a source folder, show the saved model or the overview.
  const view: Section = section === "preview" && !version?.hasArtifact ? source ? "rounds" : "intake" : section === "rounds" && !source ? version?.hasArtifact ? "preview" : "intake" : section;
  // File labels come from the plan saved with the selected version, never the live plan.
  // Files follow the newest saved version, which may be a source-only version newer than the last build.
  const filesVersion = versionId ? version : versions[0] ?? version;
  const files = projectFiles(filesVersion?.intake ?? null, filesVersion?.references ?? [], t);
  const allFiles = [...files.documents, ...files.others];
  const filesSource = {versionLabel: filesVersion && versionLabel(filesVersion), filesError: filesVersion?.intakeError ?? null};
  const openFile = (key: string) => {setFileKey(key); setSection("files");};
  const views = (className: string) => <ProjectViews view={view} setSection={setSection} hasModel={!!version?.hasArtifact} counts={{work: intake?.pieces.length ?? 0, files: allFiles.length}} t={t} className={className} />;
  const actions = <>
    {views("mr-1 max-lg:hidden")}
    {branch && <ProjectPanel projectId={project.id} projectName={project.name} clientName={details.data?.source?.manifest.client.name} branch={branch} branches={branches} versions={versions} version={version} following={!versionId} selectVersion={setVersionId} versionLabel={versionLabel} threads={threads} threadId={thread?.id} openThread={openThread} openVariant={openVariant} newVariant={checkpointId => newThread({fromCheckpoint: checkpointId})} makePrimary={() => primary.mutate()} reveal={() => reveal()} build={() => ensureGrant(() => build.mutate())} building={build.isPending} buildError={build.error?.message} compare={compare} openHandoff={() => setExportOpen(true)} revoke={() => revoke.mutate()} t={t} />}
    <Button size="sm" variant="outline" className="mx-1 max-md:size-9 max-md:p-0" disabled={!source || !branch || build.isPending} title={build.isError ? t.buildFailed : undefined} onClick={() => ensureGrant(() => build.mutate())}><HammerIcon /><span className="max-md:sr-only">{build.isPending ? t.building : t.buildAction}</span></Button>
    <DropdownMenu><DropdownMenuTrigger className={projectIconButton} aria-label={t.projectSections} title={t.projectSections}><MoreHorizontalIcon /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-60"><DropdownMenuRadioGroup value={section} onValueChange={value => setSection(value as Section)}>{toolSections.map(value => <DropdownMenuRadioItem closeOnClick key={value} value={value} className="studio-choice">{t[value]}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuItem render={<a href="https://arch.enstate-labs.workers.dev/staff" target="_blank" rel="noreferrer" />}><ArrowUpRightIcon />{t.hosted}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
  </>;
  const tool = (content: ReactNode) => <ScrollPage><h2 className="text-lg font-medium">{t[view as typeof toolSections[number]]}</h2>{content}</ScrollPage>;
  const content = details.isError ? <div className="m-auto grid gap-3"><StudioFailure error={details.error} /><Button onClick={() => {void details.refetch();}}>{t.retry}</Button></div>
    : view === "preview" && version ? <VersionPreview key={version.id} version={version} editing={editing} editsPending={edits.isLoading || catalog.isLoading} adopt={adopt} rebuild={source && branch ? () => ensureGrant(() => build.mutate()) : undefined} rebuilding={build.isPending} t={t} />
    : view === "rounds" && branch && thread ? <Rounds projectId={project.id} threadId={thread.id} branch={branch} versions={allVersions} versionLabel={versionLabel} openVersion={showVersion} compare={compare} forkFrom={checkpointId => newThread({fromCheckpoint: checkpointId})} ensureGrant={ensureGrant} initialRequest={edits.data && hasEdits(edits.data) ? drafted : undefined} t={t} />
    : view === "compare" ? <Compare projectId={project.id} versions={versions} base={compared?.base} target={compared?.target} select={(base, target) => setCompared({base, target})} versionLabel={versionLabel} t={t} />
    : details.isPending ? <p role="status" className="m-auto text-ui text-muted-foreground">{t.loading}</p>
    : view === "intake" ? <ScrollPage>
      <h2 className="sr-only">{t.intake}</h2>
      {!source && <header className="grid gap-1"><h3 className="text-lg font-medium">{t.connectSource}</h3><p className="text-muted-foreground">{t.noSources}</p></header>}
      <SourceSetup projectId={project.id} attached={!!source} confirmationOnly={!!source} t={t} />
      {source && <IntakeOverview intake={intake} error={intakeError} assumptions={assumptions} files={allFiles} {...filesSource} openFile={openFile} openFiles={() => setSection("files")} openWork={() => setSection("work")} t={t} />}
    </ScrollPage>
    : view === "work" ? <ScrollPage>{source ? <WorkPlan intake={intake} error={intakeError} assumptions={assumptions} files={allFiles} openFile={openFile} t={t} /> : <p className="text-muted-foreground">{t.noSources}</p>}</ScrollPage>
    : view === "files" ? <ProjectFiles documents={files.documents} others={files.others} {...filesSource} selected={fileKey} select={setFileKey} action={source && branch ? <AddFiles projectId={project.id} branch={branch.name} reveal={() => reveal()} t={t} /> : undefined} reveal={source && branch ? reveal : undefined} t={t} />
    : view === "source" ? tool(<div className="grid min-w-0 gap-6">{source ? <p className="break-all rounded-lg bg-foreground/4 px-3 py-2 font-mono text-xs text-muted-foreground">{source.directory}</p> : <p className="text-muted-foreground">{t.noSources}</p>}<SourceSetup projectId={project.id} attached={!!source} t={t} /></div>)
    : view === "outputs" ? tool(version ? <VersionMedia version={version} t={t} /> : <p className="text-muted-foreground">{t.noVersions}</p>)
    : tool(version ? <Notes key={version.id} projectId={project.id} version={version} notes={details.data?.notes ?? []} t={t} /> : <p className="text-muted-foreground">{t.noVersions}</p>);
  const client = details.data?.source?.manifest.client.name;
  return <><ProjectPage title={thread ? threadTitle(thread.title, t) : project.name} meta={thread ? `${project.name}${client ? ` · ${client}` : ""}` : undefined} navigation={navigation} actions={actions}>{views("shrink-0 border-b px-2 py-1.5 lg:hidden")}{content}</ProjectPage><Dialog open={exportOpen} onOpenChange={setExportOpen}><DialogContent><DialogHeader><DialogTitle>{t.export}</DialogTitle></DialogHeader><Handoff key={version?.id} checkpointId={version?.checkpointId} t={t} /></DialogContent></Dialog><Dialog open={!!grantFor} onOpenChange={value => {if (!value && !grant.isPending) setGrantFor(null);}}><DialogContent><DialogHeader><DialogTitle>{t.grantTitle}</DialogTitle><DialogDescription>{t.executionConfirmation} {t.grantHint}</DialogDescription></DialogHeader><p className="break-all font-mono text-xs">{branch?.directory}</p>{grant.error && <StudioFailure className="text-destructive" error={grant.error} />}<div className="flex justify-end gap-2"><Button variant="ghost" disabled={grant.isPending} onClick={() => setGrantFor(null)}>{t.cancel}</Button><Button disabled={!branch || grant.isPending} onClick={() => grant.mutate()}>{grant.isPending ? t.loading : t.authorizeBuild}</Button></div></DialogContent></Dialog></>;
}
/** `editsPending` holds the viewer back until it is known whether it opens editable; it reads that once. */
function VersionPreview({version, editing, editsPending, adopt, rebuild, rebuilding, t}: {version: StudioVersion; editing?: ViewerEditing; editsPending: boolean; adopt?: () => void; rebuild?: () => void; rebuilding: boolean; t: Copy}) {
  const preview = useQuery({queryKey: ["studio-preview", version.checkpointId], queryFn: () => openVersion({data: {checkpointId: version.checkpointId}}), staleTime: 60_000, retry: false});
  // Built for a viewer this Studio cannot open: the project folder can be built again here.
  const mismatch = preview.isError && preview.error.message === VIEWER_MISMATCH;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const currentViewer = useRef<ViewerInstance | null>(null);
  const onViewer = useCallback((viewer: ViewerInstance | null) => {
    currentViewer.current = viewer;
    setReady(false);
    setError(false);
    if (viewer) void viewer.ready.then(() => {
      if (currentViewer.current === viewer) setReady(true);
    }).catch(() => {
      if (currentViewer.current === viewer) setError(true);
    });
  }, []);
  const status = <div className="flex items-center gap-2"><p role="status" className="pointer-events-none rounded-lg bg-background/90 px-3 py-2 text-xs shadow-sm">{error ? t.error : ready ? t.ready : t.preparing}</p>{adopt && ready && <Button size="xs" variant="outline" className="pointer-events-auto" onClick={adopt}>{t.adoptHandEdits}</Button>}</div>;
  return <div data-studio-preview={error ? "error" : ready ? "ready" : "pending"} className="relative size-full min-h-0">{preview.data && !editsPending ? <ViewerSurface planUrl={preview.data.planUrl} assetBase={preview.data.assetBase} artifactId={preview.data.artifactHash} onViewer={onViewer} top={status} editing={editing && {...editing, dropped: preview.data.handEditsDropped}} /> : <div className="grid size-full place-items-center p-6"><div className="grid gap-3 text-center text-ui">{preview.isError && !mismatch ? <StudioFailure error={preview.error} /> : <p role={mismatch ? "alert" : "status"}>{mismatch ? t.viewerMismatch : t.preparing}</p>}{mismatch && rebuild ? <Button disabled={rebuilding} onClick={rebuild}>{rebuilding ? t.loading : t.rebuildHere}</Button> : preview.isError && <Button onClick={() => {void preview.refetch();}}>{t.retry}</Button>}</div></div>}</div>;
}
function VersionMedia({version, t}: {version: StudioVersion; t: Copy}) {
  if (!version.outputs.length) return <p className="text-muted-foreground">{t.noOutputs}</p>;
  return <div className="space-y-4">{version.outputs.map(output => <figure key={output.id} className="space-y-2">{output.kind === "still" ? <a href={output.url} target="_blank" rel="noreferrer"><img src={output.url} alt={output.label} loading="lazy" className="w-full rounded-lg border object-contain" /></a> : <video src={output.url} aria-label={output.label} controls muted playsInline preload="metadata" className="w-full rounded-lg border" />}<figcaption>{output.label}<a href={output.url} download target="_blank" rel="noreferrer" className="block text-xs underline">{t.openOutput}</a></figcaption></figure>)}</div>;
}
function Notes({projectId, version, notes, t}: {projectId: string; version: StudioVersion; notes: ReviewNote[]; t: Copy}) {
  const format = useStudioFormat();
  const queryClient = useQueryClient();
  const save = useMutation({mutationFn: (body: string) => saveNote({data: {projectId, checkpointId: version.checkpointId, body}}), onSuccess: () => queryClient.invalidateQueries({queryKey: ["studio-project", projectId]})});
  const form = useForm({
    defaultValues: {body: ""},
    onSubmit: async ({value}) => {
      if (save.isPending) return;
      try {await save.mutateAsync(value.body); form.reset();} catch { /* Mutation error is rendered below. */ }
    },
  });
  const selected = notes.filter(note => note.checkpointId === version.checkpointId);
  return <div className="grid gap-5"><p className="text-xs text-muted-foreground">{t.notesHint}</p><form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}><form.Field name="body">{field => <Field className="gap-2"><FieldLabel htmlFor="studio-comment" className="sr-only">{t.comment}</FieldLabel><Textarea id="studio-comment" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required maxLength={8000} disabled={save.isPending} /></Field>}</form.Field><Button type="submit" disabled={save.isPending}>{save.isPending ? t.loading : t.save}</Button></form>{save.error && <StudioFailure className="text-destructive" error={save.error} />}{!selected.length && <p>{t.noComments}</p>}{selected.map(note => <article key={note.id} className="space-y-2 border-b pb-4"><p className="text-xs text-muted-foreground">{note.author} · {format.date(note.createdAt, {dateStyle: "medium", timeStyle: "short"})}</p><p className="whitespace-pre-wrap">{note.body}</p></article>)}</div>;
}
function Handoff({checkpointId, t}: {checkpointId?: string; t: Copy}) {
  const formId = useId();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const action = useMutation({mutationFn: async (request: {kind: "brief"} | {kind: "export"; directory: string} | {kind: "restore"; bundle: string; directory: string; activate: boolean}) => {
    if (request.kind === "brief") return brief({data: {checkpointId: checkpointId!}});
    if (request.kind === "export") return handoff({data: {checkpointId: checkpointId!, directory: request.directory}});
    await restoreSource({data: {bundle: request.bundle, directory: request.directory, activate: request.activate}}); await queryClient.invalidateQueries(); return t.done;
  }, onSuccess: setText});
  const exportForm = useForm({
    defaultValues: {directory: ""},
    onSubmit: ({value}) => {if (checkpointId && !action.isPending) action.mutate({kind: "export", ...value});},
  });
  const restoreForm = useForm({
    defaultValues: {bundle: "", directory: "", activate: false},
    onSubmit: ({value}) => {if (!action.isPending) action.mutate({kind: "restore", ...value});},
  });
  return <div className="grid gap-4"><p className="text-xs text-muted-foreground">{t.hostedHint}</p>{checkpointId && <><Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({kind: "brief"})}>{t.brief}</Button><form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void exportForm.handleSubmit();}}>
    <exportForm.Field name="directory">{field => <Field className="gap-2"><FieldLabel htmlFor={`${formId}-export-directory`} className="sr-only">{t.destination}</FieldLabel><Input id={`${formId}-export-directory`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required placeholder={t.destination} disabled={action.isPending} /></Field>}</exportForm.Field><Button type="submit" disabled={action.isPending}>{t.export}</Button></form></>}
    <form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void restoreForm.handleSubmit();}}>
      <restoreForm.Field name="bundle">{field => <Field className="gap-2"><FieldLabel htmlFor={`${formId}-restore-bundle`} className="sr-only">{t.bundle}</FieldLabel><Input id={`${formId}-restore-bundle`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required placeholder={t.bundle} disabled={action.isPending} /></Field>}</restoreForm.Field>
      <restoreForm.Field name="directory">{field => <Field className="gap-2"><FieldLabel htmlFor={`${formId}-restore-directory`} className="sr-only">{t.destination}</FieldLabel><Input id={`${formId}-restore-directory`} name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required placeholder={t.destination} disabled={action.isPending} /></Field>}</restoreForm.Field>
      <restoreForm.Field name="activate">{field => <Field orientation="horizontal" className="items-start gap-2 text-xs"><input id={`${formId}-restore-activate`} type="checkbox" name={field.name} checked={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.checked)} autoComplete="off" className="mt-0.5" disabled={action.isPending} /><FieldLabel htmlFor={`${formId}-restore-activate`} className="text-xs font-normal">{t.activateRestoredSource}</FieldLabel></Field>}</restoreForm.Field>
      <Button type="submit" variant="outline" disabled={action.isPending}>{t.restore}</Button></form>{action.error && <StudioFailure className="text-destructive" error={action.error} />}<pre className="overflow-auto whitespace-pre-wrap text-xs">{text}</pre></div>;
}
