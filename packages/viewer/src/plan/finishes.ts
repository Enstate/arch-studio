import type { MaterialDef } from './schema.ts';

/**
 * Built-in finishes used when a plan references a key it does not define.
 * Plans can override any of these in `plan.materials`.
 */
export const BUILTIN: Record<string, MaterialDef> = {
  'paint-white': { color: '#f2efe9', roughness: 0.92 },
  'render-white': { color: '#ece8e0', pattern: 'plaster', roughness: 0.95 },
  oak: { color: '#c49a6c', pattern: 'planks', module: [1.4, 0.19], seam: '#8a6440', roughness: 0.55 },
  'tile-grey': { color: '#bdb8b0', pattern: 'large-tiles', module: [0.6, 0.6], seam: '#9d978e', roughness: 0.4 },
  concrete: { color: '#b3afa8', pattern: 'concrete', roughness: 0.85 },
  carpet: { color: '#b9b1a4', pattern: 'carpet', roughness: 1 },
  fabric: { color: '#9a9a92', pattern: 'fabric', roughness: 0.95 },
  wood: { color: '#a7825c', roughness: 0.55 },
  'dark-wood': { color: '#5e3d27', roughness: 0.5 },
  white: { color: '#f3f1ec', roughness: 0.5 },
  ceramic: { color: '#f6f5f2', roughness: 0.12, clearcoat: 0.8, clearcoatRoughness: 0.04 },
  steel: { color: '#c9cbcc', roughness: 0.25, metalness: 1 },
  'black-steel': { color: '#1d1d1d', roughness: 0.4, metalness: 0.6 },
  chrome: { color: '#dadada', roughness: 0.15, metalness: 1 },
  glass: { color: '#e4eef0', roughness: 0.02, opacity: 0.07 },
  'frame-white': { color: '#f0eee9', roughness: 0.45 },
  'frame-anthracite': { color: '#383a3c', roughness: 0.45, metalness: 0.2 },
  'door-white': { color: '#f1efea', roughness: 0.5 },
  leaf: { color: '#4f6b3c', roughness: 0.8 },
  pot: { color: '#d8d2c8', roughness: 0.75 },
  screen: { color: '#0c0c0d', roughness: 0.15, metalness: 0.2 },
  ground: { color: '#a4a594', pattern: 'concrete', roughness: 1 },
  slab: { color: '#d8d4cc', roughness: 0.9 },
  skirting: { color: '#f4f2ee', roughness: 0.5 },
  'cushion-velvet': { color: '#9c5a3c', roughness: 1, sheen: 1, sheenRoughness: 0.35, sheenColor: '#e0a07a', specularIntensity: 0.1 },
  'cushion-linen': { color: '#d8d0c2', roughness: 1, sheen: 0.7, sheenRoughness: 0.6, specularIntensity: 0.12 },
  worktop: { color: '#2f2d2a', roughness: 0.28 },
  linen: { color: '#e8e2d7', pattern: 'fabric', roughness: 0.95 },
  bulb: { color: '#fff6e4', roughness: 1, emissive: '#fff1d6' },
};
