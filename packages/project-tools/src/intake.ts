import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { continuationBriefSchema, projectFactsSchema, projectIntakeSchema, projectKindSchema, projectManifestSchema, referenceExtensions, viewerProjectManifestSchema, type ProjectFacts, type ProjectKind } from "@arch/project";
import { isFolderLitter, listProjects, projectBranches, registerProject, saveBranchCheckpoint, saveCheckpoint } from "./index.ts";
import { builderRules, projectRules } from "./rules.ts";

export type ProjectIntake = {
  /** Omit to start without references; add them later with addReferences. */
  inputsDirectory?: string;
  directory: string;
  id: string;
  name: string;
  /** Omit for Studio's local client. */
  client?: { id: string; name: string };
  description?: string;
  /** What the user confirmed when creating the project. */
  facts?: ProjectFacts;
};

const localClient = { id: "local", name: "Local" };
const supported = new Set<string>(referenceExtensions);
const supportedTypes = "PDF, PNG, JPEG, WebP, SVG, text, Markdown, JSON, or DXF, CSV and GeoJSON survey data";
const privateName = /(^\.|(?:^|[._-])(?:secrets?|credentials?|tokens?|private[-_]?key)(?:[._-]|$)|^id_(?:rsa|ed25519|ecdsa)(?:\.|$)|\.(?:pem|key|p12|pfx)$)/i;
const maximumFileBytes = 100 * 1024 * 1024;
const maximumInputBytes = 500 * 1024 * 1024;

function contains(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function requirePlainDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory)
    throw new Error("Use an existing directory without symlinks or symlink parents.");
}

async function inputFiles(directory: string) {
  const files: { relative: string; size: number; mtimeMs: number; ino: number; dev: number }[] = [];
  let bytes = 0;
  let entries = 0;
  async function walk(relative = "", depth = 0): Promise<void> {
    if (depth > 16) throw new Error("Input folders exceed the 16-level nesting limit.");
    for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (isFolderLitter(entry.name)) continue;
      if (++entries > 1000) throw new Error("Input folders exceed the 1000-entry limit.");
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (privateName.test(entry.name) || entry.name === "node_modules" || entry.name.includes("\\"))
        throw new Error(`Private, hidden or unsupported input path: ${name}`);
      if (entry.isSymbolicLink()) throw new Error(`Symlink input rejected: ${name}`);
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile()) {
        if (!supported.has(path.extname(entry.name).toLowerCase()))
          throw new Error(`Unsupported reference file: ${name}. Use ${supportedTypes}.`);
        const stat = await fs.lstat(path.join(directory, name));
        bytes += stat.size;
        if (stat.size > maximumFileBytes || bytes > maximumInputBytes)
          throw new Error("References exceed the 100 MiB per-file or 500 MiB total limit.");
        files.push({ relative: name, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
        if (files.length > 100) throw new Error("A project accepts at most 100 reference files.");
      } else throw new Error(`Nonregular input rejected: ${name}`);
    }
  }
  await walk();
  if (!files.length) throw new Error("The input folder contains no supported reference files.");
  return files;
}

