/// <reference path="./three-usd.d.ts" />
import { Document, Logger, NodeIO, type Material, type Texture, type TextureInfo } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureTransform } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, simplify, weld } from "@gltf-transform/functions";
import { zipSync } from "fflate";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import path from "node:path";
import * as THREE from "three";
import { USDLoader } from "three/examples/jsm/loaders/USDLoader.js";
import { USDComposer } from "three/examples/jsm/loaders/usd/USDComposer.js";

/**
 * Converts OpenUSD assets, such as NVIDIA SimReady props, into the binary glTF the viewer loads.
 * three.js composes the layers into meshes; the materials come from the layers' UsdPreviewSurface
 * shaders, read here, because three's composer cannot load textures without a browser.
 */

/** A USD asset as files: layer text or crate bytes by path relative to the asset folder. */
export interface UsdAsset {
  /** The layer that composes the asset. */
  root: string;
  layers: Map<string, Uint8Array>;
  /** Image bytes for a texture a material names, by path relative to the asset folder. Undefined leaves that map out. */
  texture(file: string): Promise<Uint8Array | undefined>;
}

export interface ConvertedModel {
  glb: Uint8Array;
  /** [width, depth, height] in metres, front facing +z. */
  size: [number, number, number];
  triangles: number;
}

/**
 * A texture a UsdPreviewSurface input reads, how many times it repeats across the UV square, and
 * the colour USD gives it when the file is missing.
 */
interface TextureInput { file: string; scale: [number, number]; fallback?: [number, number, number] }
/** The finish of one USD material, as the glTF metallic-roughness model takes it. */
interface UsdFinish {
  color?: [number, number, number];
  colorMap?: TextureInput;
  roughness?: number;
  metallic?: number;
  /** Occlusion in red, roughness in green and metalness in blue, which is glTF's own packing. */
  ormMap?: TextureInput;
  normalMap?: TextureInput;
  opacity?: number;
}

const MAX_TRIANGLES = 40_000;

/**
 * USDA as three.js 0.186 can read it. Its parser reads a property declared without a value but with
 * metadata, such as `token outputs:surface (\n displayGroup = "Outputs"\n)`, as a dictionary and
 * loses its place, so that metadata goes. It only builds prims from `def`, so an `over`, where
 * SimReady binds materials, becomes a typeless `def` of the same name, and it only reads plain
 * `rel` relationships, so list edits such as `prepend rel` become plain ones.
 */
export function readableUsda(text: string) {
  return text
    .replace(/^([ \t]*(?!def |over |class )[\w:[\]]+[ \t]+[\w:.]+)[ \t]*\(\n(?:[^()\n]*\n)*?[ \t]*\)[ \t]*$/gm, "$1")
    .replace(/^([ \t]*)over (?=")/gm, "$1def ")
    // Relationships read only as `rel name = <target>`: no list edits, no bare declarations.
    .replace(/^[ \t]*custom rel [^=\n]*\n/gm, "")
    .replace(/^([ \t]*)(?:prepend |append |custom )rel /gm, "$1rel ");
}

const isCrate = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, 8)) === "PXR-USDC";

/** The body of the block that opens after `from`, between its braces, skipping a `( ... )` metadata block first. */
function blockAfter(text: string, from: number) {
  let depth = 0, i = from;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "{" && depth === 0) break;
  }
  const start = i + 1;
  for (depth = 1, i = start; i < text.length && depth; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
  }
  return text.slice(start, i - 1);
}

function definitions(text: string, kind: string) {
  const out = new Map<string, string>();
  for (const match of text.matchAll(new RegExp(`def ${kind} "([^"]+)"`, "g"))) out.set(match[1]!, blockAfter(text, match.index! + match[0].length));
  return out;
}

const numbers = (value: string) => value.split(",").map((part) => Number(part.trim()));

