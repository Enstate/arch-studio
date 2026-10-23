import { referenceExtensions, type ProjectFacts, type ProjectKind, type ProjectManifest } from "@arch/project";
import { Button } from "@arch/ui/components/button";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "@arch/ui/components/command";
import { Field, FieldDescription, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@arch/ui/components/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@arch/ui/components/select";
import { Spinner } from "@arch/ui/components/spinner";
import { Textarea } from "@arch/ui/components/textarea";
import { ToggleGroup, ToggleGroupItem } from "@arch/ui/components/toggle-group";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, ArrowUpIcon, ChevronsUpDownIcon, FileSearchIcon, MapPinIcon, PlusIcon, UploadIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { studioText } from "../lib/messages";
import type { StudioBranch } from "../lib/model";
import { coordinates, type ProjectLocation } from "../lib/project-location";
import { addReferences, assignClient, catalog, createThread, grantBuilds, startRound, updateProjectFacts } from "../lib/server";
import { agentProvidersQuery, agentRunnable, useDisabledAgents } from "../lib/settings";
import { SectionHeader } from "./intake-overview";
import { LocationSearchBar, useLocationSearch } from "./location-search";
import { projectKinds } from "./new-project";
import { AgentSetupCard } from "./settings";
import { StudioFailure } from "./studio-failure";

type Copy = typeof studioText.en;
type Manifest = Extract<ProjectManifest, {schemaVersion: 2}>;
/** What the overview saves: the project's name, the facts the user confirmed and the brief. */
type Setup = {name: string; facts: ProjectFacts; description: string};

const storeyKinds = new Set<ProjectKind | undefined>(["building", "interior"]);
const intakeRequest = (brief: string) => `Review every reference in this new project and complete intake as AGENTS.md and BUILDERS.md describe: classify the documents, update source/intake.json, and record assumptions and open questions. Do not author geometry unless the references settle scale, structure and openings.${brief ? `\n\nBrief from the user:\n${brief}` : ""}`;
const sameSetup = (a: Setup, b: Setup) => JSON.stringify(a) === JSON.stringify(b);
const commitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {if (event.key === "Enter" && !event.nativeEvent.isComposing) event.currentTarget.blur();};
/** A decimal as typed, with a comma or a point. Blank is no value. */
const typedNumber = (text: string) => text.trim() === "" ? undefined : Number(text.trim().replace(",", "."));

/**
 * The top of a project's overview: every fact is editable where it shows, then the client, the
 * documents, the brief and the first review. Changes save as a version of this branch folder.
 */
export function ProjectSetup({projectId, projectName, clientId, manifest, branch, busy, openConversation, t}: {projectId: string; projectName: string; clientId: string; manifest: Manifest; branch: StudioBranch; busy: boolean; openConversation: (threadId: string) => void; t: Copy}) {
  const queryClient = useQueryClient();
  const saved: Setup = {name: projectName, facts: manifest.facts ?? {}, description: manifest.description};
  // Shows a change at once while it saves; the saved project takes over again once it is back.
  const [draft, setDraft] = useState<Setup | null>(null);
  const current = draft ?? saved;
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const brief = useRef<HTMLTextAreaElement>(null);
  const save = useMutation({mutationFn: (next: Setup) => updateProjectFacts({data: {projectId, branch: branch.name, ...next}})});
  // Saves run one after another, each from the latest answers, so a quick second change never undoes the first.
  const commit = (change: Partial<Setup>) => {
    const next = {...current, ...change};
    if (sameSetup(next, current)) return;
    setDraft(next);
    const run: Promise<unknown> = saving.current.catch(() => undefined)
      .then(() => save.mutateAsync(next))
      .then(() => queryClient.invalidateQueries())
      .finally(() => {if (saving.current === run) setDraft(null);});
    saving.current = run;
    run.catch(() => undefined);
  };
  const facts = current.facts;
  const changeFacts = (change: Partial<ProjectFacts>) => {
    const next: ProjectFacts = {...facts, ...change};
    for (const key of Object.keys(next) as (keyof ProjectFacts)[]) if (next[key] === undefined) delete next[key];
    commit({facts: next});
  };
  const providers = useQuery(agentProvidersQuery);
  const {disabled: disabledAgents} = useDisabledAgents();
  const agent = providers.data?.find(item => !disabledAgents.includes(item.provider) && agentRunnable(item));
  const review = useMutation({
    mutationFn: async () => {
      if (!agent) throw new Error(t.reviewNeedsAgent);
      // A brief typed just before clicking saves first, so the review and the project agree.
      await saving.current.catch(() => undefined);
      // Choosing to review is the explicit confirmation to run this project's code locally.
      await grantBuilds({data: {projectId, branch: branch.name}});
      const {threadId} = await createThread({data: {projectId, branch: branch.name}});
      const round = new FormData();
      round.set("projectId", projectId); round.set("threadId", threadId); round.set("kind", "request"); round.set("settings", "{}");
      round.set("request", intakeRequest((brief.current?.value ?? current.description).trim())); round.set("provider", agent.provider); round.set("model", agent.models[0]!.id);
      await startRound({data: round});
      return threadId;
    },
    onSuccess: async threadId => {await queryClient.invalidateQueries(); openConversation(threadId);},
  });
  const references = manifest.references.length;
  const locked = busy || review.isPending;
  return <>
    <AgentSetupCard t={t} />
    <section aria-label={t.projectFacts} data-studio-facts className="grid gap-4 rounded-xl border border-border/60 bg-card/40 p-4 shadow-xs/5">
      <h3 className="text-sm font-medium">{t.projectFacts}</h3>
      {busy && <p role="status" className="text-xs text-muted-foreground">{t.setupBusy}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field className="gap-2"><FieldLabel htmlFor="project-name" className="text-ui font-normal text-muted-foreground">{t.name}</FieldLabel>
          <Input id="project-name" key={current.name} defaultValue={current.name} maxLength={160} autoComplete="off" disabled={locked} onKeyDown={commitOnEnter} onBlur={event => {const name = event.target.value.trim(); if (name) commit({name}); else event.target.value = current.name;}} />
        </Field>
        <Field className="gap-2"><FieldLabel className="text-ui font-normal text-muted-foreground">{t.kindLabel}</FieldLabel>
          <Select value={facts.kind ?? ""} disabled={locked} onValueChange={value => {const kind = String(value) as ProjectKind; changeFacts({kind, ...(storeyKinds.has(kind) ? {} : {storeyHeight: undefined})});}}>
            <SelectTrigger aria-label={t.kindLabel} className="w-full"><SelectValue>{(value: string) => projectKinds(t).find(option => option.kind === value)?.title ?? t.kindUnset}</SelectValue></SelectTrigger>
            <SelectContent>{projectKinds(t).map(option => <SelectItem key={option.kind} value={option.kind}><option.icon className="text-muted-foreground" />{option.title}</SelectItem>)}</SelectContent>
          </Select>
          {!facts.kind && <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400"><span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500" />{t.kindUnsetHint}</p>}
        </Field>
      </div>
      <LocationField location={facts.location} disabled={locked} change={location => changeFacts({location})} t={t} />
      <div className="grid gap-4 sm:grid-cols-2">
        {storeyKinds.has(facts.kind) && <Field className="gap-2"><FieldLabel htmlFor="project-storey-height" className="text-ui font-normal text-muted-foreground">{t.storeyHeight}</FieldLabel>
          <Unit unit="m"><Input id="project-storey-height" key={String(facts.storeyHeight)} defaultValue={facts.storeyHeight ?? ""} inputMode="decimal" autoComplete="off" disabled={locked} aria-describedby="project-storey-height-hint" className="w-24" onKeyDown={commitOnEnter} onBlur={event => {
            const value = typedNumber(event.target.value);
            if (value === undefined || (value >= 2 && value <= 10)) changeFacts({storeyHeight: value === undefined ? undefined : Math.round(value * 100) / 100});
            else event.target.value = String(facts.storeyHeight ?? "");
          }} /></Unit>
          <FieldDescription id="project-storey-height-hint" className="text-xs">{t.storeyHeightHint}</FieldDescription>
        </Field>}
        <NorthField north={facts.north} disabled={locked} change={north => changeFacts({north})} t={t} />
      </div>
    </section>
    <section aria-label={t.clientLabel} className="grid gap-2">
      <SectionHeader title={t.clientLabel} />
      <ClientPicker projectId={projectId} clientId={clientId} disabled={locked} t={t} />
    </section>
    <section aria-label={t.referencesLabel} className="grid gap-2">
      <SectionHeader title={t.referencesLabel} count={references || undefined} />
      <ReferenceDrop projectId={projectId} branch={branch.name} t={t} />
    </section>
    <section aria-label={t.briefLabel} className="grid gap-2">
      <Field className="gap-2"><FieldLabel htmlFor="project-brief" className="text-ui font-medium">{t.briefLabel}</FieldLabel>
        <Textarea ref={brief} id="project-brief" key={current.description} defaultValue={current.description} maxLength={4000} rows={3} autoComplete="off" placeholder={t.briefPlaceholder} disabled={locked} onBlur={event => commit({description: event.target.value.trim()})} />
        <FieldDescription className="text-xs">{t.briefHint}</FieldDescription>
      </Field>
    </section>
    {save.error && <StudioFailure className="text-destructive" error={save.error} />}
    <section aria-label={t.startIntake} className="grid justify-items-start gap-2">
      <Button disabled={locked || !agent || !references} onClick={() => review.mutate()}>{review.isPending ? <Spinner /> : <FileSearchIcon />}{t.startIntake}</Button>
      <p className="text-xs text-muted-foreground">{!references ? t.reviewNeedsFiles : !agent ? t.reviewNeedsAgent : t.startIntakeHint}</p>
      {review.error && <StudioFailure className="text-destructive" error={review.error} />}
    </section>
  </>;
}

function Unit({unit, children}: {unit: string; children: ReactNode}) {
  return <span className="flex items-center gap-2">{children}<span aria-hidden="true" className="text-muted-foreground">{unit}</span></span>;
}

/** The saved place, and a search that replaces it. */
function LocationField({location, disabled, change, t}: {location?: ProjectLocation; disabled: boolean; change: (location: ProjectLocation | undefined) => void; t: Copy}) {
  const search = useLocationSearch();
  const places = search.places.data ?? [];
  const choose = (place: ProjectLocation) => {change(place); search.setQuery(""); search.places.reset();};
  return <Field className="gap-2"><FieldLabel htmlFor="project-location" className="text-ui font-normal text-muted-foreground">{t.locationLabel}</FieldLabel>
    {location ? <div className="flex items-start gap-2">
      <MapPinIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="grid min-w-0 flex-1 gap-0.5"><span className="line-clamp-2">{location.label}</span>{location.label !== coordinates(location) && <span className="text-xs tabular-nums text-muted-foreground">{coordinates(location)}</span>}</span>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => change(undefined)}><XIcon />{t.locationRemove}</Button>
    </div> : <p className="text-muted-foreground">{t.locationNone}</p>}
    <LocationSearchBar id="project-location" search={search} disabled={disabled} t={t} />
    {!!places.length && <ul className="-mx-2 grid gap-px">{places.map((place, index) => <li key={`${index}:${place.label}`} className="list-none"><button type="button" disabled={disabled} onClick={() => choose(place)} className="grid w-full gap-0.5 rounded-md px-2 py-2 text-left outline-none hover:bg-foreground/5 focus-visible:ring-1 focus-visible:ring-ring/50 disabled:opacity-60">
      <span className="line-clamp-2">{place.label}</span>
      {place.label !== coordinates(place) && <span className="text-xs tabular-nums text-muted-foreground">{coordinates(place)}</span>}
    </button></li>)}</ul>}
    <FieldDescription className="text-xs">{t.locationHint}</FieldDescription>
  </Field>;
}

/** North as one of the four plan edges, or any whole degree clockwise from the top. */
function NorthField({north, disabled, change, t}: {north?: number; disabled: boolean; change: (north: number | undefined) => void; t: Copy}) {
  const quick = [{degrees: 0, icon: ArrowUpIcon, label: t.northUp}, {degrees: 90, icon: ArrowRightIcon, label: t.northRight}, {degrees: 180, icon: ArrowDownIcon, label: t.northDown}, {degrees: 270, icon: ArrowLeftIcon, label: t.northLeft}];
  return <Field className="gap-2"><FieldLabel htmlFor="project-north" className="text-ui font-normal text-muted-foreground">{t.north}</FieldLabel>
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup variant="outline" size="sm" spacing={0} disabled={disabled} value={north === undefined ? [] : [String(north)]} onValueChange={values => {if (values[0] !== undefined) change(Number(values[0]));}}>
        {quick.map(item => <ToggleGroupItem key={item.degrees} value={String(item.degrees)} aria-label={item.label} title={item.label}><item.icon /></ToggleGroupItem>)}
      </ToggleGroup>
      <Unit unit="°"><Input id="project-north" key={String(north)} defaultValue={north ?? ""} inputMode="numeric" autoComplete="off" aria-label={t.northDegrees} title={t.northDegrees} disabled={disabled} className="w-20" onKeyDown={commitOnEnter} onBlur={event => {
        const value = typedNumber(event.target.value);
        if (value === undefined || Number.isFinite(value)) change(value === undefined ? undefined : ((Math.round(value) % 360) + 360) % 360);
        else event.target.value = String(north ?? "");
      }} /></Unit>
    </div>
    <FieldDescription className="text-xs">{t.northHint}</FieldDescription>
  </Field>;
}

/** One field for the client: pick one, or type a new name to add it on the spot. */
function ClientPicker({projectId, clientId, disabled, t}: {projectId: string; clientId: string; disabled: boolean; t: Copy}) {
  const queryClient = useQueryClient();
  const studio = useQuery({queryKey: ["studio-catalog"], queryFn: () => catalog()});
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const assign = useMutation({mutationFn: (client: {id: string} | {name: string}) => assignClient({data: {projectId, client}}), onSuccess: () => queryClient.invalidateQueries()});
  const clients = (studio.data?.clients ?? []).filter(client => client.id !== "local");
  const name = typed.trim();
  const listed = clients.some(client => client.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const choose = (client: {id: string} | {name: string}) => {
    setOpen(false); setTyped("");
    if (!("id" in client) || client.id !== clientId) assign.mutate(client);
  };
  return <div className="grid justify-items-start gap-2">
    <Popover open={open} onOpenChange={value => {setOpen(value); if (!value) setTyped("");}}>
      <PopoverTrigger disabled={disabled || assign.isPending} aria-label={t.clientLabel} render={<Button variant="outline" className="w-full justify-between sm:w-72" />}>
        <span className="truncate">{assign.isPending ? t.loading : clients.find(client => client.id === clientId)?.name ?? t.noClient}</span>
        {assign.isPending ? <Spinner /> : <ChevronsUpDownIcon className="text-muted-foreground" />}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-0 p-0">
        <Command>
          <CommandInput value={typed} onValueChange={setTyped} placeholder={t.clientSearch} aria-label={t.clientSearch} maxLength={160} />
          <CommandList className="max-h-64 overflow-y-auto p-1">
            <CommandGroup>
              <CommandItem value="local" keywords={[t.noClient]} data-checked={clientId === "local"} onSelect={() => choose({id: "local"})}>{t.noClient}</CommandItem>
              {clients.map(client => <CommandItem key={client.id} value={client.id} keywords={[client.name]} data-checked={client.id === clientId} onSelect={() => choose({id: client.id})}>{client.name}</CommandItem>)}
            </CommandGroup>
            {/* Outside the group: cmdk hides a group whose own items match nothing, forced ones included. */}
            {name && !listed && <CommandItem value={`new:${name}`} forceMount onSelect={() => choose({name})}><PlusIcon />{t.clientCreate.replace("{name}", name)}</CommandItem>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
    {assign.error && <StudioFailure className="text-destructive" error={assign.error} />}
  </div>;
}

/** Drop or choose plans, photos and documents. They are added at once as a new version. */
function ReferenceDrop({projectId, branch, t}: {projectId: string; branch: string; t: Copy}) {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const add = useMutation({
    mutationFn: (files: File[]) => {
      const data = new FormData();
      data.set("projectId", projectId); data.set("branch", branch);
      for (const file of files) data.append("files", file);
      return addReferences({data});
    },
    onSuccess: () => queryClient.invalidateQueries({queryKey: ["studio-project", projectId]}),
  });
  const upload = (files: FileList | null) => {const chosen = [...files ?? []]; if (chosen.length && !add.isPending) add.mutate(chosen);};
  return <div className="grid gap-2">
    <fieldset aria-label={t.referencesLabel} data-dragging={dragging || undefined} onDragOver={event => {event.preventDefault(); setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={event => {event.preventDefault(); setDragging(false); upload(event.dataTransfer.files);}} className="grid place-items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center data-dragging:border-ring data-dragging:bg-foreground/4">
      <UploadIcon aria-hidden="true" className="size-5 text-muted-foreground" />
      <p>{t.referencesDrop}</p>
      <p className="text-xs text-muted-foreground">{t.referencesHint}</p>
      <Button type="button" size="sm" variant="outline" disabled={add.isPending} onClick={() => input.current?.click()}>{add.isPending ? <Spinner /> : <PlusIcon />}{add.isPending ? t.addingFiles : t.addReferences}</Button>
      <input ref={input} id="project-references" type="file" multiple accept={referenceExtensions.join(",")} className="sr-only" tabIndex={-1} onChange={event => {upload(event.target.files); event.target.value = "";}} />
    </fieldset>
    {add.error && <StudioFailure className="text-xs text-destructive" error={add.error} />}
  </div>;
}
