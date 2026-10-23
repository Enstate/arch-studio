import { Button } from "@arch/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@arch/ui/components/popover";
import { Spinner } from "@arch/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@arch/ui/components/tabs";
import { Textarea } from "@arch/ui/components/textarea";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useMountEffect } from "@arch/ui/hooks/use-mount-effect";
import { cn } from "@arch/ui/lib/utils";
import { addFurniture, furnitureId, paintSurfaces, placeFurniture, removeFurniture, type PlanEdits } from "@arch/viewer/plan/edits";
import { FURNITURE_DEFAULT_SIZE } from "@arch/viewer/plan/furnitureSizes";
import type { Furniture, MaterialDef, Vec2 } from "@arch/viewer/plan/schema";
import { ArrowUpIcon, CheckIcon, CopyIcon, LockIcon, Redo2Icon, RotateCwIcon, SparklesIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { type DragEvent, type RefObject, useRef, useState } from "react";

import { useT } from "./locale";

import { AddPanel, type CatalogPiece, Dot, FINISH, humanize, modelName, PIECE, type PieceTemplate, PlacedList, pieceLabel, type RemotePiece, shownRoom, TrayGroup, TrayItem } from "./viewer-catalog";
import { Hint, pillIcon, pillItem } from "./viewer-controls";
import type { ViewerInstance, ViewerState } from "./viewer-model";

export type { CatalogPiece, RemotePiece };

/** What a host gives the viewer so someone can edit a design by hand. */
export interface ViewerEditing {
  /** Hand edits saved with the version on show. */
  saved: PlanEdits;
  /** The full shared library the trays offer, e.g. "/viewer/library/". Absent when the host has none. */
  catalogBase?: string;
  /** Saves the edits as a new version; resolves once it is built. */
  save(edits: PlanEdits): Promise<void>;
  /** Hand edits the version on show could no longer apply. */
  dropped?: string[];
  /** Names, categories and pictures of the library's models, by library ID. */
  pieces?: CatalogPiece[];
  /** Searches a catalog outside the library. Absent when the host has none. */
  search?(query: string, signal: AbortSignal): Promise<RemotePiece[]>;
  /** Brings a found piece into the library the viewer loads; the trays then read the library again. */
  add?(piece: RemotePiece): Promise<CatalogPiece>;
  /** Sends a request to the project's agent in the open conversation. Absent when the host has no agent. */
  ask?(request: string): Promise<void>;
}

/** Paints offered alongside the project's finishes and the library's textures. */
const PAINTS = {
  white: "#f2efe9", warmWhite: "#ece3d3", sand: "#d8c3a0", sage: "#a9b49a",
  clay: "#b98a6a", terracotta: "#b5603c", navy: "#2f3d55", charcoal: "#3a3a38",
} as const;

const typing = (event: KeyboardEvent) =>
  event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || !!event.target.closest("[role=dialog],[role=menu]"));

const sameEdits = (a: PlanEdits, b: PlanEdits) => JSON.stringify(a) === JSON.stringify(b);

/** How many pieces and surfaces differ between two sets of edits. */
function changeCount(from: PlanEdits, to: PlanEdits) {
  const keys = (e: PlanEdits) => new Map<string, string>([
    ...Object.entries(e.furniture ?? {}).map(([id, v]): [string, string] => [`f:${id}`, JSON.stringify(v)]),
    ...(e.added ?? []).map((f): [string, string] => [`f:${f.id}`, JSON.stringify(f)]),
    ...Object.entries(e.surfaces ?? {}).map(([id, key]): [string, string] => [`s:${id}`, JSON.stringify([key, e.materials?.[key]])]),
  ]);
  const a = keys(from), b = keys(to);
  let n = 0;
  for (const key of new Set([...a.keys(), ...b.keys()])) if (a.get(key) !== b.get(key)) n++;
  return n;
}

/** Drag and drop onto the viewer, which its host hands to the whole viewer surface. */
export interface DropHandlers {
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
  onDragLeave: (e: DragEvent) => void;
}

interface History {
  past: PlanEdits[];
  present: PlanEdits;
  future: PlanEdits[];
}

/**
 * One editing session over an editable viewer: the trays, the selected piece's actions, undo and
 * saving. Edits stay here until saved; the viewer only shows them.
 */
