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
  walls: Wall[];
  openings?: Opening[];
  rooms?: Room[];
  furniture?: Furniture[];
  /** Named materials that rooms, walls and furniture can reference by key. */
  materials?: Record<string, MaterialDef>;
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

export interface Wall {
  id: string;
  /** Centerline start. */
  a: Vec2;
  /** Centerline end. */
  b: Vec2;
  thickness?: number;
  height?: number;
  exterior?: boolean;
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
  /** Door leaf angle in degrees, 0 = closed. Defaults to 75 so walk mode is not blocked. */
  openAngle?: number;
  frame?: string;
}

export interface Room {
  id: string;
  name: string;
  /** Closed polygon along the inside faces or wall centerlines. Do not repeat the first point. */
  polygon: Vec2[];
  floor?: string;
  ceiling?: string;
  wallFinish?: string;
  ceilingHeight?: number;
  /** Area printed on the plan in m², checked by the validator. */
  areaLabel?: number;
  /** Ceiling light color temperature in Kelvin. Omit for no ceiling light. */
  lightK?: number;
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
