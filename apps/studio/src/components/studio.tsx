import type { ReviewNote } from "@arch/project";
import { ArchMark } from "@arch/ui/components/arch-logo";
import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@arch/ui/components/dropdown-menu";
import { Field, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { ProjectLayout, ProjectPage, projectIconButton, projectNavItem } from "@arch/ui/components/project-layout";
import { Textarea } from "@arch/ui/components/textarea";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useIsMobile } from "@arch/ui/hooks/use-mobile";
import { UiLabelsProvider } from "@arch/ui/lib/ui-labels";
import { useTheme } from "@arch/ui/lib/theme";
import { cn } from "@arch/ui/lib/utils";
import { ViewerSurface, ViewerLocaleProvider, type ViewerInstance } from "@arch/viewer-ui";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, ChevronsUpDownIcon, HammerIcon, FolderPlusIcon, GitBranchIcon, LanguagesIcon, MoreHorizontalIcon, PaletteIcon, ListFilterIcon, MenuIcon, PackageIcon, PanelLeftIcon, PlusIcon, SearchIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, useCallback, useId, useRef, useState } from "react";
import { brief, buildVersion, catalog, createClient, createProject, handoff, openProjectFolder, openVersion, projectDetails, restoreSource, saveNote } from "../lib/server";
import type { StudioCatalog, StudioProjectSummary, StudioVersion } from "../lib/model";
import { type Locale, studioText } from "../lib/messages";
import { useStudioLocale } from "../lib/locale";
import { SourceSetup } from "./source-setup";
import { IntakeOverview, WorkPlan } from "./intake-overview";
import { ProjectFiles, projectFiles } from "./project-files";
import { DesktopUpdates } from "./desktop-updates";

