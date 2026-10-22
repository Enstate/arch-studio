import { Button } from "@arch/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@arch/ui/components/tabs";
import { useHotkey } from "@arch/ui/hooks/use-hotkey";
import { useMountEffect } from "@arch/ui/hooks/use-mount-effect";
import { cn } from "@arch/ui/lib/utils";
import { addFurniture, furnitureId, paintSurfaces, placeFurniture, removeFurniture, type PlanEdits } from "@arch/viewer/plan/edits";
import { FURNITURE_DEFAULT_SIZE } from "@arch/viewer/plan/furnitureSizes";
import type { Furniture, FurnitureType, MaterialDef } from "@arch/viewer/plan/schema";
import { CopyIcon, LockIcon, PencilIcon, Redo2Icon, RotateCwIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { type DragEvent, type ReactNode, type RefObject, useRef, useState } from "react";

import { useT } from "./locale";

import { Hint, pillIcon, pillItem } from "./viewer-controls";
import type { ViewerInstance, ViewerState } from "./viewer-model";

/** What a host gives the viewer so someone can edit a design by hand. */
export interface ViewerEditing {
  /** Hand edits saved with the version on show. */
  saved: PlanEdits;
  /** The full shared library the trays offer, e.g. "/viewer/library/". */
  catalogBase: string;
  /** Saves the edits as a new version; resolves once it is built. */
  save(edits: PlanEdits): Promise<void>;
  /** Hand edits the version on show could no longer apply. */
  dropped?: string[];
}

/** A piece in a tray, without an id or a place yet. */
type PieceTemplate = Omit<Furniture, "id" | "position" | "level" | "room">;
const PIECE = "application/x-arch-piece";
const FINISH = "application/x-arch-finish";

/** Paints offered alongside the project's finishes and the library's textures. */
const PAINTS = {
  white: "#f2efe9", warmWhite: "#ece3d3", sand: "#d8c3a0", sage: "#a9b49a",
  clay: "#b98a6a", terracotta: "#b5603c", navy: "#2f3d55", charcoal: "#3a3a38",
} as const;

/** Pieces worth placing by hand; stairs come from the agent with the storeys they join. */
const PLACEABLE = (Object.keys(FURNITURE_DEFAULT_SIZE) as FurnitureType[]).filter((type) => type !== "stairs");

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

/** The pill that starts editing, beside the storey and style pickers. */
export function EditButton({ onStart }: { onStart: () => void }) {
  const t = useT().viewer.edit;
  return (
    <button
      type="button"
      data-viewer-edit=""
      className={cn(pillItem, "pointer-events-auto bg-popover text-popover-foreground shadow-popover")}
      onClick={onStart}
    >
      <PencilIcon aria-hidden="true" />
      {t.start}
    </button>
  );
}

/** Drag and drop onto the viewer, which its host hands to the whole viewer surface. */
export interface DropHandlers {
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
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
  const present = history.present;
  const changes = changeCount(editing.saved, present);
  const dirty = !sameEdits(editing.saved, present);

  const show = (next: History) => {
    setHistory(next);
    return editor.setEdits(next.present);
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

  function remove() {
    if (!selected || editor.locked(selected)) return;
    editor.select(null);
    void commit(removeFurniture(present, selected));
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
  useHotkey("delete", on(remove));
  useHotkey("backspace", on(remove));
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
  function done() {
    if (dirty && !confirm(t.leave)) return;
    editor.select(null);
    onDone();
  }

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(PIECE) && !e.dataTransfer.types.includes(FINISH)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDrop = (e: DragEvent) => {
    const pieceData = e.dataTransfer.getData(PIECE), finishData = e.dataTransfer.getData(FINISH);
    if (!pieceData && !finishData) return;
    e.preventDefault();
    if (pieceData) {
      const template = JSON.parse(pieceData) as PieceTemplate;
      const floor = editor.floorAt(e.clientX, e.clientY);
      if (!floor) return;
      const id = furnitureId(editor.plan(), modelName(template) ?? template.type);
      const added: Furniture = { ...template, id, position: floor.position, ...(floor.level && { level: floor.level }), ...(floor.room && { room: floor.room }) };
      const at = editor.fit(added, floor.position);
      if (!at) return flash(t.noRoom);
      void commit(addFurniture(present, { ...added, position: at })).then(() => editor.select(id));
      return;
    }
    const finish = JSON.parse(finishData) as MaterialDef;
    const hit = editor.surfaceAt(e.clientX, e.clientY);
    if (!hit) return flash(t.notPaintable);
    const surfaces = e.shiftKey && hit.finish ? editor.surfacesWith(hit.finish) : [hit.surface];
    void commit(paintSurfaces(present, editor.plan(), surfaces, finish, state.designOption));
  };

  dropTarget.current = { onDragOver, onDrop };
  useMountEffect(() => () => {
    dropTarget.current = null;
  });

  const blocked = state.blocked;
  const blockedText = blocked && (blocked.kind === "furniture" ? t.inTheWay.furniture(blocked.id) : t.inTheWay[blocked.kind]);

  return (
    <>
      <section
        data-viewer-editing=""
        aria-label={t.title}
        className="pointer-events-auto absolute top-3 right-3 bottom-24 flex w-72 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[20px] bg-popover text-popover-foreground shadow-overlay motion-safe:animate-in motion-safe:fade-in-0"
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
          <TabsContent value="furniture" className="min-h-0 flex-1 overflow-y-auto p-2">
            <p className="px-1 pb-2 text-2xs text-muted-foreground">{t.dragHint}</p>
            <FurnitureTray viewer={viewer} />
          </TabsContent>
          <TabsContent value="materials" className="min-h-0 flex-1 overflow-y-auto p-2">
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
            ) : piece && editor.locked(piece.id) ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground">
                <LockIcon aria-hidden="true" className="size-3.5" />
                <span className="font-medium text-foreground">{pieceLabel(piece, t.types)}</span>
                {t.builtIn}
              </span>
            ) : piece && (
              <>
                <span className="max-w-48 truncate px-2.5 text-xs font-medium">{pieceLabel(piece, t.types)}<span className="ml-1.5 font-normal text-muted-foreground">{piece.id}</span></span>
                <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />
                <button type="button" className={pillItem} onClick={turn}><RotateCwIcon aria-hidden="true" />{t.turn}</button>
                <Hint label={t.duplicate} keys="⌘D">
                  <button type="button" className={pillItem} onClick={duplicate}><CopyIcon aria-hidden="true" />{t.duplicate}</button>
                </Hint>
                <Hint label={t.remove} keys="⌫">
                  <button type="button" className={pillItem} onClick={remove}><Trash2Icon aria-hidden="true" />{t.remove}</button>
                </Hint>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** The library model id of a piece, for its label and the ids of its copies. */
const modelName = (f: Pick<Furniture, "model">) => f.model?.replace(/^.*\//, "").replace(/\.glb$/, "");
const humanize = (id: string) => id.replace(/[_-]+/g, " ").replace(/\s\d+$/, "").replace(/^\w/, (c) => c.toUpperCase());
const pieceLabel = (f: Pick<Furniture, "model" | "type">, types: Record<FurnitureType, string>) => (f.model ? humanize(modelName(f)!) : types[f.type]);

function TrayGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pb-3">
      <h3 className="px-1 pb-1.5 text-2xs font-medium text-muted-foreground">{title}</h3>
      <div className="grid grid-cols-2 gap-1.5">{children}</div>
    </section>
  );
}

function TrayItem({ label, data, kind, swatch }: { label: string; data: unknown; kind: typeof PIECE | typeof FINISH; swatch?: ReactNode }) {
  return (
    <button
      type="button"
      draggable
      title={label}
      className="flex h-10 cursor-grab items-center gap-2 rounded-xl bg-foreground/4 px-2 text-left text-xs select-none hover:bg-foreground/8 active:cursor-grabbing"
      onDragStart={(e) => {
        e.dataTransfer.setData(kind, JSON.stringify(data));
        e.dataTransfer.effectAllowed = "copy";
      }}
    >
      {swatch}
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function FurnitureTray({ viewer }: { viewer: ViewerInstance }) {
  const t = useT().viewer.edit;
  const editor = viewer.editor!;
  const plan = editor.plan();
  // The project's own pieces: each model or look the agent used, once.
  const own = new Map<string, PieceTemplate>();
  for (const f of plan.furniture ?? []) {
    if (f.type === "stairs" || f.roof) continue;
    const { id: _id, position: _p, level: _l, room: _r, designOptions: _o, rotation: _t, ...template } = f;
    const key = f.model ?? `${f.type}|${f.material ?? ""}|${f.accent ?? ""}|${f.size ?? ""}`;
    if (!own.has(key)) own.set(key, template);
  }
  const { models } = editor.catalog();
  return (
    <>
      <TrayGroup title={t.groups.project}>
        {[...own.entries()].map(([key, template]) => (
          <TrayItem key={key} kind={PIECE} data={template} label={pieceLabel(template, t.types)} swatch={<Dot color={swatchColor(template.material)} />} />
        ))}
      </TrayGroup>
      {!!models.length && (
        <TrayGroup title={t.groups.library}>
          {models.map((m) => (
            <TrayItem key={m.id} kind={PIECE} data={{ type: "box", model: m.path, size: m.size } satisfies PieceTemplate} label={humanize(m.id)} />
          ))}
        </TrayGroup>
      )}
      <TrayGroup title={t.groups.pieces}>
        {PLACEABLE.map((type) => (
          <TrayItem key={type} kind={PIECE} data={{ type } satisfies PieceTemplate} label={t.types[type]} />
        ))}
      </TrayGroup>
    </>
  );
}

const swatchColor = (key?: string) => (key?.startsWith("#") ? key : undefined);
const Dot = ({ color }: { color?: string }) => (
  <span aria-hidden="true" className="size-4 shrink-0 rounded-full border border-border bg-foreground/10" style={color ? { background: color } : undefined} />
);

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