const generator = `// Run explicitly through Arch's local artifact builder after reviewing this source.
import { promises as fs } from 'node:fs';
import path from 'node:path';
const output = process.env.ARCH_ARTIFACT_OUTPUT;
if (!output) throw new Error('Run through the explicit Arch artifact builder.');
try { await fs.access('assets/plan.json'); }
catch { throw new Error('Project needs authoring: inspect reference/ and BUILDERS.md, resolve consequential geometry assumptions, then create assets/plan.json. No render exists yet.'); }
async function copyAssets(relative = '') {
  for (const entry of await fs.readdir(path.join('assets', relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (name === 'plan.json') continue;
    // Folder litter from macOS and Windows never ships.
    if (/^(\\.DS_Store|\\._.*|thumbs\\.db|desktop\\.ini)$/i.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error('Asset symlinks are not supported.');
    if (entry.isDirectory()) await copyAssets(name);
    else if (entry.isFile()) {
      await fs.mkdir(path.dirname(path.join(output, name)), { recursive: true });
      await fs.copyFile(path.join('assets', name), path.join(output, name));
    } else throw new Error('Assets must be regular files.');
  }
}
await copyAssets();
await fs.copyFile('assets/plan.json', path.join(output, 'plan.json'));
`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Earlier stock rules, by SHA-256. A project still holding one of these exact files has not customized it. */
const retiredRules: Record<"AGENTS.md" | "BUILDERS.md", string[]> = {
  "AGENTS.md": [
    "c5c0437469132ed01da9e491133dd28a2a8c4744b5496c851d532042c959484c",
    "677dd7b4ce1ca33eff3b4f9c5b11c5c3dde329229f50429b19f45fc4dc3b0ca0",
    // Before project facts and the dependency rule.
    "738d9ddfaee2eef9390572d43bc1c708e72b0af78aeeb53e48ea51a034f2c895",
  ],
  "BUILDERS.md": [
    "772a7e94099515f022537ac5aa642b9e5eaab35f23e1401d6c7c9e9a7dc36d1d",
    "554f5203f62346647d082e0c3c5ea25e565a16da1295dd7dc4c946f8062251d3",
    "f720682fc56521b5525573537d168ed4cf1c30bc92673ebf1012c98bb4177779",
    // One floor plane per artifact, before storeys and stairs.
    "5804284a5cfcbbd089ace84387ac5d9fe50d3a55130cad714749d389c9a792db",
    // Storeys and stairs, before roofs and sloped ceilings.
    "4b5994b35e6529094cbf6f91bd94b8adf7863f58c894d2244d4e77178d41dc49",
    // Roofs and sloped ceilings, before design options.
    "d342cd169fd952eb5f4bb96f99f6256dcfa62f81da6a119d48531fc791bfbdff",
    // Design options, before hand edits.
    "150ba6adfd66a742d95dac9b30e75160cf37ace45093d4635f26729b92e33e82",
    // Hand edits, before performance budgets.
    "1e648fd212382aa854239eedda24abb79b6f18ccca5840566e3a905db929b77a",
    // Performance budgets, before the build compressed models itself.
    "3621b651a526b4150f84853d0f6068bd5d1d26fa51f11e9f8077bc7771ef5f22",
    // Model compression, before the asset catalog and its MCP tools.
    "9c166e2c568ab0bef3622d0768f85b7a32a4a2d85ddf1b7ff9a6e3609d31ec40",
    // The asset catalog, before project kinds, facts and the dependency rule.
    "35418ebaea6e295a847f2d50833a9d20df90ab570ce8c87bca97e8663687a4f2",
  ],
};
/** Today's stock BUILDERS.md for every kind, so a stock file follows a changed kind. */
const stockBuilderRules = () => new Set([undefined, ...projectKindSchema.options].map(kind => sha256(builderRules(kind))));

/** The kind a project folder's manifest confirms. A missing or unreadable manifest confirms none. */
async function confirmedKind(directory: string): Promise<ProjectKind | undefined> {
  const file = path.join(directory, "arch.project.json");
  if (!(await fs.lstat(file).catch(() => null))?.isFile()) return undefined;
  try {
    const manifest = projectManifestSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
    return manifest.schemaVersion === 2 ? manifest.facts?.kind : undefined;
  } catch { return undefined; }
}

