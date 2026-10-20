import { Button } from "@arch/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@arch/ui/components/dialog";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { desktopUpdateServerSnapshot, desktopUpdateSnapshot, subscribeDesktopUpdates } from "../lib/desktop-updates";
import type { studioText } from "../lib/messages";

export function DesktopUpdates({ t }: { t: typeof studioText.de }) {
  const update = useSyncExternalStore(subscribeDesktopUpdates, desktopUpdateSnapshot, desktopUpdateServerSnapshot);
  const [confirm, setConfirm] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  if (!update) return null;
  const busy = ["checking", "downloading", "installing"].includes(update.status);
  async function action(name: "checkForUpdate" | "downloadUpdate" | "installUpdate") {
    setRequestFailed(false);
    try { await window.archDesktop?.[name](); } catch { setRequestFailed(true); }
  }
  const label = update.status === "available" ? t.updateAvailable : update.status === "downloaded" ? t.updateReady : update.status === "downloading" ? t.updateDownloading : update.status === "checking" ? t.updateChecking : update.status === "installing" ? t.updateInstalling : update.status === "up-to-date" ? t.updateCurrent : t.checkUpdates;
  return <div className="grid gap-2 px-2 pb-2 text-xs" data-desktop-update={update.status}>
    <p className="text-muted-foreground">Arch Studio {update.currentVersion}</p>
    {update.status === "disabled" ? <p className="text-muted-foreground">{t.updateDisabled}</p> : <>
      <p role="status">{label}{update.version ? ` · ${update.version}` : ""}</p>
      {update.status === "downloading" && <progress aria-label={t.updateDownloading} max={100} value={update.percent ?? 0} className="h-1 w-full" />}
      {(update.message || requestFailed) && <p role="alert" className="text-destructive">{update.operation === "install" ? t.updateInstallFailed : t.updateFailed}</p>}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => update.status === "downloaded" ? setConfirm(true) : void action(update.status === "available" ? "downloadUpdate" : "checkForUpdate")}>
        {update.status === "available" ? <DownloadIcon /> : <RefreshCwIcon />}
        {update.status === "downloaded" ? t.updateInstall : update.status === "available" ? t.updateDownload : t.checkUpdates}
      </Button>
    </>}
    <Dialog open={confirm} onOpenChange={setConfirm}><DialogContent><DialogHeader><DialogTitle>{t.updateInstall}</DialogTitle><DialogDescription>{t.updateRestartWarning}</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirm(false)}>{t.cancel}</Button><Button disabled={update.status !== "downloaded"} onClick={() => { setConfirm(false); void action("installUpdate"); }}>{t.updateInstall}</Button></div></DialogContent></Dialog>
  </div>;
}
