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
  ArchiveIcon, ArmchairIcon, BathIcon, BedDoubleIcon, BoxIcon, CheckIcon, ChevronDownIcon, CookingPotIcon, DownloadIcon, Flower2Icon, LampFloorIcon,
  LockIcon, type LucideIcon, SearchIcon, Table2Icon, Trash2Icon, TvIcon,
} from "lucide-react";
import { type MouseEvent, type ReactNode, useRef, useState } from "react";
import { useFormat } from "./format";
import { useT } from "./locale";
import type { RoomInfo, ViewerInstance, ViewerState } from "./viewer-model";

/** A library model as its host knows it: what it is called, where it belongs and what it looks like. */
export interface CatalogPiece {
  /** Library ID; `@lib/models/<id>.glb` places it. */
  id: string;
  name: string;
  category: PieceCategory;
  /** [width, depth, height] in metres. */
  size?: [number, number, number];
  /** URL of a picture of it. */
  thumbnail?: string;
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

/** A picture of a piece, or its category's symbol when there is none. */
function Picture({ src, category, className }: { src?: string; category: PieceCategory; className?: string }) {
  const Icon = ICONS[category];
  return (
    <span className={cn("relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-foreground/6 text-muted-foreground", className)}>
      <Icon aria-hidden="true" className="size-4" />
      {src && <img alt="" src={src} loading="lazy" draggable={false} className="absolute inset-0 size-full object-cover" />}
    </span>
  );
}

/** A card for a piece to add: drag it into place, or click to put it in the room on show. */
function PieceCard({ name, meta, category, thumbnail, template, title, onAdd, action }: {
  name: string; meta?: string; category: PieceCategory; thumbnail?: string; template?: PieceTemplate; title?: string;
  onAdd?: (template: PieceTemplate, e: MouseEvent<HTMLElement>) => void; action?: ReactNode;
}) {
  const t = useT().viewer.edit;
  // Built-in pieces have no picture: a symbol and their name are enough.
  const compact = !thumbnail && !action;
  return (
    <div className="group relative flex min-w-0 flex-col overflow-hidden rounded-xl bg-foreground/4 hover:bg-foreground/8">
      <button
        type="button"
        draggable={!!template}
        disabled={!template && !action}
        title={title ?? (template ? `${name}. ${t.catalog.clickHint}` : name)}
        aria-label={name}
        className={cn("flex min-w-0 text-left select-none outline-none focus-visible:ring-2 focus-visible:ring-ring", compact ? "items-center gap-2 p-1.5" : "flex-col gap-1 p-1.5", template ? "cursor-grab active:cursor-grabbing" : "cursor-default")}
        onClick={(e) => template && onAdd?.(template, e)}
        onDragStart={(e) => {
          if (!template) return e.preventDefault();
          e.dataTransfer.setData(PIECE, JSON.stringify(template));
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        {compact ? (
          <>
            <Picture category={category} className="size-8" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs font-medium">{name}</span>
              {meta && <span className="truncate text-2xs text-muted-foreground tabular-nums">{meta}</span>}
            </span>
          </>
        ) : (
          <>
            <Picture src={thumbnail} category={category} className="aspect-4/3 w-full" />
            <span className="truncate px-0.5 text-xs font-medium">{name}</span>
            {meta && <span className="-mt-1 truncate px-0.5 text-2xs text-muted-foreground tabular-nums">{meta}</span>}
          </>
        )}
      </button>
      {action && <div className="absolute top-2.5 right-2.5">{action}</div>}
    </div>
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
                <div key={f.id} data-placed-piece={f.id} ref={selected ? (row) => {
                  if (!row || scrolledTo.current === f.id) return;
                  scrolledTo.current = f.id;
                  row.scrollIntoView({ block: "nearest" });
                } : undefined} className={cn("group flex items-center gap-2 rounded-xl p-1 pr-1.5 hover:bg-foreground/6", selected && "bg-foreground/9 hover:bg-foreground/9")}>
                  <button type="button" aria-pressed={selected} onClick={() => editor.select(selected ? null : f.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Picture src={library?.thumbnail} category={library?.category ?? FURNITURE_CATEGORY[f.type]} className="size-9" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-xs font-medium">{pieceLabel(f, t.types, pieces)}</span>
                      <span className="truncate text-2xs text-muted-foreground tabular-nums">{dimensions(f.size ?? library?.size ?? FURNITURE_DEFAULT_SIZE[f.type])}</span>
                    </span>
                  </button>
                  {locked ? (
                    <LockIcon aria-label={t.catalog.fixed} className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <button type="button" aria-label={`${t.remove}: ${pieceLabel(f, t.types, pieces)}`} title={t.remove} onClick={() => onRemove(f.id)} className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-foreground/8 hover:text-foreground focus-visible:opacity-100 [&_svg]:size-3.5">
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

/**
 * Everything someone can add, found by name and sorted into categories: the project's own pieces,
 * the library with its pictures, built-in shapes, and a remote catalog the host can search.
 */
export function AddPanel({ viewer, plan, pieces, search, add, onAdd }: {
  viewer: ViewerInstance; plan: Plan; pieces: Map<string, CatalogPiece>;
  search?: (query: string, signal: AbortSignal) => Promise<RemotePiece[]>;
  add?: (piece: RemotePiece) => Promise<CatalogPiece>;
  onAdd: (template: PieceTemplate, e: MouseEvent<HTMLElement>) => void;
}) {
  const t = useT().viewer.edit;
  const dimensions = useDimensions();
  const editor = viewer.editor!;
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<PieceCategory | "all">("all");
  const [remote, setRemote] = useState<Remote>({ status: "idle" });
  const [searching, setSearching] = useState<AbortController | null>(null);
  const [adding, setAdding] = useState<Record<string, "adding" | CatalogPiece | "failed">>({});
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
  const library = editor.catalog().models.map((m) => {
    const known = pieces.get(m.id);
    return { ...m, name: known?.name ?? humanize(m.id), category: known?.category ?? pieceCategory(m.id), thumbnail: known?.thumbnail, source: known?.source, credit: known?.credit };
  }).filter((m) => matches(`${m.name} ${m.id} ${t.categories[m.category]} ${m.source ?? ""}`, m.category));
  const shapes = PLACEABLE.filter((type) => matches(`${t.types[type]} ${t.categories[FURNITURE_CATEGORY[type]]}`, FURNITURE_CATEGORY[type]));
  const inLibrary = new Map(editor.catalog().models.map((m) => [m.id, m]));

  // The remote catalog is indexed in English, so a category alone searches by its English key.
  const remoteQuery = query.trim() || (category !== "all" && category !== "other" ? category : "");
  async function runSearch() {
    if (!search || !remoteQuery) return;
    searching?.abort();
    const controller = new AbortController();
    setSearching(controller);
    setRemote({ status: "searching", query: remoteQuery });
    try {
      const found = await search(remoteQuery, controller.signal);
      if (!controller.signal.aborted) setRemote({ status: "done", query: remoteQuery, pieces: found });
    } catch {
      if (!controller.signal.aborted) setRemote({ status: "failed", query: remoteQuery });
    }
  }
  async function bring(piece: RemotePiece) {
    if (!add) return;
    setAdding((current) => ({ ...current, [piece.key]: "adding" }));
    try {
      const added = await add(piece);
      await editor.reloadCatalog();
      setAdding((current) => ({ ...current, [piece.key]: added }));
    } catch {
      setAdding((current) => ({ ...current, [piece.key]: "failed" }));
    }
  }
  const remotePieces = remote.status === "done" ? remote.pieces.filter((p) => category === "all" || p.category === category) : [];
  const nothing = !ownShown.length && !library.length && !shapes.length;

  return (
    <>
      <search className="mb-2 block px-1">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <SearchIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t.catalog.search} aria-label={t.catalog.search} className="h-8 pl-8 text-xs md:text-xs" />
        </form>
      </search>
      <fieldset className="mb-2 flex flex-wrap gap-1 border-0 px-1">
        <legend className="sr-only">{t.catalog.categories}</legend>
        {(["all", ...PIECE_CATEGORIES] as const).map((c) => (
          <button key={c} type="button" aria-pressed={category === c} onClick={() => setCategory(c)} className="inline-flex h-7 shrink-0 items-center rounded-lg px-2 text-xs font-medium whitespace-nowrap text-muted-foreground hover:bg-foreground/7 hover:text-foreground aria-pressed:bg-foreground/11 aria-pressed:text-foreground">
            {c === "all" ? t.catalog.all : t.categories[c]}
          </button>
        ))}
      </fieldset>
      <p className="px-1 pb-2 text-2xs text-muted-foreground">{t.catalog.clickHint}</p>
      {!!library.length && (
        <TrayGroup title={t.groups.library}>
          {library.map((m) => (
            <PieceCard key={m.id} name={m.name} category={m.category} thumbnail={m.thumbnail} meta={[dimensions(m.size), m.source].filter(Boolean).join(" · ")} title={m.credit ? `${m.name}. ${m.credit}` : undefined} template={{ type: "box", model: m.path, size: m.size }} onAdd={onAdd} />
          ))}
        </TrayGroup>
      )}
      {!!ownShown.length && (
        <TrayGroup title={t.groups.project}>
          {ownShown.map(([key, item]) => (
            <PieceCard key={key} name={item.label} category={item.category} thumbnail={item.template.model ? pieces.get(modelName(item.template)!)?.thumbnail : undefined} template={item.template} onAdd={onAdd} meta={dimensions(item.template.size ?? (item.template.model ? pieces.get(modelName(item.template)!)?.size : FURNITURE_DEFAULT_SIZE[item.template.type]))} />
          ))}
        </TrayGroup>
      )}
      {!!shapes.length && (
        <TrayGroup title={t.groups.pieces}>
          {shapes.map((type) => (
            <TrayItem key={type} kind={PIECE} data={{ type } satisfies PieceTemplate} label={t.types[type]} onClick={(e) => onAdd({ type }, e)} title={`${t.types[type]}. ${t.catalog.clickHint}`} swatch={<Picture category={FURNITURE_CATEGORY[type]} className="size-6 rounded-md [&_svg]:size-3.5" />} />
          ))}
        </TrayGroup>
      )}
      {nothing && <p className="px-1 pb-3 text-xs text-muted-foreground">{t.catalog.noMatches}</p>}
      {search && (
        <section aria-label={t.catalog.remote} className="border-t border-border pt-3 pb-1">
          <h3 className="px-1 pb-1 text-2xs font-medium text-muted-foreground">{t.catalog.remote}</h3>
          <p className="px-1 pb-2 text-2xs text-muted-foreground">{t.catalog.remoteNote}</p>
          <button
            type="button"
            disabled={!remoteQuery || remote.status === "searching"}
            onClick={() => void runSearch()}
            className="mx-1 mb-2 inline-flex h-7 max-w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-lg bg-foreground/7 px-2.5 text-xs font-medium hover:bg-foreground/11 disabled:opacity-50 [&_svg]:size-3.5"
          >
            {remote.status === "searching" ? <Spinner className="size-3.5" /> : <SearchIcon aria-hidden="true" />}
            <span className="truncate">{remoteQuery ? t.catalog.searchRemote(remoteQuery) : t.catalog.typeToSearch}</span>
          </button>
          {remote.status === "failed" && <p role="status" className="px-1 pb-2 text-2xs text-destructive">{t.catalog.remoteFailed}</p>}
          {remote.status === "done" && !remotePieces.length && <p role="status" className="px-1 pb-2 text-2xs text-muted-foreground">{t.catalog.remoteNone(remote.query)}</p>}
          {!!remotePieces.length && (
            <div className="grid grid-cols-2 gap-1.5">
              {remotePieces.map((piece) => {
                const state = adding[piece.key];
                const added = typeof state === "object" ? state : undefined;
                const id = added?.id ?? piece.libraryId;
                const placeable = id ? inLibrary.get(id) : undefined;
                return (
                  <PieceCard
                    key={piece.key}
                    name={piece.name}
                    category={piece.category}
                    thumbnail={added?.thumbnail ?? piece.thumbnail}
                    meta={[dimensions(piece.size), piece.license].filter(Boolean).join(" · ")}
                    template={placeable ? { type: "box", model: placeable.path, size: placeable.size } : undefined}
                    title={placeable ? `${piece.name}. ${t.catalog.clickHint}` : `${piece.name}. ${piece.source}${piece.license ? `, ${piece.license}` : ""}`}
                    onAdd={onAdd}
                    action={
                      placeable ? (
                        <span title={t.catalog.inLibrary} className="flex size-6 items-center justify-center rounded-full bg-popover/90 text-foreground shadow-popover [&_svg]:size-3.5"><CheckIcon aria-label={t.catalog.inLibrary} /></span>
                      ) : (
                        <button
                          type="button"
                          disabled={state === "adding"}
                          aria-label={`${t.catalog.addToLibrary}: ${piece.name}`}
                          title={state === "failed" ? t.catalog.addFailed : t.catalog.addToLibrary}
                          onClick={() => void bring(piece)}
                          className={cn("flex size-6 items-center justify-center rounded-full bg-popover/90 shadow-popover hover:bg-popover [&_svg]:size-3.5", state === "failed" ? "text-destructive" : "text-foreground")}
                        >
                          {state === "adding" ? <Spinner className="size-3.5" /> : <DownloadIcon aria-hidden="true" />}
                        </button>
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </section>
      )}
    </>
  );
}
