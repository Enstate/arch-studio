import { Button } from "@arch/ui/components/button";
import { Field, FieldLabel } from "@arch/ui/components/field";
import { Input } from "@arch/ui/components/input";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { initializeSource, registerSource } from "../lib/server";
import type { studioText } from "../lib/messages";

export function SourceSetup({projectId, attached, t}: {projectId: string; attached: boolean; t: typeof studioText.en}) {
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
  return <div className="grid gap-2">
    {!attached && <div className="flex gap-1"><Button size="sm" variant={creating ? "ghost" : "secondary"} onClick={() => {setup.reset(); form.resetField("inputsDirectory"); setCreating(false);}}>{t.existingSource}</Button><Button size="sm" variant={creating ? "secondary" : "ghost"} onClick={() => {setup.reset(); setCreating(true);}}>{t.newSource}</Button></div>}
    <form autoComplete="off" className="grid gap-2" onSubmit={event => {event.preventDefault(); void form.handleSubmit();}}>
      {initialize && <form.Field name="inputsDirectory">{field => <Field className="gap-2"><FieldLabel htmlFor="source-inputs" className="text-xs font-normal text-muted-foreground">{t.inputFolder}</FieldLabel><Input id="source-inputs" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={setup.isPending} /></Field>}</form.Field>}
      <form.Field name="directory">{field => <Field className="gap-2"><FieldLabel htmlFor="source-destination" className="text-xs font-normal text-muted-foreground">{initialize ? t.destination : t.folder}</FieldLabel><Input id="source-destination" name={field.name} value={field.state.value} onBlur={field.handleBlur} onChange={event => field.handleChange(event.target.value)} autoComplete="off" required disabled={setup.isPending} /></Field>}</form.Field>
      <Button size="sm" type="submit" variant="outline" disabled={setup.isPending}>{setup.isPending ? t.loading : initialize ? t.initialize : t.register}</Button>
    </form>
    <p className="text-xs text-muted-foreground">{initialize ? t.intakeHint : t.inspectSource}</p>
    {setup.error && <p role="alert" className="text-xs text-destructive">{setup.error.message}</p>}
    {setup.isSuccess && <p role="status" className="text-xs text-muted-foreground">{setup.variables?.initialize ? t.intakeNext : t.sourceAttached}</p>}
  </div>;
}