const outdoorKinds = new Set<ProjectKind>(["public-space", "landscape", "site"]);
/** The seeded geometry review, less what the facts already confirm. */
function geometryReview(facts: ProjectFacts | undefined): string {
  const parts = facts?.kind && outdoorKinds.has(facts.kind)
    ? ["Survey units", "scale", "site extents", "ground levels"]
    : ["Plan units", "scale", ...(facts?.storeyHeight === undefined ? ["ceiling heights"] : []), "openings"];
  if (facts?.north === undefined) parts.push("orientation");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)} require input review before authoring.`;
}

/**
 * Brings a project's stock rules up to date. Only files identical to an earlier stock version, or
 * to today's stock rules for another kind, are replaced; edited rules stay as the project wrote
 * them. Returns the files it replaced.
 */
export async function refreshProjectRules(directory: string) {
  const current = { "AGENTS.md": projectRules, "BUILDERS.md": builderRules(await confirmedKind(directory)) };
  const stock = { "AGENTS.md": new Set(retiredRules["AGENTS.md"]), "BUILDERS.md": new Set([...retiredRules["BUILDERS.md"], ...stockBuilderRules()]) };
  const replaced: string[] = [];
  for (const name of ["AGENTS.md", "BUILDERS.md"] as const) {
    const file = path.join(directory, name);
    // Rules are plain files in the project; never follow a link out of it.
    if (!(await fs.lstat(file).catch(() => null))?.isFile()) continue;
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === null || text === current[name]) continue;
    if (!stock[name].has(sha256(text))) continue;
    await fs.writeFile(file, current[name]);
    replaced.push(name);
  }
  return replaced;
}

/** Copy customer references into a new authoring source. Never executes those inputs. */
export async function initializeProject(options: ProjectIntake) {
  const inputsDirectory = options.inputsDirectory === undefined ? null : path.resolve(options.inputsDirectory);
  const directory = path.resolve(options.directory);
  if (inputsDirectory) await requirePlainDirectory(inputsDirectory);
  await requirePlainDirectory(path.dirname(directory));
  if (inputsDirectory && (contains(inputsDirectory, directory) || contains(directory, inputsDirectory)))
    throw new Error("Input and project folders must be separate and must not overlap.");
  const files = inputsDirectory ? await inputFiles(inputsDirectory) : [];
  const client = options.client ?? localClient;
  const facts = options.facts === undefined ? undefined : projectFactsSchema.parse(options.facts);
  const manifest = viewerProjectManifestSchema.parse({
    schemaVersion: 2, id: options.id, name: options.name, client, ...(facts && Object.keys(facts).length ? { facts } : {}),
    description: options.description ?? "", entry: "source/generate.ts",
    runtime: { name: "arch-viewer", version: "0.1.0", threeVersion: "0.186.1" },
    views: [], artifacts: [],
    assumptions: [{ id: "geometry-review", description: geometryReview(facts), status: "unconfirmed" }, { id: "style-review", description: "Customer style references and required outputs require input review before authoring.", status: "unconfirmed" }],
    references: files.map(file => ({ path: `reference/${file.relative}`, label: file.relative.slice(0, 160), kind: "other" })),
  });
  const brief = continuationBriefSchema.parse({
    goal: `Prepare ${options.name} for ${client.name} from the supplied references.`, driver: "Unassigned",
    decisions: ["Customer references are preserved unchanged under reference/.", "Use the pinned Arch viewer and project-local source and assets.", "Source initialized only. No model, render, acceptance or publication exists.", ...(manifest.facts ? ["The facts in arch.project.json are confirmed by the user."] : [])],
    unresolved: manifest.assumptions.map(assumption => assumption.description),
    nextAction: "Read AGENTS.md, BUILDERS.md and every listed reference. Write the geometry and style brief, record missing dimensions, and ask about consequential gaps before authoring assets/plan.json. Studio attaches projects it creates; attach a CLI-created source to the matching client project in Studio before building a version.",
    instructionVersion: "arch-intake-3",
  });
  const intake = projectIntakeSchema.parse({
    version: 1, brief: manifest.description || manifest.name, style: "",
    documents: manifest.references.map((reference, index) => ({
      id: `doc-${index + 1}`, path: reference.path, page: 1, label: reference.label, role: "unresolved",
    })),
    pieces: [],
  });
  if ((await listProjects()).some(project => project.manifest.id === manifest.id))
    throw new Error("Project ID already registered. Continue its current source instead of initializing it again.");
  await fs.mkdir(directory); // Exclusive claim: an existing folder, even empty, is never reused.
  let registered = false;
  try {
    await fs.mkdir(path.join(directory, "source"));
    await fs.mkdir(path.join(directory, "assets/library"), { recursive: true });
    for (const file of files) {
      const original = path.join(inputsDirectory!, file.relative);
      if (await fs.realpath(original) !== original) throw new Error("Input path changed or contains symlinks. Retry after inputs are stable.");
      const handle = await fs.open(original, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs || stat.ino !== file.ino || stat.dev !== file.dev)
          throw new Error("Input changed during initialization. Retry after inputs are stable.");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (bytes.length !== file.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size)
          throw new Error("Input changed during initialization. Retry after inputs are stable.");
        const destination = path.join(directory, "reference", file.relative);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes, { flag: "wx" });
      } finally { await handle.close(); }
    }
    const dependencies = { three: "0.186.1" };
    for (const [name, content] of Object.entries({
      "arch.project.json": json(manifest), "arch.context.json": json(brief),
      "AGENTS.md": projectRules, "CLAUDE.md": "@AGENTS.md\n", "BUILDERS.md": builderRules(manifest.facts?.kind),
      "source/generate.ts": generator,
      "source/intake.json": json(intake),
      "assets/library/index.json": json({ version: 2, textures: {}, models: {}, hdris: {} }),
      "package.json": json({ name: manifest.id, private: true, type: "module", dependencies }),
      "package-lock.json": json({ name: manifest.id, lockfileVersion: 3, packages: { "": { dependencies }, "node_modules/three": { version: "0.186.1", resolved: "https://registry.npmjs.org/three/-/three-0.186.1.tgz", integrity: "sha512-blFeqb49wRCSGUGj7gtpfnSGHy2lwDk94RhUmS1c/hTby70kvChbWpkJ4Pm1390LqzzvTmzgXKHPEafJwCb8jA==" } } }),
    })) await fs.writeFile(path.join(directory, name), content, { flag: "wx" });
    await registerProject(directory);
    registered = true;
    const checkpoint = await saveCheckpoint(manifest.id);
    return { project: (await listProjects()).find(project => project.manifest.id === manifest.id)!, checkpoint };
  } catch (error) {
    if (!registered) await fs.rm(directory, { recursive: true, force: true });
    else throw new Error(`Source was registered at ${directory}, but initialization did not finish. Preserve this folder. In Studio choose Existing folder, then Open this path to attach it. Run arch continue on this folder to retry the checkpoint and read its current brief.`, { cause: error });
    throw error;
  }
}

async function branchFolder(projectId: string, branch: string) {
  const line = (await projectBranches(projectId)).branches.find(item => item.name === branch);
  if (!line) throw new Error("Unknown branch");
  return line.directory;
}

/**
 * Add references to a branch folder after creation. Bytes are stored unchanged and
 * listed as unresolved intake documents, then the branch saves a version. When anything
 * fails, including that save, the folder is left as it was.
 */
export async function addReferences(projectId: string, branch: string, files: { name: string; data: Uint8Array }[]) {
  if (!files.length) throw new Error("Choose at least one file.");
  const directory = await branchFolder(projectId, branch);
  const manifestPath = path.join(directory, "arch.project.json");
  const manifestText = await fs.readFile(manifestPath, "utf8");
  const manifest = viewerProjectManifestSchema.parse(JSON.parse(manifestText));
  const intakePath = path.join(directory, "source/intake.json");
  let intake: ReturnType<typeof projectIntakeSchema.parse> | null = null;
  let intakeText: string | null = null;
  try { intakeText = await fs.readFile(intakePath, "utf8"); intake = projectIntakeSchema.parse(JSON.parse(intakeText)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Fix source/intake.json before adding files.", { cause: error }); }
  let bytes = 0;
  for (const reference of manifest.references) bytes += (await fs.stat(path.join(directory, reference.path))).size;
  const taken = new Set(manifest.references.map(reference => reference.path.toLowerCase()));
  const referenceDirectory = path.join(directory, "reference");
  const hadReferenceDirectory = await fs.lstat(referenceDirectory).then(() => true, () => false);
  const written: string[] = [];
  try {
    for (const file of files) {
      const base = path.basename(file.name).replace(/[\\/]/g, "_");
      if (!base || privateName.test(base) || base === "node_modules") throw new Error(`Private, hidden or unsupported file name: ${base}`);
      const extension = path.extname(base).toLowerCase();
      if (!supported.has(extension)) throw new Error(`Unsupported reference file: ${base}. Use ${supportedTypes}.`);
      bytes += file.data.byteLength;
      if (file.data.byteLength > maximumFileBytes || bytes > maximumInputBytes) throw new Error("References exceed the 100 MiB per-file or 500 MiB total limit.");
      if (manifest.references.length >= 100) throw new Error("A project accepts at most 100 reference files.");
      const stem = base.slice(0, base.length - extension.length);
      let name = base;
      for (let copy = 2; taken.has(`reference/${name}`.toLowerCase()); copy++) name = `${stem} ${copy}${path.extname(base)}`;
      const relative = `reference/${name}`;
      taken.add(relative.toLowerCase());
      await fs.mkdir(referenceDirectory, { recursive: true });
      await fs.writeFile(path.join(directory, relative), file.data, { flag: "wx" });
      written.push(relative);
      manifest.references.push({ path: relative, label: name.slice(0, 160), kind: "other" });
      if (intake) {
        const ids = new Set(intake.documents.map(document => document.id));
        let index = intake.documents.length + 1;
        while (ids.has(`doc-${index}`)) index++;
        intake.documents.push({ id: `doc-${index}`, path: relative, page: 1, label: name.slice(0, 160), role: "unresolved" });
      }
    }
    await fs.writeFile(manifestPath, json(viewerProjectManifestSchema.parse(manifest)));
    if (intake) await fs.writeFile(intakePath, json(projectIntakeSchema.parse(intake)));
    // The save belongs to the change: a version that cannot be saved leaves no half-added files.
    return await saveBranchCheckpoint(projectId, branch);
  } catch (error) {
    for (const relative of written) await fs.rm(path.join(directory, relative), { force: true });
    if (!hadReferenceDirectory) await fs.rmdir(referenceDirectory).catch(() => {});
    await fs.writeFile(manifestPath, manifestText);
    if (intakeText !== null) await fs.writeFile(intakePath, intakeText);
    throw error;
  }
}

/**
 * Renames a branch's project and replaces the facts the user confirmed, then saves a version.
 * Empty facts remove them. A given description replaces the user's brief. Stock rules follow a
 * changed kind, and the seeded geometry review drops what the new facts confirm. When anything
 * fails, including that save, the folder is left as it was.
 */
export async function updateProjectFacts(projectId: string, branch: string, update: { name: string; facts: ProjectFacts; description?: string }) {
  const directory = await branchFolder(projectId, branch);
  const facts = projectFactsSchema.parse(update.facts);
  const manifestPath = path.join(directory, "arch.project.json");
  const contextPath = path.join(directory, "arch.context.json");
  const manifestText = await fs.readFile(manifestPath, "utf8");
  const contextText = await fs.readFile(contextPath, "utf8");
  const manifest = viewerProjectManifestSchema.parse(JSON.parse(manifestText));
  const context = continuationBriefSchema.parse(JSON.parse(contextText));
  const staleReview = geometryReview(manifest.facts);
  manifest.name = update.name;
  if (update.description !== undefined) manifest.description = update.description;
  if (Object.keys(facts).length) manifest.facts = facts;
  else delete manifest.facts;
  const freshReview = geometryReview(manifest.facts);
  for (const assumption of manifest.assumptions)
    if (assumption.id === "geometry-review" && assumption.status === "unconfirmed" && assumption.description === staleReview) assumption.description = freshReview;
  context.unresolved = context.unresolved.map(question => question === staleReview ? freshReview : question);
  const nextManifest = json(viewerProjectManifestSchema.parse(manifest));
  const nextContext = json(continuationBriefSchema.parse(context));
  const rules = new Map<string, string>();
  for (const name of ["AGENTS.md", "BUILDERS.md"]) {
    const file = path.join(directory, name);
    if ((await fs.lstat(file).catch(() => null))?.isFile()) rules.set(name, await fs.readFile(file, "utf8"));
  }
  try {
    await fs.writeFile(manifestPath, nextManifest);
    if (canonicalText(contextText) !== canonicalText(nextContext)) await fs.writeFile(contextPath, nextContext);
    await refreshProjectRules(directory);
    return await saveBranchCheckpoint(projectId, branch);
  } catch (error) {
    await fs.writeFile(manifestPath, manifestText);
    await fs.writeFile(contextPath, contextText);
    // refreshProjectRules only writes regular files, so these never follow a link.
    for (const [name, text] of rules) if ((await fs.lstat(path.join(directory, name)).catch(() => null))?.isFile()) await fs.writeFile(path.join(directory, name), text);
    throw error;
  }
}
const canonicalText = (text: string) => JSON.stringify(JSON.parse(text));

/**
 * Moves a project to another client: every branch's manifest names it, and each branch saves a
 * version. Studio's own catalog keeps its project's clientId and must change it in the same step.
 * When a save fails, every branch folder goes back to the old client, and branches already saved
 * save again so their heads name the old client too.
 */
export async function assignProjectClient(projectId: string, client: { id: string; name: string }) {
  const lines = (await projectBranches(projectId)).branches;
  const changed: { branch: string; file: string; text: string; saved: boolean }[] = [];
  try {
    for (const line of lines) {
      const file = path.join(line.directory, "arch.project.json");
      const text = await fs.readFile(file, "utf8");
      const manifest = viewerProjectManifestSchema.parse(JSON.parse(text));
      const next = json(viewerProjectManifestSchema.parse({ ...manifest, client }));
      changed.push({ branch: line.name, file, text, saved: false });
      await fs.writeFile(file, next);
    }
    const saved: { branch: string; checkpoint: Awaited<ReturnType<typeof saveBranchCheckpoint>> }[] = [];
    for (const entry of changed) {
      saved.push({ branch: entry.branch, checkpoint: await saveBranchCheckpoint(projectId, entry.branch) });
      entry.saved = true;
    }
    return saved;
  } catch (error) {
    for (const entry of changed) {
      await fs.writeFile(entry.file, entry.text);
      if (entry.saved) await saveBranchCheckpoint(projectId, entry.branch).catch(() => {});
    }
    throw error;
  }
}
