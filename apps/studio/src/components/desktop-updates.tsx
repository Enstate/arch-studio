import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@arch/ui/components/popover";
import { projectIconButton } from "@arch/ui/components/project-layout";
import { AlertCircleIcon, DownloadIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { desktopUpdateServerSnapshot, desktopUpdateSnapshot, subscribeDesktopUpdates } from "../lib/desktop-updates";
import type { studioText } from "../lib/messages";

type Copy = typeof studioText.de;

/** Desktop update state and its next action, shared by the sidebar button and Settings. Null outside the desktop app. */
export function useDesktopUpdate(t: Copy) {
  const update = useSyncExternalStore(subscribeDesktopUpdates, desktopUpdateSnapshot, desktopUpdateServerSnapshot);
  const [confirm, setConfirm] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  if (!update) return null;
  const busy = ["checking", "downloading", "installing"].includes(update.status);
  async function action(name: "checkForUpdate" | "downloadUpdate" | "installUpdate") {
    setRequestFailed(false);
    try { await window.archDesktop?.[name](); } catch { setRequestFailed(true); }
  }
  const label = update.status === "disabled" ? t.updateDisabled : update.status === "available" ? t.updateAvailable : update.status === "downloaded" ? t.updateReady : update.status === "downloading" ? t.updateDownloading : update.status === "checking" ? t.updateChecking : update.status === "installing" ? t.updateInstalling : update.status === "up-to-date" ? t.updateCurrent : t.checkUpdates;
  const failed = update.status !== "disabled" && (!!update.message || requestFailed);
  const attention = update.status === "available" || update.status === "downloaded" || failed;
  const actionButton = update.status === "disabled" ? null : <Button size="sm" variant="outline" disabled={busy} onClick={() => update.status === "downloaded" ? setConfirm(true) : void action(update.status === "available" ? "downloadUpdate" : "checkForUpdate")}>
    {update.status === "available" ? <DownloadIcon /> : <RefreshCwIcon />}
    {update.status === "downloaded" ? t.updateInstall : update.status === "available" ? t.updateDownload : t.checkUpdates}
  </Button>;
  const failure = failed ? <p role="alert" className="text-xs text-destructive">{update.operation === "install" ? t.updateInstallFailed : t.updateFailed}</p> : null;
  const confirmation = <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>{t.updateInstall}</DialogTitle><DialogDescription>{t.updateRestartWarning}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirm(false)}>{t.cancel}</Button><Button disabled={update.status !== "downloaded"} onClick={() => { setConfirm(false); void action("installUpdate"); }}>{t.updateInstall}</Button></div></DialogContent></Dialog>;
  return { update, busy, label, failed, attention, actionButton, failure, confirmation };
}

export function DesktopUpdates({ t }: { t: Copy }) {
  const control = useDesktopUpdate(t);
  if (!control) return null;
  const { update, label, failed, attention } = control;
  const Icon = failed ? AlertCircleIcon : update.status === "available" || update.status === "downloading" ? DownloadIcon : update.status === "downloaded" ? RotateCwIcon : RefreshCwIcon;
  return <>
    <Popover><PopoverTrigger className={`${projectIconButton} relative`} aria-label={t.updates} title={label} data-desktop-update={update.status}>
      <Icon className={update.status === "checking" || update.status === "installing" ? "motion-safe:animate-spin" : undefined} />
      {attention && <span aria-hidden="true" className={`absolute top-1 right-1 size-1.5 rounded-full ${failed ? "bg-destructive" : "bg-primary"}`} />}
      {update.status === "downloading" && <span aria-hidden="true" className="absolute right-0 bottom-0 left-0 h-0.5 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-primary" style={{width: `${update.percent ?? 0}%`}} /></span>}
      <span className="sr-only" role="status">{label}</span>
    </PopoverTrigger><PopoverContent side="top" align="end" className="gap-3 p-3">
      <PopoverTitle>Arch Studio {update.currentVersion}</PopoverTitle>
      {update.status === "disabled" ? <p className="text-xs text-muted-foreground">{t.updateDisabled}</p> : <>
        <p role="status" className="text-xs text-muted-foreground">{label}{update.version ? ` · ${update.version}` : ""}</p>
        {update.status === "downloading" && <progress aria-label={t.updateDownloading} max={100} value={update.percent ?? 0} className="h-1 w-full" />}
        {control.failure}
        {control.actionButton}
      </>}
    </PopoverContent></Popover>
    {control.confirmation}
  </>;
}
