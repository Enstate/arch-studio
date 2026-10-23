/**
 * Plan format, version 1.
 *
 * All lengths are meters. Plan coordinates follow the source image:
 * x grows to the right, y grows downward. The 3D scene maps plan (x, y)
 * to world (x, z), with world y pointing up.
 *
 * This file has no DOM or three.js imports so the Node scripts
 * (validate, shoot) can share it with the browser app.
 */

export type Vec2 = [number, number];

export interface Plan {
  version: 1;
  name: string;
  /** Free text: address, builder, plan number, anything that identifies the source. */
  description?: string;
  source?: PlanSource;
  defaults?: Partial<PlanDefaults>;
  /**
   * Storeys, bottom to top. Walls, rooms, furniture and cameras name their storey with `level`;
   * anything without one stands on the lowest. Omit for a single-storey plan.
   */
  levels?: Level[];
  /** May be empty: a plaza, a landscape or a site plan needs no walls. */
  walls: Wall[];
  openings?: Opening[];
  rooms?: Room[];
  furniture?: Furniture[];
  /** Named materials that rooms, walls and furniture can reference by key. */
  materials?: Record<string, MaterialDef>;
  /**
   * Alternative looks over the same architecture, which a viewer switches between in place. Each
   * one replaces finishes by material key and shows the furniture made for it.
   */
  designOptions?: DesignOption[];
  /** Fixed viewpoints. The critic loop renders each one and compares it with `photo`. */
  cameras?: CameraDef[];
  /** Guided tour order: room ids, or camera ids to show a room from that camera. */
  tour?: string[];
  /** Library HDRI id for the sky, the view out of the windows and reflections. */
  environment?: string;
  /**
   * Which way north is, in degrees clockwise from the top of the plan image. 0 = north is up.
   * Sets where the sun rises, peaks and sets, so the right rooms get sun.
   */
  north?: number;
  /** Site latitude in degrees, −90 to 90, from the project facts: the sun follows an equinox day there. */
  latitude?: number;
}

export interface PlanSource {
  /** Path relative to the plan folder, e.g. "source.png". */
  image: string;
  /** Pixels per meter in the source image, measured from a printed dimension. */
  pxPerMeter: number;
  /** Pixel position in the image that maps to plan (0, 0). Defaults to [0, 0]. */
  originPx?: Vec2;
  /** Which printed dimension was used for calibration, e.g. "Living 5.20 m wide". */
  calibratedFrom?: string;
  /** Overall outside dimensions printed on the plan, used by the validator. */
  overall?: Vec2;
}

export interface PlanDefaults {
  wallHeight: number;
  exteriorThickness: number;
  interiorThickness: number;
  doorHeight: number;
  windowSill: number;
  windowHeight: number;
  /** Paint or finish for wall faces that are not inside any room. */
  exteriorFinish: string;
  /** Paint for interior wall faces when the room sets no `wallFinish`. */
  interiorFinish: string;
  floor: string;
  ceiling: string;
}

export const DEFAULTS: PlanDefaults = {
  wallHeight: 2.6,
  exteriorThickness: 0.3,
  interiorThickness: 0.12,
  doorHeight: 2.1,
  windowSill: 0.9,
  windowHeight: 1.3,
  exteriorFinish: 'render-white',
  interiorFinish: 'paint-white',
  floor: 'oak',
  ceiling: 'paint-white',
};

/**
 * One storey. Heights of the walls, rooms, furniture and cameras on it are measured
 * from its finished floor, so a storey can be authored as if it stood on the ground.
 */
/** One look of the house: its finishes and its own furniture, over the architecture all options share. */
export interface DesignOption {
  id: string;
  name: string;
  /** The look a viewer opens with. At most one option sets it; otherwise the first is the default. */
  default?: boolean;
  /** Finishes this option uses in place of the plan's, by material key. */
  materials?: Record<string, MaterialDef>;
}

export interface Level {
  id: string;
  name: string;
  /** Finished floor height above the ground floor, in meters. */
  elevation: number;
  /** Floor to floor height, the default height of its walls. Defaults to `defaults.wallHeight`. */
  height?: number;
}

export interface Wall {
  id: string;
  level?: string;
  /** Centerline start. */
  a: Vec2;
  /** Centerline end. */
  b: Vec2;
  thickness?: number;
  height?: number;
  exterior?: boolean;
  /** Finish of the faces with no room beside them. Defaults to the exterior or interior finish. */
  outsideFinish?: string;
}

export type OpeningType = 'door' | 'double-door' | 'sliding-door' | 'window' | 'opening' | 'garage-door';

export interface Opening {
  id: string;
  wall: string;
  type: OpeningType;
  /** Distance from wall.a to the opening center, along the wall. */
  offset: number;
  width: number;
  height?: number;
  /** Height of the bottom edge above the floor. Windows only. */
  sill?: number;
  /** Which jamb the door hinges on, seen from wall.a looking at wall.b. */
  hinge?: 'start' | 'end';
  /** Side of the wall the door swings into: left or right of the a-to-b direction. */
  swing?: 'left' | 'right';
  /** Initial door leaf angle in degrees, 0 = closed. Defaults to 75. An authored 0 toggles open to 75. */
  openAngle?: number;
  frame?: string;
}

