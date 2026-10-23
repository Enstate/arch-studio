import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { discardChanges } from "../lib/server";
import type { studioText } from "../lib/messages";
import { StudioFailure } from "./studio-failure";

type Copy = typeof studioText.en;
/**
 * Shown when a project cannot be loaded. It says what is wrong and offers to put the project
 * folder back at its last saved version, which restores without reading the broken folder.
 */
export function ProjectRecovery({projectId, error, retry, busy, t}: {projectId: string; error: Error; retry: () => void; busy: boolean; t: Copy}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const restore = useMutation({mutationFn: () => discardChanges({data: {projectId}}), onSuccess: async () => {setConfirming(false); await queryClient.invalidateQueries();}});
  return <div className="m-auto grid max-w-md gap-4 p-6 text-ui">
    <StudioFailure error={error} />
    <p className="text-xs text-muted-foreground">{busy ? t.restoreWorkingBusy : t.restoreWorkingHint}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || restore.isPending} onClick={() => {restore.reset(); setConfirming(true);}}>{t.restoreWorking}</Button>
      <Button variant="outline" onClick={retry}>{t.retry}</Button>
    </div>
    {!confirming && restore.error && <StudioFailure className="text-destructive" error={restore.error} />}
    <Dialog open={confirming} onOpenChange={open => {if (!restore.isPending) setConfirming(open);}}><DialogContent>
      <DialogHeader><DialogTitle>{t.restoreWorking}</DialogTitle><DialogDescription>{t.restoreWorkingConfirm}</DialogDescription></DialogHeader>
      {restore.error && <StudioFailure className="text-destructive" error={restore.error} />}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={restore.isPending} onClick={() => setConfirming(false)}>{t.cancel}</Button><Button disabled={busy || restore.isPending} onClick={() => restore.mutate()}>{restore.isPending ? t.loading : t.restoreWorking}</Button></div>
    </DialogContent></Dialog>
  </div>;
}
