import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { NON_FLOOR_MAX, type LibraryIndex } from './viewer/library.ts';
import { withDefaults, type Plan } from './plan/schema.ts';

/**
 * Serves the viewer's asset library with long cache lifetimes in dev (file URLs carry the library
 * version), and trims the copy in the build to what the shipped plans use, at the sizes the
 * runtime asks for. `base` is the library's URL path, e.g. "/viewer/library/".
 */
export function viewerAssets(base = '/viewer/library/', plansBase = '/viewer/plans/'): Plugin {
  return {
    name: 'arch-viewer-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith(base) && req.url.includes('?v=')) {
          const set = res.setHeader.bind(res);
          res.setHeader = (name, value) => (name.toLowerCase() === 'cache-control' ? res : set(name, value));
          set('Cache-Control', 'public, max-age=31536000, immutable');
        }
        next();
      });
    },
    writeBundle(output) {
      if (!output.dir) return;
      const lib = join(output.dir, base);
      const plansDir = join(output.dir, plansBase);
      if (!existsSync(join(lib, 'index.json')) || !existsSync(plansDir)) return;
      const index = JSON.parse(readFileSync(join(lib, 'index.json'), 'utf8')) as LibraryIndex;
      const keep = new Set(['index.json', 'CREDITS.md']);
      const textures: LibraryIndex['textures'] = {};
      const models: LibraryIndex['models'] = {};
      const hdris: LibraryIndex['hdris'] = {};
      for (const name of readdirSync(plansDir)) {
        const file = join(plansDir, name, 'plan.json');
        if (!existsSync(file)) continue;
        const plan = JSON.parse(readFileSync(file, 'utf8')) as Plan;
        const d = withDefaults(plan);
        const floors = new Set([d.floor, ...(plan.rooms ?? []).map((r) => r.floor ?? d.floor)]);
        for (const [key, def] of Object.entries(plan.materials ?? {})) {
          const meta = def.pbr ? index.textures[def.pbr] : undefined;
          if (!def.pbr || !meta) continue;
          const max = floors.has(key) ? Infinity : NON_FLOOR_MAX;
          const res = new Set([...(textures[def.pbr]?.res ?? []), ...meta.res.filter((r) => r <= max)]);
          if (!res.size) res.add(meta.res[0]);
          textures[def.pbr] = { ...meta, res: [...res].sort((a, b) => a - b) };
          for (const r of res) for (const m of meta.maps) keep.add(`textures/${def.pbr}/${r}/${m}.webp`);
        }
        for (const f of plan.furniture ?? []) {
          const id = f.model?.match(/^@lib\/models\/(.+)\.glb$/)?.[1];
          if (id && index.models[id]) {
            models[id] = index.models[id];
            keep.add(`models/${id}.glb`);
          }
        }
        const env = plan.environment ?? 'suburban_garden';
        if (index.hdris[env]) {
          hdris[env] = index.hdris[env];
          keep.add(`hdri/${env}.hdr`).add(`hdri/${env}-env.hdr`);
        }
      }
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
      for (const file of walk(lib)) if (!keep.has(relative(lib, file))) rmSync(file);
      const prune = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) prune(join(dir, e.name));
        if (dir !== lib && !readdirSync(dir).length) rmSync(dir, { recursive: true });
      };
      prune(lib);
      writeFileSync(join(lib, 'index.json'), `${JSON.stringify({ ...index, textures, models, hdris })}\n`);
    },
  };
}
