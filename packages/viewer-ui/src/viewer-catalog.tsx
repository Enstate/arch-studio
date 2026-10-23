import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@arch/ui/components/dropdown-menu";
import { Input } from "@arch/ui/components/input";
import { Spinner } from "@arch/ui/components/spinner";
import { cn } from "@arch/ui/lib/utils";
import { FURNITURE_CATEGORY, PIECE_CATEGORIES, pieceCategory, type PieceCategory } from "@arch/viewer/plan/categories";
import { FURNITURE_DEFAULT_SIZE } from "@arch/viewer/plan/furnitureSizes";
import { roomAt } from "@arch/viewer/plan/geom";
import { levelOf, levelPlan } from "@arch/viewer/plan/levels";
import { shownInOption } from "@arch/viewer/plan/options";
import type { Furniture, FurnitureType, Plan } from "@arch/viewer/plan/schema";
import {
  ArchiveIcon, ArmchairIcon, LayoutGridIcon, BathIcon, BedDoubleIcon, BoxIcon, ChevronDownIcon, CookingPotIcon, DownloadIcon, Flower2Icon, LampFloorIcon,
  LockIcon, type LucideIcon, SearchIcon, Table2Icon, Trash2Icon, TvIcon,
} from "lucide-react";
import { Fragment, type MouseEvent, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { useFormat } from "./format";
import { useT } from "./locale";
import type { RoomInfo, ViewerInstance, ViewerState } from "./viewer-model";

type ViewerEditor = NonNullable<ViewerInstance["editor"]>;

/** A library model as its host knows it: what it is called, where it belongs and what it looks like. */
export interface CatalogPiece {
  /** Library ID; `@lib/models/<id>.glb` places it. */
  id: string;
  name: string;
  category: PieceCategory;
  /** [width, depth, height] in metres. */
  size?: [number, number, number];
  /** Where it comes from, when that is not the host's own library, such as "NVIDIA SimReady". */
  source?: string;
  /** Attribution its licence asks for. */
  credit?: string;
}

/** A piece in a catalog outside the library, which joins the library when added. */
export interface RemotePiece {
  /** The host's own reference to it. */
  key: string;
  name: string;
  category: PieceCategory;
  size?: [number, number, number];
  thumbnail?: string;
  source: string;
  license?: string;
  /** The library ID it takes once added, so a piece already there can be placed at once. */
  libraryId?: string;
}

/** A piece in a tray, without an id or a place yet. */
export type PieceTemplate = Omit<Furniture, "id" | "position" | "level" | "room">;
export const PIECE = "application/x-arch-piece";
export const FINISH = "application/x-arch-finish";

/** The library model id of a piece, for its label and the ids of its copies. */
export const modelName = (f: Pick<Furniture, "model">) => f.model?.replace(/^.*\//, "").replace(/\.glb$/, "");
export const humanize = (id: string) => id.replace(/[_-]+/g, " ").replace(/\s\d+$/, "").replace(/^\w/, (c) => c.toUpperCase());
export const pieceLabel = (f: Pick<Furniture, "model" | "type">, types: Record<FurnitureType, string>, pieces?: Map<string, CatalogPiece>) =>
  f.model ? (pieces?.get(modelName(f)!)?.name ?? humanize(modelName(f)!)) : types[f.type];

const ICONS: Record<PieceCategory, LucideIcon> = {
  seating: ArmchairIcon, tables: Table2Icon, storage: ArchiveIcon, beds: BedDoubleIcon, lighting: LampFloorIcon,
  kitchen: CookingPotIcon, bathroom: BathIcon, appliances: TvIcon, decor: Flower2Icon, other: BoxIcon,
};

/** Pieces worth placing by hand; stairs come from the agent with the storeys they join. */
const PLACEABLE = (Object.keys(FURNITURE_DEFAULT_SIZE) as FurnitureType[]).filter((type) => type !== "stairs");

export function TrayGroup({ title, aside, children, grid = "two" }: { title: string; aside?: ReactNode; children: ReactNode; grid?: "two" | "list" }) {
  return (
    <section className="pb-3">
      <h3 className="flex items-center gap-2 px-1 pb-1.5 text-2xs font-medium text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {aside}
      </h3>
      <div className={grid === "two" ? "grid grid-cols-2 gap-1.5" : "flex flex-col gap-0.5"}>{children}</div>
    </section>
  );
}

export function TrayItem({ label, data, kind, swatch, onClick, title }: { label: string; data: unknown; kind: typeof PIECE | typeof FINISH; swatch?: ReactNode; onClick?: (e: MouseEvent<HTMLButtonElement>) => void; title?: string }) {
  return (
    <button
      type="button"
      draggable
      title={title ?? label}
      className="flex h-10 cursor-grab items-center gap-2 rounded-xl bg-foreground/4 px-2 text-left text-xs select-none hover:bg-foreground/8 active:cursor-grabbing"
      onClick={onClick}
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

export const Dot = ({ color }: { color?: string }) => (
  <span aria-hidden="true" className="size-4 shrink-0 rounded-full border border-border bg-foreground/10" style={color ? { background: color } : undefined} />
);

/**
 * Pictures the viewer takes of pieces, shared by every card and row showing the same look. A
 * picture is asked for when its element first scrolls into view, and taken once per look.
 */
class PictureShelf {
  private taken = new Map<string, string>();
  private asked = new Set<string>();
  private listeners = new Set<() => void>();
  constructor(private editor: ViewerEditor) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  get = (key: string) => this.taken.get(key);
  ask(key: string, piece: PieceTemplate) {
    if (this.asked.has(key)) return;
    this.asked.add(key);
    this.editor.picture(piece).then((url) => {
      this.taken.set(key, url);
      for (const listener of this.listeners) listener();
    }, (error) => {
      this.asked.delete(key);
      console.warn("A piece picture could not be taken", error);
    });
  }
}
const shelves = new WeakMap<ViewerEditor, PictureShelf>();
const shelfOf = (editor: ViewerEditor) => shelves.get(editor) ?? shelves.set(editor, new PictureShelf(editor)).get(editor)!;
const lookOf = ({ level: _l, room: _r, rotation: _t, designOptions: _o, ...look }: PieceTemplate & Partial<Furniture>) => look;

/**
 * A picture of a piece: one the viewer takes of `piece` in the editor's light, so built-in shapes,
 * the project's pieces and library models all look alike, or a remote catalog's own `src`. Its
 * category's symbol shows until the picture is there.
 */
function Picture({ editor, piece, src, category, className }: { editor?: ViewerEditor; piece?: PieceTemplate; src?: string; category: PieceCategory; className?: string }) {
  const shelf = editor && piece ? shelfOf(editor) : undefined;
  const key = piece ? JSON.stringify(lookOf(piece)) : "";
  const taken = useSyncExternalStore(shelf?.subscribe ?? noSubscription, () => shelf?.get(key));
  const url = taken ?? src;
  const Icon = ICONS[category];
  // Asks for the picture once the element is on screen.
  const watch = (element: HTMLSpanElement | null) => {
    if (!element || !shelf || !piece || taken) return;
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      shelf.ask(key, lookOf(piece));
    });
    seen.observe(element);
    return () => seen.disconnect();
  };
  return (
    <span ref={watch} className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/5 text-muted-foreground", className)}>
      <Icon aria-hidden="true" className={cn("size-4", !url && shelf && "motion-safe:animate-pulse")} />
      {url && <img alt="" src={url} loading="lazy" draggable={false} className={cn("absolute inset-0 size-full", taken ? "object-contain p-[6%]" : "object-cover")} />}
    </span>
  );
}
const noSubscription = () => () => undefined;
/** A transparent drag image, loaded before any drag starts. */
const NOTHING = typeof Image === "undefined" ? (undefined as unknown as HTMLImageElement) : Object.assign(new Image(), { src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" });

/**
 * A card for a piece to add: drag it into place, or click it. A card without a template, such as a
 * remote piece not added yet, cannot be dragged.
 */
function PieceCard({ name, meta, category, editor, template, src, title, onPick, onCarry, badge, busy }: {
  name: string; meta?: string; category: PieceCategory; editor: ViewerEditor; template?: PieceTemplate; src?: string; title?: string;
  onPick: (card: HTMLElement) => void; onCarry?: (template: PieceTemplate | null) => void; badge?: ReactNode; busy?: boolean;
}) {
  const t = useT().viewer.edit;
  return (
    <button
      type="button"
      draggable={!!template}
      disabled={busy}
      aria-busy={busy || undefined}
      title={title ?? [name, meta, t.catalog.clickHint].filter(Boolean).join(" · ")}
      className="group relative flex min-w-0 flex-col gap-1 rounded-xl bg-foreground/4 p-1.5 text-left select-none outline-none hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-progress aria-busy:opacity-70 data-[draggable=true]:cursor-grab data-[draggable=true]:active:cursor-grabbing"
      data-draggable={!!template}
      onClick={(e) => onPick(e.currentTarget)}
      onDragStart={(e) => {
        if (!template) return e.preventDefault();
        e.dataTransfer.setData(PIECE, JSON.stringify(template));
        e.dataTransfer.effectAllowed = "copy";
        // The piece itself follows the pointer in the view, not a picture of the card.
        if (onCarry) e.dataTransfer.setDragImage(NOTHING, 0, 0);
        onCarry?.(template);
      }}
      onDragEnd={() => onCarry?.(null)}
    >
      <Picture editor={editor} piece={template} src={src} category={category} className="aspect-4/3 w-full" />
      <span className="truncate px-0.5 pb-0.5 text-xs font-medium">{name}</span>
      {(badge || busy) && (
        <span className="absolute top-2.5 right-2.5 flex size-6 items-center justify-center rounded-full bg-popover/90 text-foreground shadow-popover [&_svg]:size-3.5">
          {busy ? <Spinner className="size-3.5" /> : badge}
        </span>
      )}
    </button>
  );
}

function useDimensions() {
  const format = useFormat();
  return (size?: readonly number[]) => size && `${size.slice(0, 2).map((v) => format.number(v, { maximumFractionDigits: 2 })).join(" × ")} m`;
}

/** The storey on show and the room it shows, if that room is on it. */
export function shownRoom(viewer: ViewerInstance, state: ViewerState): { level: string | null; room: RoomInfo | undefined } {
  const rooms = viewer.rooms();
  const room = rooms.find((r) => r.id === state.room && (!state.level || !r.level || r.level === state.level));
  return { level: state.level, room };
}

/** Where a piece stands: its own room, or the room its centre is in. */
const roomOf = (plan: Plan, f: Furniture) => f.room ?? roomAt(levelPlan(plan, levelOf(plan, f.level)), f.position)?.id ?? null;

/**
 * What stands in the room on show, or on the whole storey: select a piece to move, turn or
 * remove it. Roofs never show; pieces of other design options neither.
 */
export function PlacedList({ viewer, state, plan, pieces, onRemove, onBrowse }: {
  viewer: ViewerInstance; state: ViewerState; plan: Plan; pieces: Map<string, CatalogPiece>;
  onRemove: (id: string) => void; onBrowse: () => void;
}) {
  const t = useT().viewer.edit;
  const dimensions = useDimensions();
  const editor = viewer.editor!;
  const { level, room } = shownRoom(viewer, state);
  // "Whole floor" holds until another room is shown, by the menu or a room label in the view.
  const [floorFrom, setFloorFrom] = useState<string | null | undefined>(undefined);
  const scoped = room && floorFrom !== room.id ? room : undefined;
  // The selected row scrolls into view once each time the selection changes, not on every render.
  const scrolledTo = useRef<string | null>(null);
  const rooms = viewer.rooms();
  const storeyRooms = rooms.filter((r) => !level || !r.level || r.level === level);
  const onStorey = (plan.furniture ?? []).filter((f) => !f.roof && shownInOption(f, state.designOption) && (!level || levelOf(plan, f.level).id === level));
  const placed = onStorey.map((f) => ({ f, room: roomOf(plan, f) })).filter((p) => !scoped || p.room === scoped.id);
  // Grouped by room, in the order the plan lists its rooms; pieces outside every room come last.
  const groups = new Map<string | null, Furniture[]>();
  for (const id of [...rooms.map((r) => r.id), null]) groups.set(id, []);
  for (const p of placed) groups.get(groups.has(p.room) ? p.room : null)!.push(p.f);
  const roomName = (id: string | null) => (id ? rooms.find((r) => r.id === id)?.name ?? id : t.catalog.noRoomName);

  return (
    <>
      {/* Choosing a room also takes the view there, as its label on the plan does. */}
      <DropdownMenu>
        <DropdownMenuTrigger aria-label={t.catalog.scope} data-placed-scope="" className="mx-1 mb-2 inline-flex h-7 max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-lg bg-foreground/5 px-2.5 text-xs font-medium hover:bg-foreground/9 [&_svg]:size-3.5">
          <span className="truncate">{scoped ? scoped.name : t.catalog.wholeFloor}</span>
          <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-56">
          <DropdownMenuRadioGroup
            value={scoped?.id ?? ""}
            onValueChange={(value) => {
              setFloorFrom(value ? undefined : (room?.id ?? null));
              if (value && value !== room?.id) viewer.focusRoom(String(value));
            }}
          >
            <DropdownMenuRadioItem closeOnClick value="">{t.catalog.wholeFloor}</DropdownMenuRadioItem>
            {!!storeyRooms.length && <DropdownMenuSeparator />}
            {storeyRooms.map((r) => (
              <DropdownMenuRadioItem closeOnClick key={r.id} value={r.id}>{r.name}</DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {!placed.length ? (
        <div className="flex flex-col items-start gap-2 px-1 py-4">
          <p className="text-xs text-muted-foreground">{scoped ? t.catalog.emptyRoom(scoped.name) : t.catalog.emptyFloor}</p>
          <button type="button" onClick={onBrowse} className="inline-flex h-7 items-center rounded-lg bg-foreground/7 px-2.5 text-xs font-medium hover:bg-foreground/11">{t.catalog.browse}</button>
        </div>
      ) : (
        [...groups].filter(([, list]) => list.length).map(([id, list]) => (
          <TrayGroup key={id ?? "none"} title={scoped ? t.catalog.count(list.length) : `${roomName(id)} · ${list.length}`} grid="list">
            {list.map((f) => {
              const library = f.model ? pieces.get(modelName(f)!) : undefined;
              const locked = editor.locked(f.id);
              const selected = state.selected === f.id;
              return (
                <div
                  key={f.id}
                  data-placed-piece={f.id}
                  ref={selected ? (row) => {
                    if (!row || scrolledTo.current === f.id) return;
                    scrolledTo.current = f.id;
                    row.scrollIntoView({ block: "nearest" });
                  } : undefined}
                  className={cn("group flex items-center gap-2 rounded-xl p-1 pr-1.5 hover:bg-foreground/6", selected && "bg-foreground/9 hover:bg-foreground/9")}
                >
                  <button type="button" aria-pressed={selected} onClick={() => editor.select(selected ? null : f.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Picture editor={editor} piece={f} category={library?.category ?? FURNITURE_CATEGORY[f.type]} className="size-10" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium">{pieceLabel(f, t.types, pieces)}</span>
                      <span className="truncate text-2xs text-muted-foreground tabular-nums">{dimensions(f.size ?? library?.size ?? FURNITURE_DEFAULT_SIZE[f.type])}</span>
                    </span>
                  </button>
                  {locked ? (
                    <LockIcon aria-label={t.catalog.fixed} className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <button type="button" aria-label={`${t.remove}: ${pieceLabel(f, t.types, pieces)}`} title={t.remove} onClick={() => onRemove(f.id)} className="flex h-7 min-w-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5">
                      <Trash2Icon aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </TrayGroup>
        ))
      )}
    </>
  );
}

type Remote = { status: "idle" } | { status: "searching"; query: string } | { status: "done"; query: string; pieces: RemotePiece[] } | { status: "failed"; query: string };

/** How long typing pauses before a search goes out to the remote catalog. */
const SEARCH_PAUSE = 450;

/** Which kind of piece the add panel shows, as a menu beside its search field. */
function CategoryMenu({ value, onChange }: { value: PieceCategory | "all"; onChange: (category: PieceCategory | "all") => void }) {
  const t = useT().viewer.edit;
  const Icon = value === "all" ? LayoutGridIcon : ICONS[value];
  const name = (c: PieceCategory | "all") => (c === "all" ? t.catalog.all : t.categories[c]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label={t.catalog.categories} data-piece-category="" className="inline-flex h-8 max-w-32 shrink-0 items-center gap-1.5 rounded-lg bg-foreground/5 px-2.5 text-xs font-medium hover:bg-foreground/9 aria-expanded:bg-foreground/9 [&_svg]:size-3.5">
        <Icon aria-hidden="true" className="text-muted-foreground" />
        <span className="truncate">{name(value)}</span>
        <ChevronDownIcon aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-48">
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as PieceCategory | "all")}>
          {(["all", ...PIECE_CATEGORIES] as const).map((c, i) => {
            const ItemIcon = c === "all" ? LayoutGridIcon : ICONS[c];
            return (
              <Fragment key={c}>
                {i === 1 && <DropdownMenuSeparator />}
                <DropdownMenuRadioItem closeOnClick value={c} className="gap-2 [&_svg]:size-3.5">
                  <ItemIcon aria-hidden="true" className="text-muted-foreground" />
                  {name(c)}
                </DropdownMenuRadioItem>
              </Fragment>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Everything someone can add, in one searchable grid sorted into categories: the project's own
 * pieces, the library, built-in shapes, and what a remote catalog has for the same words. A remote
 * piece joins the library when clicked and is placed at once.
 */
export function AddPanel({ viewer, plan, pieces, search, add, onAdd, onCarry }: {
  viewer: ViewerInstance; plan: Plan; pieces: Map<string, CatalogPiece>;
  search?: (query: string, signal: AbortSignal) => Promise<RemotePiece[]>;
  add?: (piece: RemotePiece) => Promise<CatalogPiece>;
  /** Places a piece; `card` is the element clicked, which locates the view it goes into. */
  onAdd: (template: PieceTemplate, card: HTMLElement) => void;
  /** The piece being dragged out of the tray, or null when the drag ends. */
  onCarry: (template: PieceTemplate | null) => void;
}) {
  const t = useT().viewer.edit;
  const dimensions = useDimensions();
  const editor = viewer.editor!;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PieceCategory | "all">("all");
  const [remote, setRemote] = useState<Remote>({ status: "idle" });
  const [adding, setAdding] = useState<Record<string, "adding" | "failed">>({});
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>({});
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string, of: PieceCategory) => (category === "all" || of === category) && words.every((word) => text.toLowerCase().includes(word));

  // The project's own pieces: each model or look the agent used, once.
  const own = new Map<string, { template: PieceTemplate; category: PieceCategory; label: string }>();
  for (const f of plan.furniture ?? []) {
    if (f.type === "stairs" || f.roof) continue;
    const { id: _id, position: _p, level: _l, room: _r, designOptions: _o, rotation: _t, ...template } = f;
    const key = f.model ?? `${f.type}|${f.material ?? ""}|${f.accent ?? ""}|${f.size ?? ""}`;
    const library = f.model ? pieces.get(modelName(f)!) : undefined;
    if (!own.has(key)) own.set(key, { template, category: library?.category ?? FURNITURE_CATEGORY[f.type], label: pieceLabel(f, t.types, pieces) });
  }
  const ownShown = [...own].filter(([, item]) => matches(`${item.label} ${t.categories[item.category]}`, item.category));
  const models = editor.catalog().models;
  const library = models.map((m) => {
    const known = pieces.get(m.id);
    return { ...m, name: known?.name ?? humanize(m.id), category: known?.category ?? pieceCategory(m.id), source: known?.source, credit: known?.credit };
  }).filter((m) => matches(`${m.name} ${m.id} ${t.categories[m.category]} ${m.source ?? ""}`, m.category));
  const shapes = PLACEABLE.filter((type) => matches(`${t.types[type]} ${t.categories[FURNITURE_CATEGORY[type]]}`, FURNITURE_CATEGORY[type]));
  const inLibrary = new Map(models.map((m) => [m.id, m]));

  /** Searches the remote catalog now, for the typed words or, without any, the category's English key. */
  async function searchRemote(text: string, of: PieceCategory | "all") {
    clearTimeout(pending.current.timer);
    pending.current.controller?.abort();
    const remoteQuery = text.trim() || (of !== "all" && of !== "other" ? of : "");
    if (!search || remoteQuery.length < 2) return setRemote({ status: "idle" });
    const controller = new AbortController();
    pending.current.controller = controller;
    setRemote({ status: "searching", query: remoteQuery });
    try {
      const found = await search(remoteQuery, controller.signal);
      if (!controller.signal.aborted) setRemote({ status: "done", query: remoteQuery, pieces: found });
    } catch {
      if (!controller.signal.aborted) setRemote({ status: "failed", query: remoteQuery });
    }
  }
  function type(text: string) {
    setQuery(text);
    clearTimeout(pending.current.timer);
    pending.current.timer = setTimeout(() => void searchRemote(text, category), SEARCH_PAUSE);
  }
  function choose(of: PieceCategory | "all") {
    setCategory(of);
    void searchRemote(query, of);
  }
  /** A remote piece goes into the library first, then into the room like any other piece. */
  async function bring(piece: RemotePiece, card: HTMLElement) {
    if (!add) return;
    setAdding((current) => ({ ...current, [piece.key]: "adding" }));
    try {
      const added = await add(piece);
      await editor.reloadCatalog();
      const model = editor.catalog().models.find((m) => m.id === added.id);
      setAdding(({ [piece.key]: _done, ...rest }) => rest);
      if (model) onAdd({ type: "box", model: model.path, size: model.size }, card);
    } catch {
      setAdding((current) => ({ ...current, [piece.key]: "failed" }));
    }
  }
  // Pieces already in the library show there; the remote list keeps the rest.
  const remotePieces = remote.status === "done" ? remote.pieces.filter((p) => (category === "all" || p.category === category) && !(p.libraryId && inLibrary.has(p.libraryId))) : [];
  const nothing = !ownShown.length && !library.length && !shapes.length && remote.status !== "searching" && !remotePieces.length;

  return (
    <>
      <search className="mb-3 flex gap-1.5 px-1">
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            void searchRemote(query, category);
          }}
        >
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(e) => type(e.target.value)} placeholder={search ? t.catalog.searchEverywhere : t.catalog.search} aria-label={t.catalog.search} className="h-8 pl-8 text-xs md:text-xs" />
        </form>
        <CategoryMenu value={category} onChange={choose} />
      </search>
      {!!library.length && (
        <TrayGroup title={category === "all" ? t.groups.library : t.categories[category]}>
          {library.map((m) => {
            const template: PieceTemplate = { type: "box", model: m.path, size: m.size };
            return <PieceCard key={m.id} name={m.name} category={m.category} editor={editor} template={template} meta={dimensions(m.size)} title={m.credit ? `${m.name}. ${m.credit}` : undefined} onPick={(card) => onAdd(template, card)} onCarry={onCarry} />;
          })}
        </TrayGroup>
      )}
      {!!ownShown.length && (
        <TrayGroup title={t.groups.project}>
          {ownShown.map(([key, item]) => (
            <PieceCard key={key} name={item.label} category={item.category} editor={editor} template={item.template} onPick={(card) => onAdd(item.template, card)} onCarry={onCarry} meta={dimensions(item.template.size ?? (item.template.model ? inLibrary.get(modelName(item.template)!)?.size : FURNITURE_DEFAULT_SIZE[item.template.type]))} />
          ))}
        </TrayGroup>
      )}
      {!!shapes.length && (
        <TrayGroup title={t.groups.pieces}>
          {shapes.map((type) => (
            <PieceCard key={type} name={t.types[type]} category={FURNITURE_CATEGORY[type]} editor={editor} template={{ type }} onPick={(card) => onAdd({ type }, card)} onCarry={onCarry} meta={dimensions(FURNITURE_DEFAULT_SIZE[type])} />
          ))}
        </TrayGroup>
      )}
      {search && remote.status !== "idle" && (
        <TrayGroup title={t.catalog.remote} aside={remote.status === "searching" && <Spinner className="size-3" />}>
          {remote.status === "failed" && <p role="status" className="col-span-2 px-1 text-2xs text-destructive">{t.catalog.remoteFailed}</p>}
          {remote.status === "done" && !remotePieces.length && <p role="status" className="col-span-2 px-1 text-2xs text-muted-foreground">{t.catalog.remoteNone(remote.query)}</p>}
          {remotePieces.map((piece) => (
            <PieceCard
              key={piece.key}
              name={piece.name}
              category={piece.category}
              editor={editor}
              src={piece.thumbnail}
              meta={[dimensions(piece.size), piece.license].filter(Boolean).join(" · ")}
              title={adding[piece.key] === "failed" ? t.catalog.addFailed : `${piece.name}. ${t.catalog.remoteHint}`}
              busy={adding[piece.key] === "adding"}
              badge={<DownloadIcon aria-label={t.catalog.notInLibrary} className={adding[piece.key] === "failed" ? "text-destructive" : undefined} />}
              onPick={(card) => void bring(piece, card)}
            />
          ))}
        </TrayGroup>
      )}
      {nothing && remote.status !== "done" && <p className="px-1 pb-3 text-xs text-muted-foreground">{t.catalog.noMatches}</p>}
    </>
  );
}
