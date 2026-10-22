import { StudioFailure } from "./studio-failure";
import { Button } from "@arch/ui/components/button";
import { Field, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { initializeSource, registerSource } from "../lib/server";
import type { studioText } from "../lib/messages";

/** Attach or prepare a project folder. With confirmationOnly, only the result of a completed setup remains visible. */
export function SourceSetup({projectId, attached, confirmationOnly = false, t}: {projectId: string; attached: boolean; confirmationOnly?: boolean; t: typeof studioText.en}) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const initialize = creating && !attached;
  const setup = useMutation({
    mutationFn: async ({values, initialize}: {values: {inputsDirectory: string; directory: string}; initialize: boolean}) => initialize
      ? initializeSource({data: {projectId, inputsDirectory: values.inputsDirectory, directory: values.directory}})
      : registerSource({data: {projectId, directory: values.directory}}),
    onSuccess: () => client.invalidateQueries(),
  });
  const form = useForm({
    defaultValues: {inputsDirectory: "", directory: ""},
    onSubmit: ({value}) => {if (!setup.isPending) setup.mutate({values: value, initialize});},
  });
  const confirmation = setup.isSuccess && <p role="status" className="flex items-start gap-2 text-ui text-muted-foreground"><CheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />{setup.variables?.initialize ? t.intakeNext : t.sourceAttached}</p>;
  if (confirmationOnly) return confirmation || null;
  return <div className="grid gap-3">
    {!attached && <fieldset className="flex min-w-0 w-fit gap-0.5 rounded-lg bg-muted p-[3px]"><Button size="sm" variant={creating ? "ghost" : "outline"} aria-pressed={!creating} onClick={() => {setup.reset(); form.resetField("inputsDirectory"); setCreating(false);}}>{t.existingSource}</Button><Button size="sm" variant={creating ? "outline" : "ghost"} aria-pressed={creating} onClick={() => {setup.reset(); setCreating(true);}}>{t.newSource}</Button></fieldset>}
    <form autoComplete="off" className="grid gap-3" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}>
      {initialize && <form.Field name="inputsDirectory">{field => <Field className="gap-1.5"><FieldLabel htmlFor="source-inputs" className="text-xs font-normal text-muted-foreground">{t.inputFolder}</FieldLabel><Input id="source-inputs" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={setup.isPending} /></Field>}</form.Field>}
      <form.Field name="directory">{field => <Field className="gap-1.5"><FieldLabel htmlFor="source-destination" className="text-xs font-normal text-muted-foreground">{initialize ? t.destination : t.folder}</FieldLabel><Input id="source-destination" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={setup.isPending} /></Field>}</form.Field>
      <p className="text-xs text-muted-foreground">{initialize ? t.intakeHint : t.inspectSource}</p>
      <Button size="sm" type="submit" variant={attached ? "outline" : "default"} className="justify-self-start" disabled={setup.isPending}>{setup.isPending ? t.loading : initialize ? t.initialize : t.register}</Button>
    </form>
    {setup.error && <StudioFailure className="text-xs text-destructive" error={setup.error} />}
    {confirmation}
  </div>;
}
