import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import type {} from '../apps/desktop/update-state';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
// Native display scaling matters: --headless silently forces an 800x600 1x desktop.
if (process.platform !== 'darwin') throw new Error('Desktop verification requires macOS.');
const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'arch-packaged-')));
const home = path.join(temporary, 'store');
const executablePath = path.join(root, `artifacts/arch-studio-darwin-${process.arch}/mac${process.arch === 'arm64' ? '-arm64' : ''}/Arch Studio.app/Contents/MacOS/Arch Studio`);
const demo = spawnSync(process.execPath, ['scripts/demo.ts'], {cwd: root, env: {...process.env, ARCH_HOME: home}, encoding:'utf8'});
assert.equal(demo.status, 0, demo.stderr);
const electronEnv = Object.fromEntries(Object.entries({...process.env, ARCH_HOME: home}).filter((entry): entry is [string, string] => entry[1] !== undefined));
delete electronEnv.ELECTRON_RUN_AS_NODE;
const electron = await _electron.launch({executablePath, args: [`--user-data-dir=${path.join(temporary,'profile')}`], env: electronEnv});
let origin: string | undefined;
try {
  const page = await electron.firstWindow();
  assert.equal(await electron.evaluate(({app}) => app.commandLine.hasSwitch('headless')), false, 'Desktop UI verification must use the native display');
  page.on('pageerror', error => console.error('Renderer error:',error.message));
  page.on('console', message => {if(message.type()==='error') console.error('Renderer console:',message.text());});
  page.setDefaultTimeout(30000);
  await page.getByRole('button', {name:'Sample house',exact:true}).waitFor().catch(async error=>{console.error('Renderer body:',await page.locator('body').innerText());throw error;});
  origin = new URL(page.url()).origin;
  assert.equal(new URL(page.url()).hash, '');
  await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
  await page.getByRole('progressbar').waitFor({state:'hidden',timeout:10000});
  await page.locator('[data-desktop-update]').waitFor();
  const update = await page.evaluate(() => window.archDesktop!.getUpdateState());
  assert.equal(update.currentVersion, await electron.evaluate(({app}) => app.getVersion()));
  assert.notEqual(update.status, 'disabled', 'Signed release must include its update feed');
  assert.equal(await page.locator('[data-viewer] canvas').count(), 1);
  const versions=page.getByLabel(/^(Versions|Versionen)$/);
  const priorVersion=await versions.inputValue();
  const planPath=path.join(home,'examples/sample-house/assets/plan.json');
  const plan=JSON.parse(await readFile(planPath,'utf8'));
  plan.name='Sample house desktop verification';
  await writeFile(planPath,JSON.stringify(plan));
  await page.getByRole('button',{name:/^(Build and version|Erstellen und versionieren)$/}).click();
  await page.getByRole('dialog').getByRole('button',{name:/^(Execute source and build|Quellcode ausführen und erstellen)$/}).click();
  await page.waitForFunction(prior=>(document.querySelector('select[aria-label="Versions"],select[aria-label="Versionen"]') as HTMLSelectElement | null)?.value!==prior,priorVersion).catch(async error=>{console.error('Build body:',await page.locator('body').innerText());throw error;});
  await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
  await page.getByRole('progressbar').waitFor({state:'hidden',timeout:10000});
  const details = await electron.evaluate(({app}) => ({packaged:app.isPackaged,resources:process.resourcesPath}));
  assert.equal(details.packaged,true);
  assert.ok(details.resources.includes('Arch Studio.app/Contents/Resources'));
  await mkdir(path.join(root,'evidence/desktop'),{recursive:true});
  const scaling = await electron.evaluate(({BrowserWindow,screen}) => {const win=BrowserWindow.getAllWindows()[0]!;return screen.getDisplayMatching(win.getBounds()).scaleFactor;});
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
  assert.equal(viewport.dpr,scaling,'UI must use the native display scale');
  const png=await page.screenshot({path:path.join(root,'evidence/desktop/sample-house.png'),scale:'device'});
  assert.equal(png.readUInt32BE(16),Math.round(viewport.width*scaling));
  console.log(JSON.stringify({nativeUiScale:scaling,captureWidth:png.readUInt32BE(16),captureHeight:png.readUInt32BE(20)}));
  await page.getByRole('button',{name:/^(Projektinformationen und Werkzeuge|Project details and tools)$/}).click();
  await page.getByRole('menuitem',{name:/^(Dateien|Files)$/}).click();
  await electron.evaluate(({session}) => { session.defaultSession.on('will-download', (_event,item)=>item.setSavePath(`${process.env.ARCH_HOME}/desktop-reference.json`)); });
  await page.getByRole('link',{name:'sample-house.json',exact:true}).click();
  const download=path.join(home,'desktop-reference.json');
  for(let i=0;i<100;i++){try{await readFile(download);break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  const manifest=JSON.parse(await readFile(path.join(home,'examples/sample-house/arch.project.json'),'utf8'));
  assert.deepEqual(await readFile(download),await readFile(path.join(home,'examples/sample-house',manifest.references[0].path)));
  console.log(JSON.stringify({ok:true,packaged:true,checks:['compiled server, bundled viewer resources and CLI-shared store','real furnished sample house preview','reference link triggers packaged Electron download']}));
} finally {
  await electron.close();
  if(origin) {
    let stopped=false;
    for(let i=0;i<20;i++){try{await fetch(origin);}catch{stopped=true;break;}await new Promise(resolve=>setTimeout(resolve,50));}
    assert.ok(stopped,'Packaged app left its server running');
    console.log('PASS packaged app shutdown closes its owned server');
  }
  await rm(temporary,{recursive:true,force:true});
}
