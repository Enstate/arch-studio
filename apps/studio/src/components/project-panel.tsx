import { threadTitle } from "../lib/thread-title";
import { StudioFailure } from "./studio-failure";
import { referenceExtensions } from "@arch/project";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@arch/ui/components/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@arch/ui/components/popover";
import { Spinner } from "@arch/ui/components/spinner";
import { cn } from "@arch/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, CircleDashedIcon, DiffIcon, FolderOpenIcon, GitBranchIcon, HammerIcon, LayersIcon, PackageIcon, PlusIcon, StarIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { addReferences, compareVersions } from "../lib/server";
import type { StudioBranch, StudioThread, StudioVersion } from "../lib/model";
import type { studioText } from "../lib/messages";
import { type StudioFormat, useStudioFormat } from "../lib/locale";
import { ProjectBadge } from "./thread-sidebar";

// Laid out like T3 Code's floating thread panel: where you work, the line of work, and
// the other agents on it. Worded for architects rather than developers.

type Copy = typeof studioText.en;
export const variantName = (branch: string, t: Copy) => branch === "main" ? t.mainDesign : branch;

function Row({icon, label, detail, onClick, disabled, menu, className}: {icon: ReactNode; label: ReactNode; detail?: ReactNode; onClick?: () => void; disabled?: boolean; menu?: ReactNode; className?: string}) {
  return <div className={cn("flex min-w-0 items-center", className)}>
    <button type="button" disabled={disabled || !onClick} onClick={onClick} className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-left text-ui outline-none transition-colors enabled:hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring/50 disabled:cursor-default">
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{detail}</span>}
    </button>
    {menu && <><span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />{menu}</>}
  </div>;
}
const chevronButton = "grid h-9 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50";
function Section({children, title}: {children: ReactNode; title?: ReactNode}) {
  return <div className="border-t border-border/70 px-1.5 py-1.5 first:border-t-0">{title}{children}</div>;
}
function ago(value: string, format: StudioFormat) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1 ? format.relative(0, "second") : minutes < 60 ? format.relative(-minutes, "minute") : minutes < 1440 ? format.relative(-Math.floor(minutes / 60), "hour") : format.relative(-Math.floor(minutes / 1440), "day");
}

