import type { ProjectFacts, ProjectKind } from "@arch/project";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { Questionnaire, QuestionnaireActions, QuestionnaireChoice, QuestionnaireChoiceDescription, QuestionnaireChoices, QuestionnaireDescription, QuestionnaireError, QuestionnaireInput, QuestionnaireItem, QuestionnaireNext, QuestionnairePrevious, QuestionnaireProgress, QuestionnaireSkip, QuestionnaireSubmit, QuestionnaireTitle } from "@arch/ui/components/questionnaire";
import { type UseMutationResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { HouseIcon, LandmarkIcon, LandPlotIcon, type LucideIcon, ShapesIcon, SofaIcon, TreesIcon } from "lucide-react";
import { useState } from "react";
import type { studioText } from "../lib/messages";
import { coordinates, sameLocation, type ProjectLocation } from "../lib/project-location";
import { createProject } from "../lib/server";
import { LocationSearchBar, useLocationSearch } from "./location-search";
import { StudioFailure } from "./studio-failure";

type Copy = typeof studioText.en;
type Created = {clientId: string; projectId: string};
type Answers = {name: string; facts: ProjectFacts};

/** What a project can be, as people pick it. The kind chooses the guide the agent follows. */
export function projectKinds(t: Copy): {kind: ProjectKind; icon: LucideIcon; title: string; hint: string}[] {
  return [
    {kind: "building", icon: HouseIcon, title: t.kindBuilding, hint: t.kindBuildingHint},
    {kind: "interior", icon: SofaIcon, title: t.kindInterior, hint: t.kindInteriorHint},
    {kind: "public-space", icon: LandmarkIcon, title: t.kindPublicSpace, hint: t.kindPublicSpaceHint},
    {kind: "landscape", icon: TreesIcon, title: t.kindLandscape, hint: t.kindLandscapeHint},
    {kind: "site", icon: LandPlotIcon, title: t.kindSite, hint: t.kindSiteHint},
    {kind: "other", icon: ShapesIcon, title: t.kindOther, hint: t.kindOtherHint},
  ];
}

const steps = ["name", "kind", "location"] as const;
type Step = typeof steps[number];

/**
 * Three questions, then the project opens on its overview. Documents, the brief and the client
 * are added there, so creating a project never asks for more than a name and what it is.
 */
export function NewProject({open, setOpen, defaultClientId, created, t}: {open: boolean; setOpen: (open: boolean) => void; defaultClientId?: string; created: (value: Created) => void; t: Copy}) {
  const queryClient = useQueryClient();
  const create = useMutation({
    mutationFn: (answers: Answers): Promise<Created> => createProject({data: {...answers, ...(defaultClientId ? {clientId: defaultClientId} : {})}}),
    onSuccess: async value => {await queryClient.invalidateQueries(); created(value); setOpen(false);},
  });
  const change = (value: boolean) => {
    if (create.isPending) return;
    if (!value) create.reset();
    setOpen(value);
  };
  // The questions unmount with the closed dialog, so every opening starts fresh.
  return <Dialog open={open} onOpenChange={change}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t.newProject}</DialogTitle><DialogDescription>{t.newProjectHint}</DialogDescription></DialogHeader>
    <Questions create={create} t={t} />
  </DialogContent></Dialog>;
}

function Questions({create, t}: {create: UseMutationResult<Created, Error, Answers>; t: Copy}) {
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>();
  const [picked, setPicked] = useState<ProjectLocation>();
  const search = useLocationSearch();
  const places = search.places.data ?? [];
  // A new search drops an earlier pick it no longer lists.
  const location = places.find(place => sameLocation(place, picked));
  const progress = t.stepProgress.replace("{current}", String(steps.indexOf(step) + 1)).replace("{total}", String(steps.length));
  const submit = (place: ProjectLocation | undefined) => {
    if (create.isPending || !kind || !name.trim()) return;
    create.mutate({name: name.trim(), facts: {kind, ...(place ? {location: place} : {})}});
  };
  return <Questionnaire item={step} onItemChange={value => setStep(value as Step)} onSubmit={event => {event.preventDefault(); submit(location);}} autoComplete="off" className="text-ui">
    <QuestionnaireProgress aria-label={t.newProject} aria-valuetext={progress}>{progress}</QuestionnaireProgress>
    <QuestionnaireItem name="name" required>
      <QuestionnaireTitle>{t.nameQuestion}</QuestionnaireTitle>
      <QuestionnaireDescription>{t.nameQuestionHint}</QuestionnaireDescription>
      <QuestionnaireInput aria-label={t.name} value={name} onChange={event => setName(event.target.value)} maxLength={160} disabled={create.isPending} />
      <QuestionnaireError>{t.nameRequired}</QuestionnaireError>
    </QuestionnaireItem>
    <QuestionnaireItem name="kind" required>
      <QuestionnaireTitle>{t.kindQuestion}</QuestionnaireTitle>
      <QuestionnaireDescription>{t.kindQuestionHint}</QuestionnaireDescription>
      <QuestionnaireChoices className="sm:grid-cols-2">{projectKinds(t).map(option => <QuestionnaireChoice key={option.kind} value={option.kind} checked={kind === option.kind} onChange={() => setKind(option.kind)} disabled={create.isPending} className="min-h-16 py-3">
        <span className="flex items-center gap-2 font-medium"><option.icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{option.title}</span>
        <QuestionnaireChoiceDescription className="text-xs">{option.hint}</QuestionnaireChoiceDescription>
      </QuestionnaireChoice>)}</QuestionnaireChoices>
      <QuestionnaireError>{t.kindRequired}</QuestionnaireError>
    </QuestionnaireItem>
    <QuestionnaireItem name="location">
      <QuestionnaireTitle>{t.locationQuestion}</QuestionnaireTitle>
      <QuestionnaireDescription>{t.locationHint}</QuestionnaireDescription>
      <LocationSearchBar id="new-project-location" search={search} disabled={create.isPending} t={t} />
      {!!places.length && <QuestionnaireChoices>{places.map((place, index) => <QuestionnaireChoice key={`${index}:${place.label}`} value={String(index)} checked={sameLocation(place, picked)} onChange={() => setPicked(place)} disabled={create.isPending}>
        <span className="line-clamp-2">{place.label}</span>
        {place.label !== coordinates(place) && <QuestionnaireChoiceDescription className="text-xs tabular-nums">{coordinates(place)}</QuestionnaireChoiceDescription>}
      </QuestionnaireChoice>)}</QuestionnaireChoices>}
      <QuestionnaireError>{t.locationRequired}</QuestionnaireError>
    </QuestionnaireItem>
    {create.error && <StudioFailure className="text-destructive" error={create.error} />}
    <QuestionnaireActions>
      <QuestionnairePrevious disabled={create.isPending}>{t.back}</QuestionnairePrevious>
      {/* Only the last question can be skipped, and skipping it creates the project without a location. */}
      <QuestionnaireSkip disabled={create.isPending} onClick={event => {event.preventDefault(); submit(undefined);}}>{t.skipForNow}</QuestionnaireSkip>
      <QuestionnaireNext>{t.next}</QuestionnaireNext>
      <QuestionnaireSubmit disabled={create.isPending}>{create.isPending ? t.creatingProject : t.create}</QuestionnaireSubmit>
    </QuestionnaireActions>
  </Questionnaire>;
}