export function EditSession({
  viewer,
  state,
  editing,
  onDone,
  dropTarget,
}: {
  viewer: ViewerInstance;
  state: ViewerState;
  editing: ViewerEditing;
  onDone: () => void;
  /** Gets this session's drop handlers; the canvas sits under the host's surface. */
  dropTarget: RefObject<DropHandlers | null>;
}) {
  const t = useT().viewer.edit;
  const editor = viewer.editor!;
  const [history, setHistory] = useState<History>({ past: [], present: editing.saved, future: [] });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<"placed" | "add">("placed");
  // The editor lays edits over the house after a render; this re-renders once it has.
  const [, setShown] = useState(0);
  const present = history.present;
  const changes = changeCount(editing.saved, present);
  const dirty = !sameEdits(editing.saved, present);

  const show = (next: History) => {
    setHistory(next);
    return editor.setEdits(next.present).then(() => setShown((n) => n + 1));
  };
  const commit = (next: PlanEdits) => show({ past: [...history.past, present], present: next, future: [] });
  const undo = () => {
    const previous = history.past.at(-1);
    if (previous) void show({ past: history.past.slice(0, -1), present: previous, future: [present, ...history.future] });
  };
  const redo = () => {
    const [next, ...rest] = history.future;
    if (next) void show({ past: [...history.past, present], present: next, future: rest });
  };
  const flash = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice((current) => (current === message ? null : current)), 2600);
  };

  // The editor calls back from canvas events registered once; these always see the latest edits.
  const placed = useRef<(id: string, position: [number, number], rotation: number) => void>(() => undefined);
  placed.current = (id, position, rotation) => void commit(placeFurniture(present, id, position, rotation));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useMountEffect(() => {
    editor.start();
    void editor.setEdits(history.present);
    editor.listen({ onSelect: () => undefined, onPlace: (id, position, rotation) => placed.current(id, position, rotation) });
    const warn = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    addEventListener("beforeunload", warn);
    return () => {
      editor.listen(null);
      removeEventListener("beforeunload", warn);
      // Unsaved edits leave with the session; the house goes back to the version on show.
      void editor.setEdits(editing.saved);
      editor.stop();
    };
  });

  const selected = state.selected;
  const piece = selected ? editor.plan().furniture?.find((f) => f.id === selected) : undefined;

  function remove(id = selected) {
    if (!id || editor.locked(id)) return;
    if (id === selected) editor.select(null);
    void commit(removeFurniture(present, id));
  }
  function duplicate() {
    if (!piece || editor.locked(piece.id)) return;
    const copy: Furniture = { ...structuredClone(piece), id: furnitureId(editor.plan(), modelName(piece) ?? piece.type) };
    const width = (piece.size ?? FURNITURE_DEFAULT_SIZE[piece.type])[0];
    const at = editor.fit(copy, [piece.position[0] + width + 0.1, piece.position[1]]);
    if (!at) return flash(t.noRoom);
    void commit(addFurniture(present, { ...copy, position: at })).then(() => editor.select(copy.id));
  }
  function turn() {
    if (selected && !editor.turn(selected, 90)) flash(t.noRoom);
  }

  const on = (run: () => void) => (event: KeyboardEvent) => {
    if (!typing(event)) run();
  };
  useHotkey("mod+z", on(undo));
  useHotkey("mod+shift+z", on(redo));
  useHotkey("mod+d", on(duplicate));
  useHotkey("delete", on(() => remove()));
  useHotkey("backspace", on(() => remove()));
  useHotkey("escape", on(() => editor.select(null)));

  async function save() {
    setSaving(true);
    try {
      await editing.save(present);
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  // Done shrinks the panel back into the Edit button it grew from, then ends the session.
  const [closing, setClosing] = useState(false);
  function done() {
    if (dirty && !confirm(t.leave)) return;
    editor.select(null);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) onDone();
    else setClosing(true);
  }

  // A piece dragged out of the tray is in hand: the piece itself follows the pointer over the view.
  const carrying = useRef<{ template: PieceTemplate; shown: boolean } | null>(null);
  const carry = (template: PieceTemplate | null) => {
    carrying.current = template && { template, shown: false };
    if (!template) editor.preview(null);
  };
  const putDown = () => {
    if (!carrying.current?.shown) return;
    carrying.current.shown = false;
    editor.preview(null);
  };
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(PIECE) && !e.dataTransfer.types.includes(FINISH)) return;
    const hand = carrying.current;
    // Over the trays the piece goes back out of the room.
    if (hand && e.target instanceof Element && e.target.closest("[data-viewer-editing]")) return putDown();
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!hand) return;
    if (!hand.shown) {
      hand.shown = true;
      editor.preview(hand.template);
    }
    editor.previewAt(e.clientX, e.clientY);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) putDown();
  };
  /** Adds a piece at the nearest free spot to a floor point, and selects it. */
  function place(template: PieceTemplate, floor: { position: Vec2; level?: string; room?: string }) {
    const id = furnitureId(editor.plan(), modelName(template) ?? template.type);
    const added: Furniture = { ...template, id, position: floor.position, ...(floor.level && { level: floor.level }), ...(floor.room && { room: floor.room }) };
    const at = editor.fit(added, floor.position);
    if (!at) return flash(t.noRoom);
    void commit(addFurniture(present, { ...added, position: at })).then(() => editor.select(id));
  }
  /** A click on a tray piece puts it in the room on show, or where the middle of the view meets the floor. */
  function placeHere(template: PieceTemplate, card: HTMLElement) {
    const { level, room } = shownRoom(viewer, state);
    if (room) return place(template, { position: room.centroid, ...(level && { level }), room: room.id });
    const canvas = card.closest("[data-viewer]")?.querySelector("canvas")?.getBoundingClientRect();
    const floor = canvas && editor.floorAt(canvas.left + canvas.width / 2, canvas.top + canvas.height / 2);
    if (!floor) return flash(t.noRoom);
    place(template, floor);
  }

  const onDrop = (e: DragEvent) => {
    const pieceData = e.dataTransfer.getData(PIECE), finishData = e.dataTransfer.getData(FINISH);
    if (!pieceData && !finishData) return;
    e.preventDefault();
    if (pieceData) {
      // It lands where the piece in hand stood, or at the nearest free spot when that was in the way.
      const spot = carrying.current?.shown ? editor.previewAt(e.clientX, e.clientY) : editor.floorAt(e.clientX, e.clientY);
      carry(null);
      if (spot) place(JSON.parse(pieceData) as PieceTemplate, spot);
      return;
    }
    const finish = JSON.parse(finishData) as MaterialDef;
    const hit = editor.surfaceAt(e.clientX, e.clientY);
    if (!hit) return flash(t.notPaintable);
    const surfaces = e.shiftKey && hit.finish ? editor.surfacesWith(hit.finish) : [hit.surface];
    void commit(paintSurfaces(present, editor.plan(), surfaces, finish, state.designOption));
  };

  dropTarget.current = { onDragOver, onDrop, onDragLeave };
  useMountEffect(() => () => {
    dropTarget.current = null;
  });

  const blocked = state.blocked;
  const pieces = new Map((editing.pieces ?? []).map((piece) => [piece.id, piece]));
  const blockedText = blocked && (blocked.kind === "furniture" ? t.inTheWay.furniture(blocked.id) : t.inTheWay[blocked.kind]);

  return (
    <>
      <section
        data-viewer-editing=""
        aria-label={t.title}
        data-closing={closing || undefined}
        onAnimationEnd={(e) => {
          if (closing && e.target === e.currentTarget) onDone();
        }}
        className={cn(
          "pointer-events-auto absolute top-3 right-3 bottom-24 flex w-80 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[20px] bg-popover text-popover-foreground shadow-overlay",
          closing ? "pointer-events-none [animation:arch-edit-close_240ms_cubic-bezier(0.4,0,1,1)_forwards]" : "motion-safe:[animation:arch-edit-open_440ms_cubic-bezier(0.32,0.72,0,1)]",
        )}
      >
        <header className="flex items-center gap-1 border-b border-border p-2">
          <h2 className="min-w-0 flex-1 truncate px-1.5 text-xs font-medium">{t.title}</h2>
          <Hint label={t.undo} keys="⌘Z">
            <button type="button" aria-label={t.undo} className={pillIcon} disabled={!history.past.length} onClick={undo}>
              <Undo2Icon aria-hidden="true" />
            </button>
          </Hint>
          <Hint label={t.redo} keys="⇧⌘Z">
            <button type="button" aria-label={t.redo} className={pillIcon} disabled={!history.future.length} onClick={redo}>
              <Redo2Icon aria-hidden="true" />
            </button>
          </Hint>
          <button type="button" className={pillItem} onClick={done}>
            {t.done}
          </button>
        </header>
        <Tabs defaultValue="furniture" className="min-h-0 flex-1 gap-0">
          <TabsList className="mx-2 mt-2 w-[calc(100%-1rem)]">
            <TabsTrigger value="furniture" className="flex-1">{t.furniture}</TabsTrigger>
            <TabsTrigger value="materials" className="flex-1">{t.materials}</TabsTrigger>
          </TabsList>
          <TabsContent value="furniture" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
            <fieldset className="mb-2 flex min-w-0 gap-0.5 rounded-lg border-0 bg-foreground/5 p-0.5">
              <legend className="sr-only">{t.furniture}</legend>
              {(["placed", "add"] as const).map((value) => (
                <button key={value} type="button" aria-pressed={view === value} data-edit-view={value} onClick={() => setView(value)} className="h-7 flex-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground aria-pressed:bg-popover aria-pressed:text-foreground aria-pressed:shadow-popover">
                  {value === "placed" ? t.catalog.placed : t.catalog.add}
                </button>
              ))}
            </fieldset>
            {view === "placed" ? (
              <PlacedList viewer={viewer} state={state} plan={editor.plan()} pieces={pieces} onRemove={remove} onBrowse={() => setView("add")} />
            ) : (
              <AddPanel viewer={viewer} plan={editor.plan()} pieces={pieces} search={editing.search} add={editing.add} onAdd={placeHere} onCarry={carry} />
            )}
          </TabsContent>
          <TabsContent value="materials" className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-2">
            <p className="px-1 pb-2 text-2xs text-muted-foreground">{t.dropHint}</p>
            <MaterialTray viewer={viewer} />
          </TabsContent>
        </Tabs>
        <footer className="flex flex-col gap-2 border-t border-border p-2">
          {!!editing.dropped?.length && (
            <p className="px-1 text-2xs text-warning" title={editing.dropped.join("\n")}>
              {t.dropped(editing.dropped.length)}
            </p>
          )}
          {notice && <p role="status" className="px-1 text-2xs text-muted-foreground">{notice}</p>}
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate px-1 text-2xs text-muted-foreground">{changes ? t.unsaved(changes) : t.noChanges}</span>
            <Button size="sm" disabled={!dirty || saving} onClick={save}>
              {saving ? t.saving : t.save}
            </Button>
          </div>
        </footer>
      </section>
      {(piece || blockedText) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-28 flex justify-center px-3">
          <div data-viewer-selection="" role="toolbar" aria-label={piece?.id} className="pointer-events-auto flex max-w-full items-center gap-1 rounded-2xl bg-popover p-1 text-popover-foreground shadow-popover">
            {blockedText ? (
              <span className="px-2.5 py-1 text-xs font-medium text-destructive">{blockedText}</span>
            ) : piece && (
              <>
                <Hint label={editor.locked(piece.id) ? t.fromPlan : t.moveHint}>
                  <span className="inline-flex max-w-48 items-center gap-1.5 truncate px-2.5 py-1 text-xs font-medium">
                    {editor.locked(piece.id) && <LockIcon aria-label={t.fromPlanShort} className="size-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{pieceLabel(piece, t.types, pieces)}</span>
                  </span>
                </Hint>
                {!editor.locked(piece.id) && (
                  <>
                    <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                    <Hint label={t.turn}>
                      <button type="button" aria-label={t.turn} className={pillIcon} onClick={turn}><RotateCwIcon aria-hidden="true" /></button>
                    </Hint>
                    <Hint label={t.duplicate} keys="⌘D">
                      <button type="button" aria-label={t.duplicate} className={pillIcon} onClick={duplicate}><CopyIcon aria-hidden="true" /></button>
                    </Hint>
                    <Hint label={t.remove} keys="⌫">
                      <button type="button" aria-label={t.remove} className={pillIcon} onClick={() => remove()}><Trash2Icon aria-hidden="true" /></button>
                    </Hint>
                  </>
                )}
                {editing.ask && (
                  <>
                    <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-border" />
                    <AskAgent key={piece.id} label={pieceLabel(piece, t.types, pieces)} context={pieceContext(piece, pieceLabel(piece, t.types, pieces), editor.locked(piece.id))} ask={async (request) => {
                      // The agent works from saved versions, so hand edits are saved before it hears of them.
                      if (dirty) await editing.save(present);
                      await editing.ask!(request);
                    }} />
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const metres = (n: number) => `${Math.round(n * 100) / 100} m`;

/** What an agent needs to find the selected piece in the plan and know what it looks like now. */
function pieceContext(piece: Furniture, label: string, fromPlan: boolean) {
  const facts = [
    `${label}, \`${piece.id}\` (${piece.type}${piece.model ? `, model ${piece.model}` : ""})`,
    piece.room && `in room \`${piece.room}\``,
    piece.level && `on level \`${piece.level}\``,
    `centred at ${metres(piece.position[0])}, ${metres(piece.position[1])}`,
    `turned ${piece.rotation ?? 0}°`,
    piece.size && `${piece.size.map(metres).join(" × ")}`,
  ].filter(Boolean);
  return `Selected piece: ${facts.join(", ")}. ${fromPlan ? "It is part of the plan source." : "It was placed by hand in the editor."}`;
}

/** A bubble over the selected piece where someone writes what the agent should change about it. */
function AskAgent({ label, context, ask }: { label: string; context: string; ask: (request: string) => Promise<void> }) {
  const t = useT().viewer.edit.ask;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  async function send() {
    const request = text.trim();
    if (!request || status === "sending") return;
    setStatus("sending");
    try {
      await ask(`${request}\n\n${context}`);
      setText("");
      setStatus("sent");
      setTimeout(() => {
        setOpen(false);
        setStatus("idle");
      }, 1400);
    } catch {
      setStatus("failed");
    }
  }
  return (
    <Popover open={open} onOpenChange={(next) => {
      setOpen(next);
      if (next && status !== "sending") setStatus("idle");
    }}>
      <PopoverTrigger data-viewer-ask="" className={cn(pillItem, "aria-expanded:bg-foreground/9")}>
        <SparklesIcon aria-hidden="true" />
        {t.button}
      </PopoverTrigger>
      <PopoverContent side="top" sideOffset={12} className="w-80 gap-2 rounded-2xl p-2 shadow-overlay">
        {status === "sent" ? (
          <p role="status" className="flex items-center gap-2 px-1.5 py-2 text-xs font-medium"><CheckIcon aria-hidden="true" className="size-3.5 text-success" />{t.sent}</p>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={t.placeholder(label)}
              aria-label={t.placeholder(label)}
              disabled={status === "sending"}
              className="max-h-40 min-h-14 resize-none border-0 bg-foreground/5 text-xs md:text-xs dark:bg-foreground/5"
            />
            <div className="flex items-center gap-2 px-1">
              <span className={cn("min-w-0 flex-1 truncate text-2xs", status === "failed" ? "text-destructive" : "text-muted-foreground")}>{status === "failed" ? t.failed : t.note}</span>
              <Button type="submit" size="sm" disabled={!text.trim() || status === "sending"}>
                {status === "sending" ? <Spinner /> : <ArrowUpIcon aria-hidden="true" />}
                {t.send}
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MaterialTray({ viewer }: { viewer: ViewerInstance }) {
  const t = useT().viewer.edit;
  const editor = viewer.editor!;
  const finishes = Object.entries(editor.plan().materials ?? {}).filter(([key]) => !key.startsWith("paint-"));
  const { textures } = editor.catalog();
  return (
    <>
      <TrayGroup title={t.groups.paints}>
        {(Object.entries(PAINTS) as [keyof typeof PAINTS, string][]).map(([name, color]) => (
          <TrayItem key={name} kind={FINISH} data={{ color, roughness: 0.9 } satisfies MaterialDef} label={t.paints[name]} swatch={<Dot color={color} />} />
        ))}
      </TrayGroup>
      {!!finishes.length && (
        <TrayGroup title={t.groups.project}>
          {finishes.map(([key, def]) => (
            <TrayItem key={key} kind={FINISH} data={def} label={humanize(key)} swatch={<Dot color={def.color} />} />
          ))}
        </TrayGroup>
      )}
      {!!textures.length && (
        <TrayGroup title={t.groups.library}>
          {textures.map((tex) => (
            <TrayItem
              key={tex.id}
              kind={FINISH}
              data={{ color: "#ffffff", pbr: tex.id } satisfies MaterialDef}
              label={humanize(tex.id)}
              swatch={tex.swatch ? <img alt="" src={tex.swatch} className="size-6 shrink-0 rounded-md object-cover" draggable={false} /> : <Dot />}
            />
          ))}
        </TrayGroup>
      )}
    </>
  );
}