export function ProjectPanel(props: {
  projectId: string; projectName: string; clientName?: string;
  branch: StudioBranch; branches: StudioBranch[];
  versions: StudioVersion[]; version?: StudioVersion; following: boolean; selectVersion: (id: string | undefined) => void; versionLabel: (version: StudioVersion) => string;
  threads: StudioThread[]; threadId?: string; openThread: (thread: StudioThread) => void;
  openVariant: (branch: string) => void; newVariant: (fromCheckpoint: string) => void; makePrimary: () => void;
  reveal: () => void; build: () => void; building: boolean; buildError?: string; compare: (base: string, target: string) => void; openHandoff: () => void; revoke: () => void; t: Copy;
}) {
  const {t, branch, version} = props;
  const format = useStudioFormat();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const changes = useQuery({queryKey: ["studio-compare", version?.parentId, version?.id], enabled: open && !!version?.parentId, staleTime: Infinity, queryFn: () => compareVersions({data: {projectId: props.projectId, base: version!.parentId!, target: version!.id}})});
  const add = useMutation({
    mutationFn: (files: File[]) => {const data = new FormData(); data.set("projectId", props.projectId); data.set("branch", branch.name); for (const file of files) data.append("files", file); return addReferences({data});},
    onSuccess: () => queryClient.invalidateQueries({queryKey: ["studio-project", props.projectId]}),
  });
  const changedFiles = changes.data?.files.filter(file => !file.path.startsWith("outputs/")).length;
  const planChanges = changes.data?.plan ? Object.values(changes.data.plan).reduce((total, part) => total + part.added.length + part.removed.length + part.modified.length, 0) : 0;
  const siblings = props.threads.filter(thread => thread.branch === branch.name && thread.id !== props.threadId);
  const variants = props.branches.filter(item => !item.archived);
  // Following latest without any built model says so, instead of naming a saved folder state.
  const versionName = version && (version.hasArtifact || !props.following) ? props.versionLabel(version) : t.noModelYet;
  const label = `${variantName(branch.name, t)} · ${versionName}`;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<button type="button" aria-label={`${t.designLine}: ${label}`} data-studio-branch={branch.name} data-studio-version={version?.id} className="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none hover:bg-foreground/7 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50 max-md:h-11" />}>
      <LayersIcon className="size-3.5 shrink-0" /><span className="max-w-56 truncate">{props.following && version?.hasArtifact && <>{t.followLatest} · </>}{label}</span><ChevronDownIcon className="size-3.5 shrink-0" />
    </PopoverTrigger>
    <PopoverContent align="end" className="w-80 gap-0 rounded-2xl p-0">
      <Section>
        <div className="flex h-9 items-center gap-2.5 px-2.5 text-ui"><ProjectBadge name={props.projectName} /><span className="min-w-0 flex-1 truncate font-medium">{props.projectName}</span>{props.clientName && <span className="max-w-32 truncate text-xs text-muted-foreground">{props.clientName}</span>}</div>
        <Row icon={<FolderOpenIcon />} label={t.openFolder} onClick={props.reveal} />
        <Row icon={add.isPending ? <Spinner /> : <PlusIcon />} label={add.isPending ? t.addingFiles : t.addFiles} onClick={() => input.current?.click()} disabled={add.isPending} />
        <input ref={input} type="file" multiple accept={referenceExtensions.join(",")} className="sr-only" tabIndex={-1} onChange={event => {const files = [...event.target.files ?? []]; event.target.value = ""; if (files.length) add.mutate(files);}} />
        {add.error && <StudioFailure className="px-2.5 pb-1 text-xs text-destructive" error={add.error} />}
      </Section>
      <Section>
        <Row icon={<GitBranchIcon />} label={<span className="flex items-center gap-1.5">{variantName(branch.name, t)}{branch.primary && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{t.primaryBranch}</span>}</span>}
          menu={<DropdownMenu><DropdownMenuTrigger className={chevronButton} aria-label={t.variants}><ChevronDownIcon className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="w-64">
            <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{t.variants}</div>
            {variants.map(item => <DropdownMenuItem key={item.name} onClick={() => {setOpen(false); props.openVariant(item.name);}}><span className="flex-1 truncate">{variantName(item.name, t)}</span>{item.primary && <StarIcon className="size-3.5 fill-current text-muted-foreground" />}{item.name === branch.name && <CheckIcon />}</DropdownMenuItem>)}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!version} onClick={() => {setOpen(false); if (version) props.newVariant(version.id);}}><PlusIcon />{t.newVariant}</DropdownMenuItem>
            {!branch.primary && <DropdownMenuItem onClick={props.makePrimary}><StarIcon />{t.makePrimary}</DropdownMenuItem>}
          </DropdownMenuContent></DropdownMenu>} />
        <Row icon={<LayersIcon />} label={version ? versionName : t.noVersions} detail={version && (props.following ? t.latest : ago(version.createdAt, format))}
          menu={<DropdownMenu><DropdownMenuTrigger className={chevronButton} aria-label={t.versions}><ChevronDownIcon className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
            <DropdownMenuRadioGroup value={props.following ? "latest" : version?.id ?? "latest"} onValueChange={value => props.selectVersion(value === "latest" ? undefined : String(value))}>
              <DropdownMenuRadioItem closeOnClick value="latest" className="studio-choice py-2">{t.followLatest}</DropdownMenuRadioItem>
              <DropdownMenuSeparator />
              {props.versions.map(item => <DropdownMenuRadioItem closeOnClick key={item.id} value={item.id} data-studio-version-option={item.id} className="studio-choice py-2"><span className="grid min-w-0 gap-0.5"><span className={item.hasArtifact ? undefined : "text-muted-foreground"}>{props.versionLabel(item)}</span><span className="text-xs font-normal text-muted-foreground">{format.date(item.createdAt, {dateStyle: "medium", timeStyle: "short"})}</span></span></DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent></DropdownMenu>} />
        <Row icon={props.building ? <Spinner /> : props.buildError ? <CircleAlertIcon className="text-destructive" /> : <HammerIcon />} label={props.building ? t.building : t.buildNow} detail={props.buildError ? t.buildFailed : undefined} onClick={props.build} disabled={props.building} />
        <Row icon={<DiffIcon />} label={t.changesSincePrevious} onClick={version?.parentId ? () => {setOpen(false); props.compare(version.parentId!, version.id);} : undefined}
          detail={!version?.parentId ? t.firstVersion : changes.isPending ? <Spinner className="size-3" /> : <span className="flex items-center gap-1.5">{!!changedFiles && <span className="text-emerald-600 dark:text-emerald-400">{changedFiles} {changedFiles === 1 ? t.fileShort : t.filesShort}</span>}{!!planChanges && <span className="text-sky-600 dark:text-sky-400">{planChanges} {t.planShort}</span>}{!changedFiles && !planChanges && t.noChanges}</span>} />
        <Row icon={<PackageIcon />} label={t.shareProject} onClick={() => {setOpen(false); props.openHandoff();}} />
      </Section>
      <Section title={<button type="button" aria-expanded={threadsOpen} onClick={() => setThreadsOpen(value => !value)} className="flex h-8 w-full items-center gap-2 px-2.5 text-left">
        <span className="text-xs font-medium text-muted-foreground">{t.threadsOnVariant} ({siblings.length})</span><span className="h-px flex-1 bg-border/60" /><ChevronDownIcon className={cn("size-3 text-muted-foreground/60 transition-transform", threadsOpen && "rotate-180")} />
      </button>}>
        {threadsOpen && (siblings.length ? siblings.map(thread => <Row key={thread.id} icon={thread.status === "working" ? <CircleDashedIcon className="text-sky-600 dark:text-sky-400" /> : thread.status === "approval" || thread.status === "failed" ? <CircleAlertIcon className="text-amber-600 dark:text-amber-300" /> : <CheckIcon />} label={threadTitle(thread.title, t)} detail={ago(thread.latestRequestAt ?? thread.createdAt, format)} onClick={() => {setOpen(false); props.openThread(thread);}} />)
          : <p className="px-2.5 pb-1.5 text-xs text-muted-foreground">{t.noOtherThreads}</p>)}
      </Section>
      <Section><Row icon={<CircleAlertIcon />} label={<span className="text-xs text-muted-foreground">{t.revokeBuilds}</span>} onClick={() => {setOpen(false); props.revoke();}} /></Section>
    </PopoverContent>
  </Popover>;
}