/** The finishes of every UsdPreviewSurface material in a text layer, by material name. */
export function usdFinishes(text: string, layer: string): Map<string, UsdFinish> {
  const finishes = new Map<string, UsdFinish>();
  for (const [name, body] of definitions(text, "Material")) {
    const shaders = definitions(body, "Shader");
    const id = (shader: string) => /info:id = "([^"]+)"/.exec(shaders.get(shader) ?? "")?.[1];
    const surface = [...shaders.keys()].find((shader) => id(shader) === "UsdPreviewSurface");
    if (!surface) continue;
    const inputs = shaders.get(surface)!;
    const constant = (input: string) => new RegExp(`inputs:${input} = \\(?([^)\\n]+)\\)?\\s*$`, "m").exec(inputs)?.[1];
    const connection = (input: string) => {
      const match = new RegExp(`inputs:${input}\\.connect = <[^>]*/([^/>.]+)\\.outputs:(\\w+)>`).exec(inputs);
      return match ? { shader: match[1]!, output: match[2]! } : undefined;
    };
    const textureOf = (shader: string): TextureInput | undefined => {
      const source = shaders.get(shader);
      const file = source && /inputs:file = @([^@]+)@/.exec(source)?.[1];
      if (!file || id(shader) !== "UsdUVTexture") return undefined;
      const transform = /inputs:st\.connect = <[^>]*\/([^/>.]+)\.outputs/.exec(source)?.[1];
      const scale = transform && /inputs:scale = \(([^)]+)\)/.exec(shaders.get(transform) ?? "")?.[1];
      const [sx = 1, sy = 1] = scale ? numbers(scale) : [];
      const fallback = /inputs:fallback = \(([^)]+)\)/.exec(source)?.[1];
      return { file: path.posix.normalize(path.posix.join(path.posix.dirname(layer), file)), scale: [sx || 1, sy || 1], ...(fallback && { fallback: numbers(fallback).slice(0, 3) as [number, number, number] }) };
    };
    const finish: UsdFinish = {};
    const color = connection("diffuseColor");
    if (color) finish.colorMap = textureOf(color.shader);
    else if (constant("diffuseColor")) finish.color = numbers(constant("diffuseColor")!).slice(0, 3) as [number, number, number];
    for (const channel of ["roughness", "metallic"] as const) {
      const link = connection(channel);
      if (link) finish.ormMap ??= textureOf(link.shader);
      else if (constant(channel)) finish[channel] = Number(constant(channel));
    }
    const normal = connection("normal");
    if (normal) finish.normalMap = textureOf(normal.shader);
    if (constant("opacity")) finish.opacity = Number(constant("opacity"));
    finishes.set(name, finish);
  }
  return finishes;
}

/** Runs three's USD parser without its notes about scalar types and textures it skips. */
function quietly<T>(run: () => T): T {
  const { warn, log } = console;
  console.warn = console.log = () => undefined;
  try {
    return run();
  } finally {
    Object.assign(console, { warn, log });
  }
}

// three's composer forgets which USD material each three.js material came from, so keep it as the
// name. It also misses bindings authored on subsets inside a referenced layer, as SimReady's are;
// their exporter names each subset after its material, so an unbound subset falls back to its name.
const composer = USDComposer.prototype as unknown as {
  _applyMaterial(material: THREE.Material, materialPath: string): void;
  _getGeomSubsets(meshPath: string): { name: string; materialPath: string | null }[];
  _resolveReference(reference: string, variants?: Record<string, string>): THREE.Group | null;
  _applyMaterialBinding(mesh: THREE.Mesh, primPath: string): void;
  _getMaterialBindingTarget(primPath: string): string | null;
  specsByPath: Record<string, { fields?: { targetPaths?: unknown[] } } | undefined>;
};
// A reference to a nested prim, such as `@./geometries.usd@</Geometries/leg_mesh>`, only finds its
// target among the referenced layer's top prims, and otherwise brings the whole layer. SimReady
// props reference each part this way, so every part would carry every mesh. Follow the full path.
const resolveReference = composer._resolveReference;
composer._resolveReference = function (reference, variants) {
  const group = resolveReference.call(this, reference, variants);
  const parts = /@[^@]+@<([^>]+)>/.exec(reference)?.[1]?.split("/").filter(Boolean) ?? [];
  const name = parts.at(-1);
  if (!group || !name || (group.children.length === 1 && group.children[0]!.name === name)) return group;
  let node: THREE.Object3D = group;
  for (const part of parts) node = node.children.find((child) => child.name === part) ?? node;
  if (node === group || node.name !== name) return group;
  node.removeFromParent();
  return new THREE.Group().add(node);
};
// A prim that references a single mesh takes that mesh in its own place, and keeps a binding only
// when the prim itself has one. SimReady binds the mesh's own override one level down instead.
const applyMaterialBinding = composer._applyMaterialBinding;
composer._applyMaterialBinding = function (mesh, primPath) {
  if (this._getMaterialBindingTarget(primPath) || Array.isArray(mesh.material)) return applyMaterialBinding.call(this, mesh, primPath);
  const depth = primPath.split("/").length + 1;
  const binding = Object.keys(this.specsByPath).find((spec) => spec.startsWith(`${primPath}/`) && spec.endsWith(".material:binding") && spec.split("/").length === depth && this.specsByPath[spec]?.fields?.targetPaths?.length);
  if (!binding) return;
  const material = new THREE.MeshPhysicalMaterial();
  this._applyMaterial(material, String(this.specsByPath[binding]!.fields!.targetPaths![0]).replace(/^<|>$/g, ""));
  mesh.material = material;
};
const applyMaterial = composer._applyMaterial;
composer._applyMaterial = function (material, materialPath) {
  material.name = String(materialPath).split("/").pop() ?? "";
  return applyMaterial.call(this, material, materialPath);
};
const geomSubsets = composer._getGeomSubsets;
composer._getGeomSubsets = function (meshPath) {
  return geomSubsets.call(this, meshPath).map((subset) => ({ ...subset, materialPath: subset.materialPath ?? subset.name }));
};