export interface Room {
  id: string;
  level?: string;
  name: string;
  /** Closed polygon along the inside faces or wall centerlines. Do not repeat the first point. */
  polygon: Vec2[];
  floor?: string;
  /** Ceiling finish, or false for no ceiling. Rooms get one only on a storey with walls. */
  ceiling?: string | false;
  wallFinish?: string;
  /** Finishes of single walls on this room's side, by wall id, in place of `wallFinish`. */
  wallFinishes?: Record<string, string>;
  /** Ceiling height above the room's floor; with `ceilingSlope`, its height at the low side. */
  ceilingHeight?: number;
  /** A ceiling that rises in one direction, as under a mono-pitch roof. Omit for a flat ceiling. */
  ceilingSlope?: CeilingSlope;
  /** Area printed on the plan in m², checked by the validator. */
  areaLabel?: number;
  /** Ceiling light color temperature in Kelvin. Omit for no ceiling light. */
  lightK?: number;
}

export interface CeilingSlope {
  /** Rise in metres per metre of run: 0.12 for a 12% pitch. */
  rise: number;
  /** Direction the ceiling rises toward, in degrees clockwise from the top of the plan. 90 rises to the right. */
  toward: number;
  /** Plan point where the ceiling is exactly `ceilingHeight`. Defaults to the room's lowest corner. */
  from?: Vec2;
}

export type FurnitureType =
  | 'bed' | 'nightstand' | 'wardrobe' | 'dresser'
  | 'sofa' | 'armchair' | 'coffee-table' | 'tv-unit' | 'tv' | 'rug' | 'bookshelf' | 'floor-lamp' | 'plant'
  | 'dining-table' | 'chair' | 'desk' | 'office-chair'
  | 'kitchen-base' | 'kitchen-tall' | 'kitchen-wall' | 'island' | 'fridge' | 'hob' | 'sink'
  | 'toilet' | 'basin' | 'vanity' | 'bathtub' | 'shower' | 'washer'
  | 'stairs' | 'box';

export interface Furniture {
  id: string;
  type: FurnitureType;
  /**
   * Storey the piece stands on. A `stairs` piece climbs from it by its height, and cuts its
   * footprint out of the ceilings above it and the floor it arrives at.
   */
  level?: string;
  /** Stays visible when loose furniture is hidden. Overrides the type's fixture default. */
  fixture?: boolean;
  /** Center of the footprint in plan coordinates. */
  position: Vec2;
  /** Rotation in degrees, clockwise in plan view. 0 means the front faces +y (down the plan). */
  rotation?: number;
  /** [width, depth, height]. Each type has a sensible default. */
  size?: [number, number, number];
  /** Main material key or a hex color such as "#7a6a58". */
  material?: string;
  /** Secondary material key or hex color (legs, cushions, worktop). */
  accent?: string;
  /**
   * glTF model, relative to the plan folder or "@lib/models/<id>.glb" from the library.
   * Without `size` it keeps its real-world size; with `size` it scales uniformly to fit inside it.
   */
  model?: string;
  room?: string;
  /** Height above floor of the bottom of the piece. Used for wall cabinets. */
  elevation?: number;
  /**
   * A roof the plan supplies, usually a `model`. Roofs never collide, show in walk mode, can be hidden
   * in 3D, and replace the flat slab the viewer would otherwise add over the top storey.
   */
  roof?: boolean;
  /** Terrain or site ground, usually a `model`: the walker follows its surface and sections never cut it. */
  ground?: boolean;
  /** Design options that show this piece. Omit for a piece every option shares. */
  designOptions?: string[];
}

export interface MaterialDef {
  /** Hex color. For textured materials this tints the texture. */
  color: string;
  roughness?: number;
  metalness?: number;
  /** Built-in procedural texture. */
  pattern?: 'planks' | 'herringbone' | 'tiles' | 'large-tiles' | 'carpet' | 'concrete' | 'plaster' | 'fabric';
  /**
   * Library PBR texture set (folder name under library/textures, see library/manifest.json).
   * Loads color, normal and roughness maps at real-world scale. Overrides `pattern` and `texture`.
   */
  pbr?: string;
  /**
   * false: use only the set's normal and roughness maps and keep `color`, e.g. paint over a
   * plaster relief, or a fabric weave in another colour. Default true: `color` tints the photo.
   */
  pbrColor?: boolean;
  /** Strength of the normal map. Default 1. */
  normalScale?: number;
  /** Cloth sheen (0..1): the soft rim light velvet, wool and linen catch at grazing angles. */
  sheen?: number;
  sheenColor?: string;
  sheenRoughness?: number;
  /** Clear lacquer layer (0..1) over the base: varnished floors, ceramic, lacquered fronts. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Specular strength for dielectrics (0..1, default 0.5): lower for matte paint and plaster. */
  specularIntensity?: number;
  /** Image texture path relative to the plan folder. Overrides `pattern`. */
  texture?: string;
  /** Size in meters that one texture repeat covers. */
  scale?: number;
  /** Plank or tile size in meters, for procedural patterns. */
  module?: [number, number];
  /** Grout or seam color for tiles and planks. */
  seam?: string;
  opacity?: number;
  emissive?: string;
}

export interface CameraDef {
  id: string;
  level?: string;
  room?: string;
  position: Vec2;
  /** Eye height in meters. Default 1.6. */
  height?: number;
  lookAt: Vec2;
  lookAtHeight?: number;
  /** Vertical field of view in degrees. Match it to the reference photo lens. Default 60. */
  fov?: number;
  /** Reference photo path relative to the plan folder. */
  photo?: string;
  note?: string;
}

export function withDefaults(plan: Plan): PlanDefaults {
  return { ...DEFAULTS, ...plan.defaults };
}