type Copy = typeof studioText.en;
type Section = "preview" | "intake" | "work" | "files" | "source" | "versions" | "outputs" | "notes" | "handoff";
export function Studio() {
  const {locale, selectLocale} = useStudioLocale();
  const t = studioText[locale];
  return <ViewerLocaleProvider locale={locale}><UiLabelsProvider value={{ close: t.close, loading: t.loading, toggleSidebar: t.toggleSidebar, navigation: t.mobileTitle, navigationDescription: t.mobileDescription, scrollToEnd: t.scrollToEnd, scrollToStart: t.scrollToStart }}><Clients t={t} locale={locale} changeLocale={selectLocale} /></UiLabelsProvider></ViewerLocaleProvider>;
}
function Clients({t, locale, changeLocale}: {t: Copy; locale: Locale; changeLocale: (locale: Locale) => void}) {
  const queryClient = useQueryClient();
  const clients = useQuery({queryKey: ["studio-catalog"], queryFn: () => catalog(), refetchInterval: 5000});
  const [selected, setSelected] = useState<string>();
  const [selectedProject, setSelectedProject] = useState<string>();
  const [folderOpen, setFolderOpen] = useState(false);
  const [directory, setDirectory] = useState("");
  const [folderError, setFolderError] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [creating, setCreating] = useState(false);
  const client = clients.data?.clients.find(item => item.id === selected) ?? clients.data?.clients[0];
  const openFolder = useMutation({mutationFn: (directory: string) => openProjectFolder({data: {directory}}), onSuccess: async value => {
    await queryClient.invalidateQueries({queryKey: ["studio-catalog"]});
    setSelected(value.clientId); setSelectedProject(value.projectId); setFolderOpen(false);
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
  const create = useMutation({mutationFn: (values: {key: string; name: string}) => createClient({data: {id: values.key, name: values.name}}), onSuccess: async id => { setSelected(id); setSelectedProject(undefined); setCreating(false); await queryClient.invalidateQueries(); }});
  const form = useForm({
    defaultValues: {name: "", key: ""},
    onSubmit: ({value}) => {if (!create.isPending) create.mutate(value);},
  });
  const openNewClient = () => {create.reset(); form.reset(); setCreating(true);};
  const header = <DropdownMenu><DropdownMenuTrigger aria-label={t.clients} className="flex h-7.5 max-w-full min-w-0 items-center gap-2 rounded-[7px] pr-2 pl-1.5 text-sm font-semibold hover:bg-foreground/7 max-md:h-11"><span aria-hidden="true" className="grid size-4.5 shrink-0 place-items-center rounded-[5px] bg-foreground text-background"><ArchMark className="h-2" /></span><span className="min-w-0 truncate">{client?.name ?? t.clients}</span><ChevronsUpDownIcon className="size-3.5 text-muted-foreground" /></DropdownMenuTrigger><DropdownMenuContent className="w-64">{clients.data?.clients.map(item => <DropdownMenuItem key={item.id} onClick={() => {setSelected(item.id); setSelectedProject(undefined);}}><span className="flex-1 truncate">{item.name}</span>{client?.id === item.id && <CheckIcon />}</DropdownMenuItem>)}<DropdownMenuSeparator /><DropdownMenuItem onClick={openNewClient}><PlusIcon />{t.newClient}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>;
  return <><Workspace key={client?.id ?? "empty"} clientId={client?.id} catalog={clients.data} t={t} locale={locale} changeLocale={changeLocale} header={header} selected={selectedProject} selectProject={setSelectedProject} openFolder={() => {void chooseFolder();}} openingFolder={choosingFolder || openFolder.isPending} folderError={folderOpen ? undefined : openFolder.error?.message ?? (folderError ? t.error : undefined)} pending={clients.isPending} error={clients.isError} retry={() => {void clients.refetch();}} createClient={openNewClient} />
    <Dialog open={folderOpen} onOpenChange={open => {setFolderOpen(open); if (!open) openFolder.reset();}}><DialogContent><DialogHeader><DialogTitle>{t.openProjectFolder}</DialogTitle><DialogDescription>{t.inspectSource}</DialogDescription></DialogHeader><form autoComplete="off" className="grid gap-4" onSubmit={event => {event.preventDefault(); if (!openFolder.isPending) openFolder.mutate(directory);}}><Field><FieldLabel htmlFor="studio-open-folder">{t.folder}</FieldLabel><Input id="studio-open-folder" value={directory} onChange={event => setDirectory(event.target.value)} required maxLength={4096} disabled={openFolder.isPending} autoComplete="off" /></Field>{openFolder.error && <p role="alert" className="text-destructive">{openFolder.error.message}</p>}<Button type="submit" disabled={openFolder.isPending}>{openFolder.isPending ? t.loading : t.register}</Button></form></DialogContent></Dialog><Dialog open={creating} onOpenChange={setCreating}><DialogContent><DialogHeader><DialogTitle>{t.newClient}</DialogTitle><DialogDescription>{t.clientKeyHint}</DialogDescription></DialogHeader><form autoComplete="off" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}} className="grid gap-4 text-ui">
    <form.Field name="name">{field => <Field className="gap-2"><FieldLabel htmlFor="studio-client-name" className="text-ui font-normal">{t.clientName}</FieldLabel><Input id="studio-client-name" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required maxLength={160} disabled={create.isPending} /></Field>}</form.Field>
    <form.Field name="key">{field => <Field className="gap-2"><FieldLabel htmlFor="studio-client-key" className="text-ui font-normal">{t.clientKey}</FieldLabel><Input id="studio-client-key" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} required maxLength={80} pattern="[a-z0-9][a-z0-9-]*" disabled={create.isPending} /></Field>}</form.Field>{create.error && <p role="alert" className="text-destructive">{create.error.message}</p>}<Button type="submit" disabled={create.isPending}>{create.isPending ? t.loading : t.newClient}</Button></form></DialogContent></Dialog></>;
}
function StudioFooter({t, locale, changeLocale, hasProject, openSection, restore}: {t: Copy; locale: Locale; changeLocale: (locale: Locale) => void; hasProject: boolean; openSection: (section: Section) => void; restore: () => void}) {
  const {theme, setTheme} = useTheme();
  return <div className="flex items-center gap-1 pt-2">
    <DropdownMenu><DropdownMenuTrigger aria-label={t.settings} title={t.settings} className={projectIconButton}><SettingsIcon /></DropdownMenuTrigger><DropdownMenuContent side="top" align="start" className="w-56">
      <DropdownMenuSub><DropdownMenuSubTrigger><LanguagesIcon /><span className="flex-1">{t.language}</span><span className="text-xs text-muted-foreground">{locale === "de" ? "Deutsch" : "English"}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className="w-44"><DropdownMenuRadioGroup value={locale} onValueChange={value => changeLocale(value as Locale)}>{(["en", "de"] as const).map(value => <DropdownMenuRadioItem closeOnClick key={value} value={value} className="studio-choice" lang={value}>{value === "en" ? "English" : "Deutsch"}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
      <DropdownMenuSub><DropdownMenuSubTrigger><PaletteIcon /><span className="flex-1">{t.appearance}</span><span className="text-xs text-muted-foreground">{t[theme]}</span></DropdownMenuSubTrigger><DropdownMenuSubContent className="w-44"><DropdownMenuRadioGroup value={theme} onValueChange={value => setTheme(value as "system" | "light" | "dark")}>{(["system", "light", "dark"] as const).map(value => <DropdownMenuRadioItem closeOnClick key={value} value={value} className="studio-choice">{t[value]}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
      <DropdownMenuSeparator /><DropdownMenuItem onClick={restore}>{t.restore}</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    <button type="button" className={projectIconButton} aria-label={t.openVersions} title={t.versions} disabled={!hasProject} onClick={() => openSection("versions")}><GitBranchIcon /></button>
    <button type="button" className={projectIconButton} aria-label={t.openHandoff} title={t.handoff} disabled={!hasProject} onClick={() => openSection("handoff")}><PackageIcon /></button>
    <div className="flex-1" /><DesktopUpdates t={t} />
  </div>;
}
function Workspace({clientId, catalog: data, t, locale, changeLocale, header, selected, selectProject, openFolder, openingFolder, folderError, pending, error, retry, createClient: newClient}: {clientId?: string; catalog?: StudioCatalog; t: Copy; locale: Locale; changeLocale: (locale: Locale) => void; header: ReactNode; selected?: string; selectProject: (id: string) => void; openFolder: () => void; openingFolder: boolean; folderError?: string; pending: boolean; error: boolean; retry: () => void; createClient: () => void}) {
  const queryClient = useQueryClient();
  const [selectedSection, setSelectedSection] = useState<{projectId?: string; section: Section}>({section: "preview"});
  const [filter, setFilter] = useState<"all" | "withSource" | "withoutSource">("all");
  const setSelected = (id: string) => {selectProject(id); setSelectedSection({projectId: id, section: "preview"});};
  const [search, setSearch] = useState("");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  const searchInput = useRef<HTMLInputElement>(null);
  const projects = data?.projects.filter(item => item.clientId === clientId) ?? [];
  const project = projects.find(item => item.id === selected) ?? projects[0];
  const section = selectedSection.projectId === project?.id ? selectedSection.section : "preview";
  const setSection = (section: Section) => setSelectedSection({projectId: project?.id, section});
  const create = useMutation({mutationFn: (name: string) => createProject({data: {clientId: clientId!, name}}), onSuccess: async id => {setSelected(id); setNewProjectOpen(false); await queryClient.invalidateQueries();}});
  const projectForm = useForm({
    defaultValues: {name: ""},
    onSubmit: ({value}) => {if (clientId && !create.isPending) create.mutate(value.name);},
  });
  const openNewProject = () => {if (!clientId) return; create.reset(); projectForm.reset(); setMobileOpen(false); setNewProjectOpen(true);};
  const toggleSidebar = () => isMobile ? setMobileOpen(open => !open) : setSidebarOpen(open => !open);
  useHotkey("mod+b", toggleSidebar);
  useHotkey("mod+k", () => {if (isMobile) setMobileOpen(true); else setSidebarOpen(true); requestAnimationFrame(() => searchInput.current?.focus());});
  useHotkey("n", event => {if (!(event.target instanceof Element && event.target.closest("[role=dialog],[role=menu],[role=listbox]"))) openNewProject();});
  const toggle = <button type="button" className={projectIconButton} onClick={toggleSidebar} aria-label={t.hideSidebar}><PanelLeftIcon /></button>;
  const navigation = isMobile || !sidebarOpen ? <button type="button" className={projectIconButton} onClick={toggleSidebar} aria-label={t.openMenu}>{isMobile ? <MenuIcon /> : <PanelLeftIcon />}</button> : undefined;
  const visibleProjects = projects.filter(item => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (filter === "all" || (filter === "withSource" ? !!item.sourceId : !item.sourceId)));
  const sidebar = <div className="studio-sidebar flex h-full w-full flex-col px-2.5 pb-2.5 md:w-(--sidebar-w)">
    <div className="studio-titlebar flex shrink-0 items-center gap-1">{toggle}<span className="flex min-w-0 items-center gap-2 px-1 text-sm font-semibold"><ArchMark className="h-3 shrink-0" /><span className="truncate">Arch Studio</span></span></div>
    <div className="flex items-center gap-0.5 py-1.5">
      <div className="relative min-w-0 flex-1"><SearchIcon className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input ref={searchInput} autoComplete="off" value={search} onChange={event => setSearch(event.target.value)} aria-label={t.search} placeholder={t.search} className="h-8 border-transparent bg-transparent pl-7 text-ui shadow-none hover:bg-foreground/5 focus-visible:bg-background" /></div>
      <DropdownMenu><DropdownMenuTrigger className={projectIconButton} aria-label={t.filterProjects} title={t.filterProjects} data-active={filter !== "all" || undefined}><ListFilterIcon /></DropdownMenuTrigger><DropdownMenuContent align="start" className="w-max min-w-48">{(["all", "withSource", "withoutSource"] as const).map(value => <DropdownMenuItem key={value} className="whitespace-nowrap" onClick={() => setFilter(value)}><span className="flex-1">{t[value]}</span>{filter === value && <CheckIcon />}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
      <button type="button" className={projectIconButton} aria-label={t.openProjectFolder} title={t.openProjectFolder} disabled={openingFolder} onClick={() => {setMobileOpen(false); openFolder();}}><FolderPlusIcon /></button>
      <button type="button" className={projectIconButton} aria-label={t.newProject} title={t.newProject} disabled={!clientId} onClick={openNewProject}><SquarePenIcon /></button>
    </div>
    {folderError && <p role="alert" className="px-2 py-1 text-xs text-destructive">{folderError}</p>}
    <div className="flex min-w-0 py-1">{header}</div>
    <nav className="mt-2 min-h-0 flex-1 overflow-y-auto" aria-label={t.projects}>{visibleProjects.map(item => <button type="button" key={item.id} aria-current={project?.id === item.id ? "page" : undefined} className={`${projectNavItem} studio-project`} onClick={() => {setSelected(item.id); setMobileOpen(false);}}><span className="flex-1 truncate">{item.name}</span>{project?.id === item.id && <CheckIcon className="size-3.5" />}</button>)}{!visibleProjects.length && <p className="px-2 text-xs text-muted-foreground">{projects.length ? t.noMatches : t.noProjects}</p>}</nav>
    <StudioFooter t={t} locale={locale} changeLocale={changeLocale} hasProject={!!project} openSection={value => {setSection(value); setMobileOpen(false);}} restore={() => {setMobileOpen(false); setImportOpen(true);}} />
  </div>;
  return <><div className="studio-shell"><ProjectLayout sidebar={sidebar} sidebarOpen={sidebarOpen} isMobile={isMobile} mobileOpen={mobileOpen} onMobileOpenChange={setMobileOpen} labels={{skipToContent: t.skipToContent, sidebar: t.sidebar, mobileTitle: t.mobileTitle, mobileDescription: t.mobileDescription}}>{error ? <ProjectPage title={t.studio} navigation={navigation}><div className="m-auto grid gap-3"><p role="alert">{t.error}</p><Button onClick={retry}>{t.retry}</Button></div></ProjectPage> : project ? <Project key={project.id} project={project} t={t} navigation={navigation} section={section} setSection={setSection} /> : <ProjectPage title={t.studio} navigation={navigation}><div className="m-auto grid max-w-sm gap-4 p-6 text-center text-ui"><p>{pending ? t.loading : clientId ? t.noProjects : t.noClients}</p><Button disabled={pending} onClick={() => clientId ? openNewProject() : newClient()}>{clientId ? t.newProject : t.newClient}</Button><Button variant="outline" onClick={() => setImportOpen(true)}>{t.restore}</Button></div></ProjectPage>}</ProjectLayout></div><Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}><DialogContent><DialogHeader><DialogTitle>{t.newProject}</DialogTitle></DialogHeader><form autoComplete="off" className="grid gap-4" onSubmit={event => {event.preventDefault(); void projectForm.handleSubmit();}}><projectForm.Field name="name">{field => <Field className="gap-2"><FieldLabel htmlFor="studio-project-name" className="text-ui font-normal">{t.name}</FieldLabel><Input id="studio-project-name" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={create.isPending} /></Field>}</projectForm.Field>{create.error && <p role="alert">{create.error.message}</p>}<Button type="submit" disabled={create.isPending}>{t.create}</Button></form></DialogContent></Dialog><Dialog open={importOpen} onOpenChange={setImportOpen}><DialogContent><DialogHeader><DialogTitle>{t.restore}</DialogTitle></DialogHeader><Handoff t={t} /></DialogContent></Dialog></>;
}
const primaryViews = ["preview", "intake", "work", "files"] as const;
const toolSections = ["outputs", "notes", "versions", "source", "handoff"] as const;
/** Primary project navigation. The header copy shows on wide screens, the panel copy on narrow ones. */
function ProjectViews({view, setSection, hasModel, counts, t, className}: {view: Section; setSection: (section: Section) => void; hasModel: boolean; counts: {work: number; files: number}; t: Copy; className?: string}) {
  const labels = {preview: t.tabModel, intake: t.tabOverview, work: t.intakePieces, files: t.files};
  return <nav aria-label={t.projectViews} className={cn("flex items-center gap-0.5", className)}>{primaryViews.map(value => {
    const count = value === "work" ? counts.work : value === "files" ? counts.files : 0;
    return <button type="button" key={value} data-studio-view={value} aria-current={view === value ? "page" : undefined} disabled={value === "preview" && !hasModel} title={value === "preview" && !hasModel ? t.noModel : undefined} onClick={() => setSection(value)} className="inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2.5 text-ui font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 aria-[current=page]:bg-foreground/11 aria-[current=page]:text-foreground max-lg:h-9 max-lg:flex-1 max-lg:px-1.5">{labels[value]}{!!count && <span aria-hidden="true" className="text-xs tabular-nums text-muted-foreground">{count}</span>}</button>;
  })}</nav>;
}
function ScrollPage({children}: {children: ReactNode}) {
  return <div className="min-h-0 flex-1 overflow-y-auto"><div className="mx-auto grid w-full max-w-3xl content-start gap-8 px-6 py-8 text-ui max-md:px-4 max-md:py-6">{children}</div></div>;
}
function Project({project, t, navigation, section, setSection}: {project: StudioProjectSummary; t: Copy; navigation: ReactNode; section: Section; setSection: (section: Section) => void}) {
  const queryClient = useQueryClient();
  const details = useQuery({queryKey: ["studio-project", project.id], queryFn: () => projectDetails({data: {projectId: project.id}}), refetchInterval: 5000});
  const [versionId, setVersionId] = useState<string>();
  const [confirmBuild, setConfirmBuild] = useState(false);
  const [fileKey, setFileKey] = useState<string>();
  const latestVersion = details.data?.versions.find(item => item.hasArtifact) ?? details.data?.versions[0];
  const version = details.data?.versions.find(item => item.id === versionId) ?? latestVersion;
  const source = details.data?.source;
  const intake = details.data?.intake ?? null;
  const intakeError = details.data?.intakeError ?? null;
  const assumptions = source?.manifest.assumptions ?? [];
  const build = useMutation({mutationFn: () => buildVersion({data: {sourceId: source!.manifest.id, projectId: project.id, authorizeSourceExecution: true}}), onSuccess: async () => {setVersionId(undefined); setSection("preview"); setConfirmBuild(false); await queryClient.invalidateQueries();}});
  const versions = details.data?.versions ?? [];
  const versionLabel = (item: StudioVersion) => `${t.version} ${versions.length - versions.findIndex(version => version.id === item.id)} · ${item.checkpointId.slice(0,7)}`;
  // Without a built model the default project view falls back to the overview.
  const view: Section = section === "preview" && !version?.hasArtifact ? "intake" : section;
  // File labels come from the plan saved with the selected version, never the live plan.
  const files = projectFiles(version?.intake ?? null, version?.references ?? [], t);
  const allFiles = [...files.documents, ...files.others];
  const filesSource = {versionLabel: version && versionLabel(version), filesError: version?.intakeError ?? null};
  const openFile = (key: string) => {setFileKey(key); setSection("files");};
  const views = (className: string) => <ProjectViews view={view} setSection={setSection} hasModel={!!version?.hasArtifact} counts={{work: intake?.pieces.length ?? 0, files: allFiles.length}} t={t} className={className} />;
  const actions = <>
    {views("mr-1 max-lg:hidden")}
    {version && <DropdownMenu><DropdownMenuTrigger aria-label={`${t.versions}: ${versionLabel(version)}`} data-studio-version={version.id} className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 max-md:h-11"><span>{!versionId && <>{t.followLatest} · </>}{versionLabel(version)}</span><ChevronDownIcon className="size-3.5" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64"><DropdownMenuRadioGroup value={versionId ?? "latest"} onValueChange={value => setVersionId(value === "latest" ? undefined : value)}><DropdownMenuRadioItem closeOnClick value="latest" className="studio-choice py-2">{t.followLatest}</DropdownMenuRadioItem><DropdownMenuSeparator />{versions.map(item => <DropdownMenuRadioItem closeOnClick key={item.id} value={item.id} className="studio-choice py-2"><span className="grid min-w-0 gap-0.5"><span>{versionLabel(item)}<span className="ml-2 text-xs font-normal text-muted-foreground">{item.hasArtifact ? t.ready : t.draft}</span></span><span className="font-mono text-xs font-normal text-muted-foreground">{item.checkpointId.slice(0,12)}</span></span></DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>}
    <Button size="sm" className="mx-1 max-md:size-9 max-md:p-0" disabled={!source || build.isPending} onClick={() => setConfirmBuild(true)}><HammerIcon /><span className="max-md:sr-only">{build.isPending ? t.building : t.buildAction}</span></Button>
    <DropdownMenu><DropdownMenuTrigger className={projectIconButton} aria-label={t.projectSections} title={t.projectSections}><MoreHorizontalIcon /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-60"><DropdownMenuRadioGroup value={section} onValueChange={value => setSection(value as Section)}>{toolSections.map(value => <DropdownMenuRadioItem closeOnClick key={value} value={value} className="studio-choice">{t[value]}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup><DropdownMenuSeparator /><DropdownMenuItem render={<a href="https://arch.enstate-labs.workers.dev/staff" target="_blank" rel="noreferrer" />}><ArrowUpRightIcon />{t.hosted}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
  </>;
  const tool = (content: ReactNode) => <ScrollPage><h2 className="text-lg font-medium">{t[view as typeof toolSections[number]]}</h2>{content}</ScrollPage>;
  const content = details.isError ? <div className="m-auto grid gap-3"><p role="alert">{details.error.message}</p><Button onClick={() => {void details.refetch();}}>{t.retry}</Button></div>
    : view === "preview" && version ? <VersionPreview key={version.id} version={version} t={t} />
    : details.isPending ? <p role="status" className="m-auto text-ui text-muted-foreground">{t.loading}</p>
    : view === "intake" ? <ScrollPage>
      <h2 className="sr-only">{t.intake}</h2>
      {!source && <header className="grid gap-1"><h3 className="text-lg font-medium">{t.connectSource}</h3><p className="text-muted-foreground">{t.noSources}</p></header>}
      <SourceSetup projectId={project.id} attached={!!source} confirmationOnly={!!source} t={t} />
      {source && <IntakeOverview intake={intake} error={intakeError} assumptions={assumptions} files={allFiles} {...filesSource} openFile={openFile} openFiles={() => setSection("files")} openWork={() => setSection("work")} t={t} />}
    </ScrollPage>
    : view === "work" ? <ScrollPage>{source ? <WorkPlan intake={intake} error={intakeError} assumptions={assumptions} files={allFiles} openFile={openFile} t={t} /> : <p className="text-muted-foreground">{t.noSources}</p>}</ScrollPage>
    : view === "files" ? <ProjectFiles documents={files.documents} others={files.others} {...filesSource} selected={fileKey} select={setFileKey} t={t} />
    : view === "source" ? tool(<div className="grid min-w-0 gap-6">{source ? <p className="break-all rounded-lg bg-foreground/4 px-3 py-2 font-mono text-xs text-muted-foreground">{source.directory}</p> : <p className="text-muted-foreground">{t.noSources}</p>}<SourceSetup projectId={project.id} attached={!!source} t={t} /></div>)
    : view === "versions" ? tool(<div className="grid gap-1">{!versions.length && <p className="text-muted-foreground">{t.noVersions}</p>}{versions.map(item => <button type="button" key={item.id} onClick={() => {setVersionId(item.id); setSection("preview");}} className="flex items-center gap-3 rounded-md px-3 py-2.5 text-left hover:bg-foreground/5"><span className="flex-1 text-ui font-medium">{versionLabel(item)}</span><span className="text-xs text-muted-foreground">{item.hasArtifact ? t.ready : t.sourceCheckpoint}</span></button>)}</div>)
    : view === "outputs" ? tool(version ? <VersionMedia version={version} t={t} /> : <p className="text-muted-foreground">{t.noVersions}</p>)
    : view === "notes" ? tool(version ? <Notes key={version.id} projectId={project.id} version={version} notes={details.data?.notes ?? []} t={t} /> : <p className="text-muted-foreground">{t.noVersions}</p>)
    : tool(<Handoff key={version?.id} checkpointId={version?.checkpointId} t={t} />);
  return <><ProjectPage title={project.name} navigation={navigation} actions={actions}>{views("shrink-0 border-b px-2 py-1.5 lg:hidden")}{content}</ProjectPage><Dialog open={confirmBuild} onOpenChange={value => {if (!build.isPending) setConfirmBuild(value);}}><DialogContent><DialogHeader><DialogTitle>{t.build}</DialogTitle><DialogDescription>{t.executionConfirmation}</DialogDescription></DialogHeader><p className="break-all font-mono text-xs">{source?.directory}</p>{build.error && <p role="alert" className="text-destructive">{build.error.message}</p>}<div className="flex justify-end gap-2"><Button variant="ghost" disabled={build.isPending} onClick={() => setConfirmBuild(false)}>{t.cancel}</Button><Button disabled={!source || build.isPending} onClick={() => build.mutate()}>{build.isPending ? t.building : t.authorizeBuild}</Button></div></DialogContent></Dialog></>;
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
  const status = <p role="status" className="pointer-events-none rounded-lg bg-background/90 px-3 py-2 text-xs shadow-sm">{error || (ready ? t.ready : t.preparing)}</p>;
  return <div data-studio-preview={error ? "error" : ready ? "ready" : "pending"} className="relative size-full min-h-0">{preview.data ? <ViewerSurface planUrl={preview.data.planUrl} assetBase={preview.data.assetBase} artifactId={preview.data.artifactHash} onViewer={onViewer} top={status} /> : <div className="grid size-full place-items-center p-6"><div className="grid gap-3 text-center text-ui"><p role={preview.isError ? "alert" : "status"}>{preview.isError ? preview.error.message : t.preparing}</p>{preview.isError && <Button onClick={() => {void preview.refetch();}}>{t.retry}</Button>}</div></div>}</div>;
}
function VersionMedia({version, t}: {version: StudioVersion; t: Copy}) {
  if (!version.outputs.length) return <p className="text-muted-foreground">{t.noOutputs}</p>;
  return <div className="space-y-4">{version.outputs.map(output => <figure key={output.id} className="space-y-2">{output.kind === "still" ? <a href={output.url} target="_blank" rel="noreferrer"><img src={output.url} alt={output.label} loading="lazy" className="w-full rounded-lg border object-contain" /></a> : <video src={output.url} aria-label={output.label} controls muted playsInline preload="metadata" className="w-full rounded-lg border" />}<figcaption>{output.label}<a href={output.url} download target="_blank" rel="noreferrer" className="block text-xs underline">{t.openOutput}</a></figcaption></figure>)}</div>;
}
function Notes({projectId, version, notes, t}: {projectId: string; version: StudioVersion; notes: ReviewNote[]; t: Copy}) {
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
  return <div className="grid gap-5"><p className="text-xs text-muted-foreground">{t.notesHint}</p><form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}><form.Field name="body">{field => <Field className="gap-2"><FieldLabel htmlFor="studio-comment" className="sr-only">{t.comment}</FieldLabel><Textarea id="studio-comment" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required maxLength={8000} disabled={save.isPending} /></Field>}</form.Field><Button type="submit" disabled={save.isPending}>{save.isPending ? t.loading : t.save}</Button></form>{save.error && <p role="alert" className="text-destructive">{save.error.message}</p>}{!selected.length && <p>{t.noComments}</p>}{selected.map(note => <article key={note.id} className="space-y-2 border-b pb-4"><p className="text-xs text-muted-foreground">{note.author} · {note.createdAt}</p><p className="whitespace-pre-wrap">{note.body}</p></article>)}</div>;
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
      <Button type="submit" variant="outline" disabled={action.isPending}>{t.restore}</Button></form>{action.error && <p role="alert" className="text-destructive">{action.error.message}</p>}<pre className="overflow-auto whitespace-pre-wrap text-xs">{text}</pre></div>;
}