/**
 * A binary glTF of the asset at real size with its front facing +z. `turn` is
 * the clockwise turn in degrees, seen from above, that brings the asset's own front to +z:
 * SimReady props face +x, so they take 90. Dense meshes are simplified to about 40,000 triangles.
 */
export async function convertUsdAsset(asset: UsdAsset, { turn = 0, maxTriangles = MAX_TRIANGLES } = {}): Promise<ConvertedModel> {
  const files: Record<string, Uint8Array> = {};
  const text = new Map<string, string>();
  // The archive's first entry is the layer that composes the rest.
  for (const name of [asset.root, ...[...asset.layers.keys()].filter((name) => name !== asset.root)]) {
    const bytes = asset.layers.get(name)!;
    if (isCrate(bytes)) files[name] = bytes;
    else {
      const readable = readableUsda(new TextDecoder().decode(bytes));
      text.set(name, readable);
      files[name] = new TextEncoder().encode(readable);
    }
  }
  const archive = zipSync(files, { level: 0 });
  const group = quietly(() => new USDLoader().parse(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength) as ArrayBuffer));
  // The loader stands a Z-up asset upright with the group's own rotation; turn around that.
  const turned = new THREE.Group().add(group);
  turned.rotation.y = -THREE.MathUtils.degToRad(turn);
  turned.updateMatrixWorld(true);

  const finishes = new Map<string, UsdFinish>();
  for (const [layer, source] of text) for (const [name, finish] of usdFinishes(source, layer)) finishes.set(name, finish);

  const document = new Document();
  document.setLogger(new Logger(Logger.Verbosity.ERROR));
  const buffer = document.createBuffer();
  const scene = document.createScene();
  const transform = document.createExtension(KHRTextureTransform);
  const textures = new Map<string, Promise<Texture | null>>();
  const textureFor = (input: TextureInput) => {
    if (!textures.has(input.file))
      textures.set(input.file, asset.texture(input.file).then((image) => image ? document.createTexture(path.posix.basename(input.file)).setImage(image).setMimeType(image[0] === 0xff && image[1] === 0xd8 ? "image/jpeg" : "image/png") : null));
    return textures.get(input.file)!;
  };
  // USD's texture origin is the bottom left and glTF's the top left: flipped v, so a repeat scales from the bottom.
  const repeat = (info: TextureInfo | null, input: TextureInput) => {
    if (info && (input.scale[0] !== 1 || input.scale[1] !== 1)) info.setExtension("KHR_texture_transform", transform.createTransform().setScale(input.scale).setOffset([0, 1 - input.scale[1]]));
  };
  const materials = new Map<THREE.Material, Promise<Material>>();
  const materialFor = (source: THREE.Material) => {
    if (!materials.has(source)) materials.set(source, (async () => {
      const finish = finishes.get(source.name);
      const material = document.createMaterial(source.name || "material");
      if (!finish) {
        // No preview surface to read: keep what three's composer made of the display color.
        const standard = source as THREE.MeshStandardMaterial;
        if (standard.color) material.setBaseColorFactor([standard.color.r, standard.color.g, standard.color.b, standard.opacity ?? 1]);
        return material.setRoughnessFactor(standard.roughness ?? 0.6).setMetallicFactor(standard.metalness ?? 0);
      }
      const opacity = finish.opacity ?? 1;
      material.setBaseColorFactor([...(finish.color ?? [1, 1, 1]), opacity]).setRoughnessFactor(finish.roughness ?? 1).setMetallicFactor(finish.metallic ?? 0);
      if (opacity < 1) material.setAlphaMode("BLEND");
      const [color, orm, normal] = await Promise.all([finish.colorMap && textureFor(finish.colorMap), finish.ormMap && textureFor(finish.ormMap), finish.normalMap && textureFor(finish.normalMap)]);
      if (color) repeat(material.setBaseColorTexture(color).getBaseColorTextureInfo(), finish.colorMap!);
      // A colour map left out keeps the texture's own fallback, or a neutral grey, never plain white.
      else if (finish.colorMap) material.setBaseColorFactor([...(finish.colorMap.fallback ?? [0.5, 0.5, 0.5]), opacity]);
      if (orm) {
        // A channel the texture drives takes its full value from it.
        if (finish.roughness === undefined) material.setRoughnessFactor(1);
        if (finish.metallic === undefined) material.setMetallicFactor(1);
        repeat(material.setMetallicRoughnessTexture(orm).getMetallicRoughnessTextureInfo(), finish.ormMap!);
        repeat(material.setOcclusionTexture(orm).getOcclusionTextureInfo(), finish.ormMap!);
      }
      if (normal) repeat(material.setNormalTexture(normal).getNormalTextureInfo(), finish.normalMap!);
      return material;
    })());
    return materials.get(source)!;
  };

  const meshes: THREE.Mesh[] = [];
  turned.traverse((object) => {
    if ((object as THREE.Mesh).isMesh && object.visible) meshes.push(object as THREE.Mesh);
  });
  if (!meshes.length) throw new Error("The USD asset composed no meshes.");
  const bounds = new THREE.Box3();
  let triangles = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    bounds.expandByObject(new THREE.Mesh(geometry));
    const attributes = geometry.attributes as Record<string, THREE.BufferAttribute | undefined>;
    const vertices = attributes.position!;
    const accessor = (array: Float32Array<ArrayBuffer>, type: "VEC2" | "VEC3") => document.createAccessor().setArray(array).setType(type).setBuffer(buffer);
    const position = accessor(Float32Array.from(vertices.array as ArrayLike<number>), "VEC3");
    const normal = attributes.normal && accessor(Float32Array.from(attributes.normal.array as ArrayLike<number>), "VEC3");
    const uv = attributes.uv && accessor(Float32Array.from(attributes.uv.array as ArrayLike<number>, (value, i) => (i % 2 ? 1 - value : value)), "VEC2");
    const index = geometry.index?.array;
    const count = index ? index.length : vertices.count;
    const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count, materialIndex: 0 }];
    const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const gltfMesh = document.createMesh(mesh.name);
    for (const part of groups) {
      const end = Math.min(part.start + part.count, count);
      if (end <= part.start) continue;
      const indices = new Uint32Array(end - part.start);
      for (let i = part.start; i < end; i++) indices[i - part.start] = index ? index[i]! : i;
      triangles += indices.length / 3;
      const primitive = document.createPrimitive().setAttribute("POSITION", position).setIndices(document.createAccessor().setArray(indices).setType("SCALAR").setBuffer(buffer));
      if (normal) primitive.setAttribute("NORMAL", normal);
      if (uv) primitive.setAttribute("TEXCOORD_0", uv);
      primitive.setMaterial(await materialFor(sources[part.materialIndex ?? 0] ?? sources[0]!));
      gltfMesh.addPrimitive(primitive);
    }
    scene.addChild(document.createNode(mesh.name).setMesh(gltfMesh));
  }

  await MeshoptEncoder.ready;
  await MeshoptSimplifier.ready;
  await document.transform(dedup(), weld());
  if (triangles > maxTriangles) await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: maxTriangles / triangles, error: 0.002 }));
  await document.transform(prune(), meshopt({ encoder: MeshoptEncoder, level: "medium" }));
  const io = new NodeIO().setLogger(new Logger(Logger.Verbosity.ERROR)).registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });
  const glb = await io.writeBinary(document);
  const size = bounds.getSize(new THREE.Vector3());
  const round = (value: number) => Math.round(value * 1000) / 1000;
  const left = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives()).reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
  return { glb, size: [round(size.x), round(size.z), round(size.y)], triangles: Math.round(left) };
}
