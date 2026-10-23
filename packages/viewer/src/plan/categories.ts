import type { FurnitureType } from './schema.ts';

/**
 * Kinds of piece a person looks for when furnishing a room. Plan pieces, library models and
 * catalog assets all sort into these, so one set of tabs finds a chair wherever it comes from.
 */
export const PIECE_CATEGORIES = ['seating', 'tables', 'storage', 'beds', 'lighting', 'kitchen', 'bathroom', 'appliances', 'decor', 'other'] as const;
export type PieceCategory = (typeof PIECE_CATEGORIES)[number];

export const FURNITURE_CATEGORY: Record<FurnitureType, PieceCategory> = {
  bed: 'beds', nightstand: 'beds', wardrobe: 'storage', dresser: 'storage',
  sofa: 'seating', armchair: 'seating', 'coffee-table': 'tables', 'tv-unit': 'storage', tv: 'appliances', rug: 'decor', bookshelf: 'storage', 'floor-lamp': 'lighting', plant: 'decor',
  'dining-table': 'tables', chair: 'seating', desk: 'tables', 'office-chair': 'seating',
  'kitchen-base': 'kitchen', 'kitchen-tall': 'kitchen', 'kitchen-wall': 'kitchen', island: 'kitchen', fridge: 'appliances', hob: 'kitchen', sink: 'kitchen',
  toilet: 'bathroom', basin: 'bathroom', vanity: 'bathroom', bathtub: 'bathroom', shower: 'bathroom', washer: 'appliances',
  stairs: 'other', box: 'other',
};

/** Words in an asset's name or class that place it, checked in this order so "table lamp" is lighting. */
const WORDS: [PieceCategory, RegExp][] = [
  ['lighting', /\b(lamp|light|lighting|chandelier|sconce|lantern|pendant)\b/],
  ['bathroom', /\b(toilet|basin|bathtub|bath|shower|bidet|vanity|towel|urinal)\b/],
  ['appliances', /\b(appliance|refrigerator|fridge|freezer|dishwasher|washer|dryer|oven|microwave|toaster|kettle|television|tv|monitor|computer|printer|extractor|fan|heater|radiator|air conditioner)\b/],
  ['kitchen', /\b(kitchen|sink|hob|stove|cooktop|cabinet kitchen|counter|countertop|island)\b/],
  ['beds', /\b(bed|beds|mattress|crib|cot|nightstand|bedside|bedding)\b/],
  ['seating', /\b(sofa|couch|chair|armchair|stool|bench|seat|ottoman|pouf|loveseat)\b/],
  ['tables', /\b(table|desk|counter top|workbench)\b/],
  ['storage', /\b(shelf|shelves|shelving|bookcase|bookshelf|cabinet|cupboard|wardrobe|closet|dresser|drawer|drawers|chest|sideboard|rack|locker|box|crate|bin|basket)\b/],
  ['decor', /\b(plant|flower|vase|rug|carpet|curtain|blinds|picture|frame|painting|mirror|clock|book|books|sculpture|pillow|cushion|decor|decoration|pot)\b/],
];

/**
 * The category words in a name or class suggest, such as "modern_arm_chair_01" or "couch".
 * Underscores, dashes and camel case split words; anything unrecognised is `other`.
 */
export function pieceCategory(...names: (string | null | undefined)[]): PieceCategory {
  const text = names
    .filter((name): name is string => !!name)
    .map((name) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-./]+/g, ' ').replace(/\barm chair\b/gi, 'armchair').toLowerCase())
    .join(' ');
  return WORDS.find(([, words]) => words.test(text))?.[0] ?? 'other';
}

/** Kinds of finish a person looks for when painting a surface by hand. */
export const MATERIAL_CATEGORIES = ['paint', 'wood', 'tiles', 'stone', 'plaster', 'brick', 'fabric', 'metal', 'outdoor', 'other'] as const;
export type MaterialCategory = (typeof MATERIAL_CATEGORIES)[number];

/** Words in a finish's name, pattern or source categories that place it, checked in this order. */
const MATERIAL_WORDS: [MaterialCategory, RegExp][] = [
  ['paint', /\b(paint|painted)\b/],
  ['tiles', /\b(tiles?|tiled|mosaic|ceramic|terrazzo|parquet tile)\b/],
  ['wood', /\b(wood|wooden|oak|walnut|pine|laminate|parquet|planks?|herringbone|veneer|bark)\b/],
  ['brick', /\b(brick|bricks)\b/],
  ['plaster', /\b(plaster|stucco|concrete|cement|render|plaster concrete)\b/],
  ['stone', /\b(stone|marble|granite|rock|slate|sandstone|limestone|travertine|cobblestone)\b/],
  ['fabric', /\b(fabric|linen|wool|velvet|velour|carpet|rug|leather|teddy|textile)\b/],
  ['metal', /\b(metal|steel|iron|aluminium|aluminum|copper|brass|rust)\b/],
  ['outdoor', /\b(grass|ground|gravel|asphalt|road|dirt|sand|snow|soil|terrain|roofing|moss|mud|leaves)\b/],
];

/** The category words in a finish's names suggest, such as "laminate_floor_02" or "plaster-concrete". */
export function materialCategory(...names: (string | null | undefined)[]): MaterialCategory {
  const text = names
    .filter((name): name is string => !!name)
    .map((name) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-./]+/g, ' ').toLowerCase())
    .join(' ');
  return MATERIAL_WORDS.find(([, words]) => words.test(text))?.[0] ?? 'other';
}
