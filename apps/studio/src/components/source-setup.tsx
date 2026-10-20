import { Button } from "@arch/ui/components/button";
import { Input } from "@arch/ui/components/input";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { initializeSource, registerSource } from "../lib/server";
import type { studioText } from "../lib/messages";

export function SourceSetup({projectId, attached, t}: {projectId: string; attached: boolean; t: typeof studioText.en}) {
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const initialize = creating && !attached;
  const setup = useMutation({
    mutationFn: async ({fields, initialize}: {fields: FormData; initialize: boolean}) => initialize
      ? initializeSource({data: {projectId, inputsDirectory: String(fields.get("inputsDirectory")), directory: String(fields.get("directory"))}})
      : registerSource({data: {projectId, directory: String(fields.get("directory"))}}),
    onSuccess: () => client.invalidateQueries(),
  });
  return <div className="grid gap-2">
    {!attached && <div className="flex gap-1"><Button size="sm" variant={creating ? "ghost" : "secondary"} onClick={() => {setup.reset(); setCreating(false);}}>{t.existingSource}</Button><Button size="sm" variant={creating ? "secondary" : "ghost"} onClick={() => {setup.reset(); setCreating(true);}}>{t.newSource}</Button></div>}
    <form className="grid gap-2" onSubmit={event => {event.preventDefault(); setup.mutate({fields: new FormData(event.currentTarget), initialize});}}>
      {initialize && <label htmlFor="source-inputs" className="grid gap-2 text-xs text-muted-foreground">{t.inputFolder}<Input id="source-inputs" name="inputsDirectory" required /></label>}
      <label htmlFor="source-destination" className="grid gap-2 text-xs text-muted-foreground">{initialize ? t.destination : t.folder}<Input id="source-destination" name="directory" required /></label>
      <Button size="sm" type="submit" variant="outline" disabled={setup.isPending}>{setup.isPending ? t.loading : initialize ? t.initialize : t.register}</Button>
    </form>
    <p className="text-xs text-muted-foreground">{initialize ? t.intakeHint : t.inspectSource}</p>
    {setup.error && <p role="alert" className="text-xs text-destructive">{setup.error.message}</p>}
    {setup.isSuccess && <p role="status" className="text-xs text-muted-foreground">{setup.variables?.initialize ? t.intakeNext : t.sourceAttached}</p>}
  </div>;
}
