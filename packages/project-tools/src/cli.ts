#!/usr/bin/env bun
import {
  buildProjectArtifact,
  exportCheckpoint,
  importCheckpoint,
  registerProject,
  listProjects,
  saveCheckpoint,
  restoreCheckpoint,
  checkpointBrief,
  startPreview,
  stopPreviews,
} from "./index.ts";
import { initializeProject } from "./intake.ts";
const help = `Arch local project tools

Usage: bun run arch <command>
  init <inputs-folder> <new-folder> --id <project-id> --name <name>
       --client-id <workspace-slug> --client-name <name> [--description <brief>]
                                       Preserve references and start an unrendered source
  continue <project-directory>        Save current working context and print its brief
  build <project-id> --authorize-source-execution
                                       Execute reviewed source and save a validated artifact
  register <directory>                 Validate and register a local project
  list                                 List registered local projects
  checkpoint <project-id>              Save an immutable continuation package
  restore <checkpoint-id> <new-folder> [--activate]  Verify and restore; --activate switches a registered project
  export <checkpoint-id> <new-folder>  Create a portable package with review notes
  import <bundle-folder>               Verify a portable package into this store
  brief <checkpoint-id>                Print the continuation brief and review notes
  preview <project-id>                 Serve a capability URL until interrupted
  --help                               Show this help

ARCH_HOME overrides the local catalog and checkpoint store. No cloud upload or publication occurs.`;
const [command, ...args] = process.argv.slice(2);
if (process.env.CONVEX_DEPLOY_KEY) throw new Error("Arch project tools run without a Convex deploy key. Remove it before working on local source.");
function intakeArguments(args: string[]) {
  const [inputsDirectory, directory, ...flags] = args;
  if (!inputsDirectory || !directory || inputsDirectory.startsWith("--") || directory.startsWith("--"))
    throw new Error("init requires an inputs folder and a new project folder.");
  const values = new Map<string, string>();
  const allowed = new Set(["--id", "--name", "--client-id", "--client-name", "--description"]);
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i]!;
    const value = flags[i + 1];
    if (!allowed.has(flag) || values.has(flag) || !value || value.startsWith("--"))
      throw new Error(`Invalid, duplicate or missing init option: ${flag}`);
    values.set(flag, value);
  }
  for (const required of ["--id", "--name", "--client-id", "--client-name"])
    if (!values.has(required)) throw new Error(`Missing init option: ${required}`);
  return { inputsDirectory, directory, id: values.get("--id")!, name: values.get("--name")!, client: { id: values.get("--client-id")!, name: values.get("--client-name")! }, description: values.get("--description") };
}
try {
  if (!command || command === "--help" || command === "help") console.log(help);
  else if (command === "init")
    console.log(JSON.stringify(await initializeProject(intakeArguments(args)), null, 2));
  else if (command === "continue" && args.length === 1) {
    const project = await registerProject(args[0]!);
    const checkpoint = await saveCheckpoint(project.manifest.id);
    console.log(await checkpointBrief(checkpoint.id));
  }
  else if (command === "build" && args.length === 2 && args[1] === "--authorize-source-execution") {
    const { checkpoint, artifactHash, artifact } = await buildProjectArtifact(args[0]!, { authorizeSourceExecution: true });
    console.log(JSON.stringify({ checkpointId: checkpoint.id, artifactHash, runtimeHash: artifact.runtimeHash }, null, 2));
  }
  else if (command === "register" && args.length === 1)
    console.log(JSON.stringify(await registerProject(args[0]!), null, 2));
  else if (command === "list" && !args.length)
    console.log(JSON.stringify(await listProjects(), null, 2));
  else if (command === "checkpoint" && args.length === 1)
    console.log(JSON.stringify(await saveCheckpoint(args[0]!), null, 2));
  else if (
    command === "restore" &&
    (args.length === 2 || (args.length === 3 && args[2] === "--activate"))
  )
    console.log(
      JSON.stringify(
        await restoreCheckpoint(args[0]!, args[1]!, {
          activate: args[2] === "--activate",
        }),
        null,
        2,
      ),
    );
  else if (command === "export" && args.length === 2)
    console.log(await exportCheckpoint(args[0]!, args[1]!));
  else if (command === "import" && args.length === 1)
    console.log(JSON.stringify(await importCheckpoint(args[0]!), null, 2));
  else if (command === "brief" && args.length === 1)
    console.log(await checkpointBrief(args[0]!));
  else if (command === "preview" && args.length === 1) {
    console.log((await startPreview(args[0]!)).url);
    const stop = async () => {
      await stopPreviews();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else throw new Error(`Invalid command or arguments.\n\n${help}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
