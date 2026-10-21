/** Native sidebar checks against a local preview bundle. Never uses an existing store. */
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {_electron} from 'playwright-core';
import type {} from '../apps/desktop/update-state';

if(process.platform!=='darwin')throw new Error('Native sidebar verification requires macOS.');
const root=fileURLToPath(new URL('..',import.meta.url));
const temporary=await realpath(await mkdtemp(join(tmpdir(),'arch-sidebar-')));
const home=join(temporary,'store');
const application=process.argv[2]??join(root,`artifacts/arch-studio-darwin-${process.arch}-preview/mac${process.arch==='arm64'?'-arm64':''}/Arch Studio.app`);
const evidence=join(root,'evidence/native-sidebar');
const env=Object.fromEntries(Object.entries({...process.env,ARCH_HOME:home}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete env.ELECTRON_RUN_AS_NODE;
const demo=spawnSync(process.execPath,['scripts/demo.ts'],{cwd:root,env,encoding:'utf8'});
assert.equal(demo.status,0,demo.stderr);
let origin:string|undefined;
const electron=await _electron.launch({executablePath:join(application,'Contents/MacOS/Arch Studio'),args:[`--user-data-dir=${join(temporary,'profile')}`],env});
try{
 const page=await electron.firstWindow();page.setDefaultTimeout(20000);
 await page.getByRole('button',{name:'Sample house',exact:true}).waitFor();
 origin=new URL(page.url()).origin;
 await page.context().addCookies([{name:'arch-locale',value:'en',url:origin}]);
 await page.evaluate(()=>localStorage.setItem('arch-theme','dark'));
 await page.reload();
 // Projects open on Rounds. The harness checks the model view.
 await page.locator('[data-studio-view="preview"]:visible').click();
 await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
 await page.getByRole('progressbar').waitFor({state:'hidden'});
 assert.equal(await page.locator('html').getAttribute('data-arch-platform'),'darwin');
 const native=await electron.evaluate(({BrowserWindow,screen,app})=>{
   const win=BrowserWindow.getAllWindows()[0]!;
   return {headless:app.commandLine.hasSwitch('headless'),buttons:win.getWindowButtonPosition(),bounds:win.getBounds(),content:win.getContentBounds(),dpr:screen.getDisplayMatching(win.getBounds()).scaleFactor};
 });
 assert.equal(native.headless,false);assert.deepEqual(native.buttons,{x:16,y:19});
 assert.equal(native.content.height,native.bounds.height,'Native title bar must not consume a separate row');
 assert.equal(await page.evaluate(()=>devicePixelRatio),native.dpr);
 assert.equal(await page.locator('.studio-titlebar').evaluate(x=>x.getBoundingClientRect().height),52);
 const toggle=page.getByRole('button',{name:'Hide sidebar',exact:true});
 assert.ok((await toggle.boundingBox())!.x>=80,'Sidebar toggle overlaps traffic lights');
 assert.equal(await toggle.evaluate(x=>getComputedStyle(x).getPropertyValue('-webkit-app-region')),'no-drag');
 assert.equal(await page.getByRole('heading',{name:'Projects',exact:true}).count(),0);
 const selectedProject=page.getByRole('button',{name:'Sample house',exact:true});
 await selectedProject.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
 assert.equal(await selectedProject.evaluate(x=>getComputedStyle(x).outlineWidth),'2px','Selected project needs keyboard focus');
 assert.equal(await selectedProject.evaluate(x=>getComputedStyle(x).outlineStyle),'solid');
 await page.keyboard.press('Meta+b');
 await page.locator('[data-sidebar="closed"]').waitFor();
 assert.ok((await page.getByRole('button',{name:'Open menu',exact:true}).boundingBox())!.x>=80,'Collapsed navigation overlaps traffic lights');
 await page.keyboard.press('Meta+b');await page.locator('[data-sidebar="open"]').waitFor();
 await page.getByRole('button',{name:'Filter projects',exact:true}).click();
 const filter=page.getByRole('menuitem',{name:'Without local source',exact:true});
 await filter.waitFor();
 assert.equal(await filter.evaluate(x=>getComputedStyle(x).whiteSpace),'nowrap');
 await filter.click();await page.getByText('No matching projects.',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Filter projects',exact:true}).click();
 await page.getByRole('menuitem',{name:'All projects',exact:true}).click();
 await mkdir(evidence,{recursive:true});
 const settings=()=>page.getByRole('button',{name:/^(Settings|Einstellungen)$/,exact:true});
 async function preference(name:RegExp){
   await settings().click();
   await page.getByRole('menuitem',{name,exact:false}).click();
 }
 await preference(/^Language/);
 assert.equal(await page.getByRole('menuitemradio',{name:'English',exact:true}).getAttribute('aria-checked'),'true');
 const german=page.getByRole('menuitemradio',{name:'Deutsch',exact:true});
 await german.click();await german.waitFor({state:'hidden'});
 await page.reload();await page.getByRole('button',{name:'Einstellungen',exact:true}).waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'de');
 await preference(/^Sprache/);
 const english=page.getByRole('menuitemradio',{name:'English',exact:true});
 await english.click();await english.waitFor({state:'hidden'});
 await preference(/^Appearance/);
 const light=page.getByRole('menuitemradio',{name:'Light',exact:true});
 await light.click();await light.waitFor({state:'hidden'});
 assert.equal(await page.locator('html').evaluate(x=>x.classList.contains('dark')),false);
 await preference(/^Appearance/);
 assert.equal(await light.getAttribute('aria-checked'),'true');
 await page.screenshot({path:join(evidence,'preferences-light.png'),scale:'device',animations:'disabled'});
 const dark=page.getByRole('menuitemradio',{name:'Dark',exact:true});
 await dark.click();await dark.waitFor({state:'hidden'});
 await preference(/^Appearance/);
 assert.equal(await dark.getAttribute('aria-checked'),'true');
 await dark.focus();await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowUp');
 assert.equal(await dark.evaluate(x=>getComputedStyle(x).outlineWidth),'2px','Checked choice needs keyboard focus');
 await page.screenshot({path:join(evidence,'preferences-dark.png'),scale:'device',animations:'disabled'});
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await page.locator('[data-studio-view="preview"]:visible').click();
 await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
 await page.getByRole('button',{name:'Updates',exact:true}).click();
 await page.getByText('Updates are available in installed release builds.',{exact:true}).last().waitFor();
 await page.locator('[data-slot="popover-content"]').waitFor();
 assert.equal(await page.getByRole('alert').count(),0,'Preview updater is disabled, not failed');
 await page.keyboard.press('Escape');
 const rejected=await electron.evaluate(async({BrowserWindow},preload)=>{
   const alien=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload}});
   try{await alien.loadURL('data:text/html,<title>Untrusted local caller</title>');return await alien.webContents.executeJavaScript('window.archDesktop.chooseProjectDirectory().then(()=>false,()=>true)');}finally{alien.destroy();}
 },join(application,'Contents/Resources/app.asar/preload.cjs'));
 assert.equal(rejected,true,'An unrelated window must not open the directory picker');
 await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setFullScreen(true));
 await page.locator('html[data-arch-fullscreen="true"]').waitFor();
 assert.equal(await page.locator('.studio-titlebar').evaluate(x=>getComputedStyle(x).paddingLeft),'0px');
 await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setFullScreen(false));
 await page.locator('html[data-arch-fullscreen="false"]').waitFor();
 // The sidebar is portaled outside .studio-shell below 768px.
 await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(700,800));
 await page.getByRole('button',{name:'Open menu',exact:true}).click();
 const sheet=page.getByRole('dialog');await sheet.waitFor();
 const sheetToggle=sheet.getByRole('button',{name:'Hide sidebar',exact:true});
 assert.equal(await sheetToggle.evaluate(x=>getComputedStyle(x).getPropertyValue('-webkit-app-region')),'no-drag');
 await sheetToggle.click({trial:true}); // Wait for the sheet entrance transition to settle.
 assert.ok((await sheetToggle.boundingBox())!.x>=80,'Portaled sidebar overlaps traffic lights');
 await sheetToggle.click();await sheet.waitFor({state:'hidden'});
 await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1440,960));
 await page.getByRole('button',{name:'Hide sidebar',exact:true}).waitFor();
 await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
 await page.getByRole('progressbar').waitFor({state:'hidden'});
 await mkdir(evidence,{recursive:true});
 await page.screenshot({path:join(evidence,'after.png'),scale:'device',animations:'disabled'});
 console.log('PASS native inset/titlebar/scale, sidebar collapse, one-line filters, versions/handoff, preview update panel, untrusted picker denial, fullscreen, and portaled narrow sidebar');
 if(process.env.ARCH_CAPTURE_NATIVE==='1'){
   const ready=join(root,'.arch/sidebar-native-ready');const captured=join(root,'.arch/sidebar-native-captured');
   await rm(captured,{force:true});await writeFile(ready,JSON.stringify({application,pid:electron.process().pid,temporary}));
   console.log('Native window ready for matching frame capture');
   const deadline=Date.now()+90000;
   while(Date.now()<deadline){if(await access(captured).then(()=>true,()=>false))break;await new Promise(resolve=>setTimeout(resolve,250));}
   await rm(ready,{force:true});
 }
}finally{
 await electron.close();
 if(origin){for(let index=0;index<30;index++){try{await fetch(origin);}catch{break;}await new Promise(resolve=>setTimeout(resolve,100));}await assert.rejects(fetch(origin));}
 await rm(temporary,{recursive:true,force:true});
}
