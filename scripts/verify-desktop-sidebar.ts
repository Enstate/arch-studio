/** Native sidebar checks against a local preview bundle. Never uses an existing store. */
import assert from 'node:assert/strict';
import {mkdtemp, realpath, mkdir, rm, writeFile, access, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {_electron,type Page} from 'playwright-core';
import type {} from '../apps/desktop/update-state';
import {studioText} from '../apps/studio/src/lib/messages';

if(process.platform!=='darwin')throw new Error('Native sidebar verification requires macOS.');
const root=fileURLToPath(new URL('..',import.meta.url));
const temporary=await realpath(await mkdtemp(join(tmpdir(),'arch-sidebar-')));
const home=join(temporary,'store');
const languageOnly=process.argv.includes('--languages');
const application=process.argv.slice(2).find(argument=>!argument.startsWith('--'))??join(root,`artifacts/arch-studio-darwin-${process.arch}-preview/mac${process.arch==='arm64'?'-arm64':''}/Arch Studio.app`);
const evidence=join(root,'evidence/native-sidebar');
const env=Object.fromEntries(Object.entries({...process.env,ARCH_HOME:home}).filter((entry):entry is [string,string]=>entry[1]!==undefined));
delete env.ELECTRON_RUN_AS_NODE;
const demo=spawnSync(process.execPath,['scripts/demo.ts'],{cwd:root,env,encoding:'utf8'});
assert.equal(demo.status,0,demo.stderr);
let origin:string|undefined;
const iconMetadata=spawnSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIconFile',join(application,'Contents/Info.plist')],{encoding:'utf8'});
assert.equal(iconMetadata.status,0,iconMetadata.stderr);
const iconName=iconMetadata.stdout.trim();
assert.deepEqual(await readFile(join(application,'Contents/Resources',iconName.endsWith('.icns')?iconName:`${iconName}.icns`)),await readFile(join(root,'apps/desktop/icon.icns')),'Packaged app must contain the Arch icon');
await mkdir(evidence,{recursive:true});
const iconPreview=spawnSync('/usr/bin/sips',['-s','format','png',join(application,'Contents/Resources',iconName.endsWith('.icns')?iconName:`${iconName}.icns`),'--out',join(evidence,'app-icon.png')],{encoding:'utf8'});
assert.equal(iconPreview.status,0,iconPreview.stderr);
console.log('PASS packaged Arch app icon matches the source icon');
const electron=await _electron.launch({executablePath:join(application,'Contents/MacOS/Arch Studio'),args:[`--user-data-dir=${join(temporary,'profile')}`],env});
async function verifyLanguages(page:Page){
 const names={en:'English',de:'Deutsch',es:'Español',pt:'Português do Brasil'};
 let previous:'en'|'de'|'es'|'pt'='en';
 for(const locale of ['de','es','pt'] as const){
   await page.getByRole('button',{name:studioText[previous].settings,exact:true}).click();
   const select=page.getByRole('combobox',{name:studioText[previous].language,exact:true});
   assert.match(await select.innerText(),new RegExp(names[previous]));
   await select.click();
   if(previous==='de'){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'language-menu.png'),scale:'device',animations:'disabled'});}
   const choice=page.getByRole('option',{name:names[locale],exact:true});
   await choice.click();await choice.waitFor({state:'hidden'});
   // Reloading leaves Settings and returns to the project.
   await page.reload();
   await page.getByRole('button',{name:studioText[locale].settings,exact:true}).waitFor();
   await page.getByRole('button',{name:`${studioText[locale].newThread}, Sample house`,exact:true}).waitFor();
   assert.equal(await page.locator('html').getAttribute('lang'),locale);
   const updateLabel=await electron.evaluate(({Menu})=>Menu.getApplicationMenu()!.items[0]!.submenu!.items[1]!.label);
   assert.equal(updateLabel,`${studioText[locale].checkUpdates}…`);
   await page.getByRole('button',{name:studioText[locale].addProject,exact:true}).click();
   await page.getByRole('menuitem',{name:studioText[locale].newProject,exact:true}).click();
   const dialog=page.getByRole('dialog');
   await dialog.getByRole('heading',{name:studioText[locale].newProject,exact:true}).waitFor();
   await dialog.getByRole('button',{name:studioText[locale].close,exact:true}).waitFor();
   assert.ok(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth),'Translated dialog must fit its width');
   await mkdir(evidence,{recursive:true});
   await page.screenshot({path:join(evidence,`language-${locale}.png`),scale:'device',animations:'disabled'});
   await dialog.getByRole('button',{name:studioText[locale].close,exact:true}).click();
   await dialog.waitFor({state:'hidden'});
   previous=locale;
 }
 await page.getByRole('button',{name:studioText[previous].settings,exact:true}).click();
 await page.getByRole('combobox',{name:studioText[previous].language,exact:true}).click();
 await page.getByRole('option',{name:names.en,exact:true}).click();
 await page.getByRole('combobox',{name:studioText.en.language,exact:true}).waitFor();
 console.log('PASS German, Spanish and Portuguese selection, persistence, native menu, translated project dialogs and close labels');
}
try{
 const page=await electron.firstWindow();page.setDefaultTimeout(20000);
 await mkdir(evidence,{recursive:true});

 page.on('console',message=>{if(['error','warning'].includes(message.type()))console.error('Studio console:',message.text().replace(/https?:\/\/[^\s]+/g,'[URL]'));});
 page.on('requestfailed',request=>console.error('Studio request failed:',new URL(request.url()).pathname.replace(/\/[a-f0-9]{64}/g,'/[redacted]'),request.failure()?.errorText));
 page.on('pageerror',error=>console.error('Studio page error:',error.message.replace(/https?:\/\/[^\s]+/g,'[URL]')));
 // The sidebar lists threads; the demo project opens with one.
 const thread=()=>page.getByRole('button',{name:`${studioText.en.newThread}, Sample house`,exact:true});
 await thread().waitFor();
 origin=new URL(page.url()).origin;
 await page.context().addCookies([{name:'arch-locale',value:'en',url:origin}]);
 await page.evaluate(()=>localStorage.setItem('arch-theme','dark'));
 await page.reload();
 if(languageOnly){
   await verifyLanguages(page);
   await page.context().addCookies([{name:'arch-locale',value:'de',url:origin}]);
   await page.evaluate(()=>sessionStorage.removeItem('arch-studio-session'));
   await page.reload();
   await page.getByText(studioText.de.sessionRequired,{exact:true}).waitFor();
   await page.screenshot({path:join(evidence,'session-required-de.png'),scale:'device',animations:'disabled'});
   console.log('PASS localized session recovery without a Studio bearer');
 }else{
 // Projects open on Rounds. The harness checks the model view.
 await page.locator('[data-studio-view="preview"]:visible').click();
 await page.locator('[data-studio-preview="ready"], [data-studio-preview] [role="alert"]').waitFor({timeout:120000});
 assert.equal(await page.locator('[data-studio-preview]').getAttribute('data-studio-preview'),'ready','The 3D preview must load');
 await page.getByRole('progressbar').waitFor({state:'hidden'});
 assert.equal(await page.locator('html').getAttribute('data-arch-platform'),'darwin');
 // Holding the right button in 3D captures the mouse for free look; the shell grants only that permission.
 const canvas=page.locator('[data-viewer] canvas');
 const area=(await canvas.boundingBox())!;
 // A person pressing in the window has it in front; Chromium grants a capture only to the focused app.
 await electron.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0]!.focus();});
 let captures=0;
 const captured=async()=>{
   captures++;
   // Other apps on a shared machine can take the front; Studio asks again each second while the button is down.
   for(let attempt=0;attempt<5;attempt++){
     await electron.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0]!.focus();});
     try{await page.waitForFunction(()=>document.pointerLockElement instanceof HTMLCanvasElement,undefined,{timeout:1200});return;}catch{}
   }
   throw new Error(`Capture ${captures} was not granted (window focused: ${await page.evaluate(()=>document.hasFocus())})`);
 };
 const turn=async()=>{for(let step=1;step<=6;step++)await page.mouse.move(area.x+area.width/2-step*10,area.y+area.height/2);};
 await page.mouse.move(area.x+area.width/2,area.y+area.height/2);
 await page.mouse.down({button:'right'});await turn();
 await captured();
 await page.mouse.up({button:'right'});
 await page.waitForFunction(()=>document.pointerLockElement===null,undefined,{timeout:5000});
 // Quick right clicks ask for no capture, so Chromium's limit on repeated captures is never reached.
 for(let click=0;click<8;click++){await page.mouse.down({button:'right'});await page.mouse.up({button:'right'});}
 await page.mouse.move(area.x+area.width/2,area.y+area.height/2);
 await page.mouse.down({button:'right'});await turn();
 await captured();
 await page.mouse.up({button:'right'});
 // Any order of presses ends with the mouse free and orbiting working, including a quick right
 // click whose capture arrives after the button is up.
 const center={x:area.x+area.width/2,y:area.y+area.height/2};
 const released=()=>page.waitForFunction(()=>document.pointerLockElement===null,undefined,{timeout:5000});
 const orbits=async(label:string)=>{
   await page.waitForTimeout(700);await released();
   const before=await canvas.screenshot();
   await page.mouse.move(center.x,center.y);await page.mouse.down();
   for(let step=1;step<=12;step++)await page.mouse.move(center.x+step*12,center.y);
   await page.mouse.up();await page.waitForTimeout(400);
   const after=await canvas.screenshot();
   if(Buffer.compare(before,after)===0){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'orbit-before.png'),before);await writeFile(join(evidence,'orbit-after.png'),after);}
   assert.notEqual(Buffer.compare(before,after),0,`Left drag must orbit after ${label}`);
 };
 const sequences:[string,()=>Promise<void>][]=[
   ['a quick right click',async()=>{await page.mouse.down({button:'right'});await page.mouse.up({button:'right'});}],
   ['right, left, left up, right up',async()=>{await page.mouse.down({button:'right'});await page.mouse.move(center.x-20,center.y);await page.mouse.down({button:'left'});await page.mouse.up({button:'left'});await page.mouse.up({button:'right'});}],
   ['right, left, right up, left up',async()=>{await page.mouse.down({button:'right'});await page.mouse.move(center.x-20,center.y);await page.mouse.down({button:'left'});await page.mouse.up({button:'right'});await page.mouse.up({button:'left'});}],
   ['a right press during a left drag',async()=>{await page.mouse.down({button:'left'});await page.mouse.move(center.x+30,center.y);await page.mouse.down({button:'right'});await page.mouse.move(center.x+60,center.y);await page.mouse.up({button:'right'});await page.mouse.up({button:'left'});}],
   ['a right press during a Shift pan',async()=>{await page.keyboard.down('Shift');await page.mouse.down({button:'left'});await page.mouse.move(center.x+30,center.y+20);await page.mouse.down({button:'right'});await page.mouse.up({button:'left'});await page.mouse.up({button:'right'});await page.keyboard.up('Shift');}],
 ];
 for(const [label,run] of sequences){await page.mouse.move(center.x,center.y);await run();await orbits(label);}
 const otherPermission=await page.evaluate(async()=>(await navigator.permissions.query({name:'geolocation'})).state);
 assert.equal(otherPermission,'denied');
 console.log('PASS free look captures and releases the mouse, and every button order hands back to orbit; other permissions stay denied');
 const native=await electron.evaluate(({BrowserWindow,screen,app})=>{
   const win=BrowserWindow.getAllWindows()[0]!;
   return {headless:app.commandLine.hasSwitch('headless'),buttons:win.getWindowButtonPosition(),bounds:win.getBounds(),content:win.getContentBounds(),dpr:screen.getDisplayMatching(win.getBounds()).scaleFactor};
 });
 assert.equal(native.headless,false);assert.deepEqual(native.buttons,{x:16,y:19});
 assert.equal(native.content.height,native.bounds.height,'Native title bar must not consume a separate row');
 assert.equal(await page.evaluate(()=>devicePixelRatio),native.dpr);
 assert.equal(await page.locator('.studio-titlebar').evaluate(x=>x.getBoundingClientRect().height),52);
 const toggle=page.getByRole('button',{name:studioText.en.hideSidebar,exact:true});
 assert.ok((await toggle.boundingBox())!.x>=80,'Sidebar toggle overlaps traffic lights');
 assert.equal(await toggle.evaluate(x=>getComputedStyle(x).getPropertyValue('-webkit-app-region')),'no-drag');
 assert.equal(await page.getByRole('heading',{name:'Projects',exact:true}).count(),0);
 const selectedThread=thread();
 await selectedThread.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
 // Thread cards draw their keyboard focus as a ring (box-shadow), as in T3 Code.
 assert.notEqual(await selectedThread.evaluate(x=>getComputedStyle(x).boxShadow),'none','Selected thread needs keyboard focus');
 await page.keyboard.press('Meta+b');
 await page.locator('[data-sidebar="closed"]').waitFor();
 assert.ok((await page.getByRole('button',{name:studioText.en.openMenu,exact:true}).boundingBox())!.x>=80,'Collapsed navigation overlaps traffic lights');
 await page.keyboard.press('Meta+b');await page.locator('[data-sidebar="open"]').waitFor();
 await page.getByRole('button',{name:studioText.en.filterProjects,exact:true}).click();
 const filter=page.getByRole('menuitem',{name:'Sample house',exact:true});
 await filter.waitFor();
 assert.equal(await filter.locator('span.truncate').evaluate(x=>getComputedStyle(x).whiteSpace),'nowrap');
 await filter.click();await thread().waitFor();
 await page.getByRole('button',{name:studioText.en.filterProjects,exact:true}).click();
 await page.getByRole('menuitem',{name:studioText.en.allProjects,exact:true}).click();
 await mkdir(evidence,{recursive:true});
 const sections=()=>page.getByRole('navigation',{name:studioText.en.settingsSections,exact:true});
 await verifyLanguages(page);
 // Languages leave Settings open on General. Appearance is its own section.
 await sections().getByRole('button',{name:studioText.en.appearance,exact:true}).click();
 const light=page.getByRole('button',{name:studioText.en.light,exact:true});
 await light.click();
 assert.equal(await page.locator('html').evaluate(x=>x.classList.contains('dark')),false);
 assert.equal(await light.getAttribute('aria-pressed'),'true');
 await page.screenshot({path:join(evidence,'preferences-light.png'),scale:'device',animations:'disabled'});
 const dark=page.getByRole('button',{name:studioText.en.dark,exact:true});
 await dark.click();
 assert.equal(await dark.getAttribute('aria-pressed'),'true');
 await light.focus();await page.keyboard.press('Tab');
 assert.notEqual(await dark.evaluate(x=>getComputedStyle(x).boxShadow),'none','Keyboard focus needs a visible ring');
 await page.screenshot({path:join(evidence,'preferences-dark.png'),scale:'device',animations:'disabled'});
 // Agents list both CLIs with a status, whatever is installed on this Mac.
 await sections().getByRole('button',{name:studioText.en.agents,exact:true}).click();
 for(const name of ['Claude Code','Codex'])await page.getByRole('switch',{name:`Use ${name}`,exact:true}).waitFor();
 await page.getByRole('button',{name:/^(Checked|Check again)/}).waitFor({timeout:60000});
 await page.screenshot({path:join(evidence,'settings-agents.png'),scale:'device',animations:'disabled'});
 await sections().getByRole('button',{name:studioText.en.back,exact:true}).click();
 await sections().waitFor({state:'hidden'});
 // The app menu's Settings item reaches the renderer through the preload bridge.
 await electron.evaluate(({Menu})=>Menu.getApplicationMenu()!.items[0]!.submenu!.items.find(item=>item.label==='Settings…')!.click());
 await sections().waitFor();
 await page.keyboard.press('Escape');
 await sections().waitFor({state:'hidden'});
 console.log('PASS settings page: language, appearance, agents, menu item and Escape');
 await page.locator('[data-studio-view="preview"]:visible').click();
 await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
 await page.getByRole('button',{name:'Updates',exact:true}).click();
 await page.getByText(studioText.en.updateDisabled,{exact:true}).last().waitFor();
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
 await page.getByRole('button',{name:studioText.en.openMenu,exact:true}).click();
 const sheet=page.getByRole('dialog');await sheet.waitFor();
 const sheetToggle=sheet.getByRole('button',{name:studioText.en.hideSidebar,exact:true});
 assert.equal(await sheetToggle.evaluate(x=>getComputedStyle(x).getPropertyValue('-webkit-app-region')),'no-drag');
 await sheetToggle.click({trial:true}); // Wait for the sheet entrance transition to settle.
 assert.ok((await sheetToggle.boundingBox())!.x>=80,'Portaled sidebar overlaps traffic lights');
 await sheetToggle.click();await sheet.waitFor({state:'hidden'});
 await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(1440,960));
 await page.getByRole('button',{name:studioText.en.hideSidebar,exact:true}).waitFor();
 await page.locator('[data-studio-preview="ready"]').waitFor({timeout:120000});
 await page.getByRole('progressbar').waitFor({state:'hidden'});
 await mkdir(evidence,{recursive:true});
 await page.screenshot({path:join(evidence,'after.png'),scale:'device',animations:'disabled'});
 console.log('PASS native inset/titlebar/scale, sidebar collapse, one-line filters, versions/handoff, preview update panel, untrusted picker denial, fullscreen, and portaled narrow sidebar');
 // A project file opened from Finder arrives through open-file and lands in Studio's open dialog.
 const types=spawnSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleDocumentTypes:0:CFBundleTypeExtensions:0',join(application,'Contents/Info.plist')],{encoding:'utf8'});
 assert.equal(types.stdout.trim(),'archproject','Packaged app must declare the project file type');
 const shared=join(temporary,'Sample house.archproject');
 const exported=spawnSync(process.execPath,['-e',`const tools=await import(${JSON.stringify(join(root,'packages/project-tools/src/index.ts'))});const project=(await tools.listProjects()).find(item=>item.manifest.name==='Sample house');await tools.exportProjectPackage(project.manifest.id,${JSON.stringify(shared)},{name:project.manifest.name});`],{cwd:root,env,encoding:'utf8'});
 assert.equal(exported.status,0,exported.stderr);
 await electron.evaluate(({app},file)=>{app.emit('open-file',{preventDefault(){}},file);},shared);
 const openedFile=page.getByRole('dialog');
 await openedFile.getByText(studioText.en.projectUpToDate.replace('{name}','Sample house'),{exact:true}).waitFor({timeout:30000});
 await page.screenshot({path:join(evidence,'open-file.png'),scale:'device',animations:'disabled'});
 await page.keyboard.press('Escape');await openedFile.waitFor({state:'hidden'});
 console.log('PASS packaged file association and a Finder-opened project file reach the open dialog');
 if(process.env.ARCH_CAPTURE_NATIVE==='1'){
   const ready=join(root,'.arch/sidebar-native-ready');const captured=join(root,'.arch/sidebar-native-captured');
   await rm(captured,{force:true});await writeFile(ready,JSON.stringify({application,pid:electron.process().pid,temporary}));
   console.log('Native window ready for matching frame capture');
   const deadline=Date.now()+90000;
   while(Date.now()<deadline){if(await access(captured).then(()=>true,()=>false))break;await new Promise(resolve=>setTimeout(resolve,250));}
   await rm(ready,{force:true});
 }
}
}catch(error){
 const page=electron.windows()[0];
 if(page){
   await mkdir(evidence,{recursive:true});
   await page.screenshot({path:join(evidence,'failure.png'),scale:'device',animations:'disabled'}).catch(()=>{});
   const state={text:await page.locator('body').innerText().catch(()=>''),preview:await page.locator('[data-studio-preview]').getAttribute('data-studio-preview').catch(()=>null)};
   await writeFile(join(evidence,'failure.json'),JSON.stringify(state,null,2));
   console.error('Studio failure state:',JSON.stringify(state));
 }
 throw error;
}finally{
 await electron.close();
 if(origin){for(let index=0;index<30;index++){try{await fetch(origin);}catch{break;}await new Promise(resolve=>setTimeout(resolve,100));}await assert.rejects(fetch(origin));}
 await rm(temporary,{recursive:true,force:true});
}
