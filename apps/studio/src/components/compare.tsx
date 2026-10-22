import { StudioFailure } from "./studio-failure";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@arch/ui/components/select";
import { Switch } from "@arch/ui/components/switch";
import { ViewerSurface, type ViewerInstance } from "@arch/viewer-ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { compareVersions, openVersion } from "../lib/server";
import { VIEWER_MISMATCH, type StudioVersion } from "../lib/model";
import type { studioText } from "../lib/messages";

type Copy = typeof studioText.en;
const planParts = ["walls", "openings", "rooms", "furniture", "cameras", "materials"] as const;

/** Two saved versions side by side: same views, linked cameras, and what changed between them. */
export function Compare({projectId, versions, base, target, select, versionLabel, t}: {projectId: string; versions: StudioVersion[]; base?: string; target?: string; select: (base: string, target: string) => void; versionLabel: (version: StudioVersion) => string; t: Copy}) {
  const built = versions.filter(version => version.hasArtifact);
  const right = versions.find(version => version.id === target) ?? built[0];
  const left = versions.find(version => version.id === base) ?? versions.find(version => version.id === right?.parentId) ?? built[1];
  const comparison = useQuery({queryKey: ["studio-compare", left?.id, right?.id], enabled: !!left && !!right && left.id !== right.id, queryFn: () => compareVersions({data: {projectId, base: left!.id, target: right!.id}}), staleTime: Infinity});
  const viewers = useRef<{left: ViewerInstance | null; right: ViewerInstance | null; frame: number | null; view: string}>({left: null, right: null, frame: null, view: ""});
  const [linked, setLinked] = useState(true);
  const linkedRef = useRef(linked);
  // The left camera leads while linked. Copying on each frame follows orbit, walk and plan moves alike.
  const follow = useCallback(() => {
    const current = viewers.current;
    if (current.frame !== null) cancelAnimationFrame(current.frame);
    current.frame = null;
    if (!linkedRef.current || !current.left || !current.right) return;
    const step = () => {
      const {left: leader, right: follower} = viewers.current;
      if (!linkedRef.current || !leader || !follower) {viewers.current.frame = null; return;}
      const view = leader.getView();
      const serialized = JSON.stringify(view);
      if (serialized !== viewers.current.view) {viewers.current.view = serialized; follower.setView(view);}
      viewers.current.frame = requestAnimationFrame(step);
    };
    current.frame = requestAnimationFrame(step);
  }, []);
  const attach = (side: "left" | "right") => (viewer: ViewerInstance | null) => {
    viewers.current[side] = viewer;
    viewers.current.view = "";
    if (viewer) void viewer.ready.then(follow, () => undefined); else follow();
  };
  const choose = (side: "left" | "right") => (id: unknown) => side === "left" ? select(String(id), right!.id) : select(left?.id ?? String(id), String(id));
  if (built.length < 1 || !right) return <p className="m-auto text-ui text-muted-foreground">{t.compareEmpty}</p>;
  const picker = (side: "left" | "right", value?: StudioVersion) => <Select value={value?.id ?? ""} onValueChange={choose(side)}><SelectTrigger size="sm" aria-label={side === "left" ? t.compareBase : t.compareTarget} className="max-w-64"><SelectValue>{(id: string) => {const version = versions.find(item => item.id === id); return version ? versionLabel(version) : t.compareBase;}}</SelectValue></SelectTrigger><SelectContent>{versions.map(version => <SelectItem key={version.id} value={version.id} disabled={!version.hasArtifact}>{versionLabel(version)}</SelectItem>)}</SelectContent></Select>;
  const changes = comparison.data;
  // Generated outputs always change with their sources. List what an author changed.
  const authored = changes?.files.filter(file => !file.path.startsWith("outputs/")) ?? [];
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">{picker("left", left)}<span className="text-muted-foreground">→</span>{picker("right", right)}<span className="flex-1" /><span className="flex items-center gap-2 text-muted-foreground"><Switch id="compare-link-cameras" checked={linked} onCheckedChange={value => {linkedRef.current = value; setLinked(value); follow();}} /><label htmlFor="compare-link-cameras">{t.linkCameras}</label></span></div>
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-px bg-border max-md:grid-cols-1">
      {left ? <ComparePane key={`left:${left.id}`} version={left} onViewer={attach("left")} t={t} /> : <p className="m-auto text-xs text-muted-foreground">{t.compareEmpty}</p>}
      <ComparePane key={`right:${right.id}`} version={right} onViewer={attach("right")} t={t} />
    </div>
    <div className="max-h-[38%] shrink-0 overflow-y-auto border-t"><div className="mx-auto grid max-w-5xl gap-4 px-6 py-4 text-ui md:grid-cols-2">
      <section className="grid content-start gap-2"><h3 className="text-xs font-medium text-muted-foreground">{t.planChanges}</h3>
        {comparison.isPending && left && left.id !== right.id ? <p className="text-xs text-muted-foreground">{t.loading}</p> : !changes?.plan ? <p className="text-xs text-muted-foreground">{t.noPlanChanges}</p>
          : <dl className="grid gap-1 text-xs">{planParts.filter(part => {const value = changes.plan![part]; return value.added.length || value.removed.length || value.modified.length;}).map(part => {const value = changes.plan![part]; return <div key={part} className="flex gap-2"><dt className="w-20 shrink-0 text-muted-foreground">{t[`plan_${part}`]}</dt><dd className="min-w-0 break-words">{[value.added.length && `${t.added} ${value.added.join(", ")}`, value.removed.length && `${t.removed} ${value.removed.join(", ")}`, value.modified.length && `${t.modified} ${value.modified.join(", ")}`].filter(Boolean).join(" · ")}</dd></div>;})}</dl>}
        {changes?.plan && planParts.every(part => !changes.plan![part].added.length && !changes.plan![part].removed.length && !changes.plan![part].modified.length) && <p className="text-xs text-muted-foreground">{t.noPlanChanges}</p>}
      </section>
      <section className="grid content-start gap-2"><h3 className="text-xs font-medium text-muted-foreground">{t.changedFiles}{changes && ` · ${authored.length}`}</h3>
        <ul className="grid max-h-48 gap-0.5 overflow-y-auto font-mono text-xs">{authored.map(file => <li key={file.path} className="flex gap-2"><span className="w-4 shrink-0 text-muted-foreground">{file.change === "added" ? "+" : file.change === "removed" ? "−" : "~"}</span><span className="truncate">{file.path}</span></li>)}</ul>
      </section>
      {comparison.error && <StudioFailure className="text-xs text-destructive" error={comparison.error} />}
    </div></div>
  </div>;
}

function ComparePane({version, onViewer, t}: {version: StudioVersion; onViewer: (viewer: ViewerInstance | null) => void; t: Copy}) {
  const preview = useQuery({queryKey: ["studio-preview", version.checkpointId], queryFn: () => openVersion({data: {checkpointId: version.checkpointId}}), staleTime: 60_000, retry: false});
  return <div className="relative min-h-64 bg-background">{preview.data ? <ViewerSurface planUrl={preview.data.planUrl} assetBase={preview.data.assetBase} artifactId={preview.data.artifactHash} onViewer={onViewer} /> : (preview.isError && preview.error.message !== VIEWER_MISMATCH ? <StudioFailure error={preview.error} className="p-6 text-xs text-muted-foreground" /> : <p role={preview.isError ? "alert" : "status"} className="grid size-full place-items-center p-6 text-xs text-muted-foreground">{preview.isError ? t.viewerMismatch : t.preparing}</p>)}</div>;
}
