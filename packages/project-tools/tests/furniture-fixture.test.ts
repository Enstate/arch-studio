import { expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from '../src/intake.ts';
import { artifactFile, buildProjectArtifact } from '../src/index.ts';

test('source builds preserve authored fixture booleans and reject a string at the artifact boundary', async () => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'arch-fixture-')));
  const previous = process.env.ARCH_HOME;
  process.env.ARCH_HOME = path.join(temporary, 'store');
  try {
    const inputsDirectory = path.join(temporary, 'inputs');
    await fs.mkdir(inputsDirectory);
    await fs.writeFile(path.join(inputsDirectory, 'brief.txt'), 'Synthetic geometry for validation.');
    const directory = path.join(temporary, 'project');
    await initializeProject({ inputsDirectory, directory, id: 'fixture-house', name: 'Fixture house', client: { id: 'test', name: 'Test' } });
    expect(await fs.readFile(path.join(directory, 'BUILDERS.md'), 'utf8')).toContain('fixture is an optional boolean');
    const plan = { version: 1, name: 'Fixtures', walls: [{ id: 'wall', a: [0, 0], b: [4, 0] }], furniture: [
      { id: 'built-in', type: 'box', position: [2, 2], fixture: true as unknown },
      { id: 'loose', type: 'wardrobe', position: [3, 2], fixture: false },
    ] };
    const planPath = path.join(directory, 'assets/plan.json');
    await fs.writeFile(planPath, JSON.stringify(plan));
    const built = await buildProjectArtifact('fixture-house', { authorizeSourceExecution: true });
    const file = await artifactFile(built.checkpoint.id, 'outputs/artifact/plan.json');
    expect(JSON.parse(file.toString()).furniture).toEqual(plan.furniture);
    plan.furniture[0]!.fixture = 'false';
    await fs.writeFile(planPath, JSON.stringify(plan));
    await expect(buildProjectArtifact('fixture-house', { authorizeSourceExecution: true })).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.ARCH_HOME;
    else process.env.ARCH_HOME = previous;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
