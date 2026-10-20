import { test, expect } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerProject, buildProjectArtifact, artifactDetails, inspectArtifact, artifactFile, exportCheckpoint, importCheckpoint, restoreCheckpoint } from '../src/index';
test('v2 archive roundtrip verifies artifact bytes and rejects tampering', async()=>{
 const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'arch-artifact-')));const prior=process.env.ARCH_HOME;
 try {
 process.env.ARCH_HOME=path.join(temp,'store'); const directory=path.join(temp,'project');await fs.mkdir(path.join(directory,'source'),{recursive:true});
 await fs.writeFile(path.join(directory,'source/generate.ts'),`import {writeFileSync} from 'node:fs';writeFileSync(process.env.ARCH_ARTIFACT_OUTPUT+'/plan.json',JSON.stringify({version:1,name:'Test',walls:[{id:'wall',a:[0,0],b:[4,0]}],cameras:[{id:'entry',position:[1,1],height:2,lookAt:[2,2]}]}));`);
 await fs.writeFile(path.join(directory,'arch.project.json'),JSON.stringify({schemaVersion:2,id:'test-house',name:'Test',client:{id:'internal',name:'Internal'},description:'',entry:'source/generate.ts',runtime:{name:'arch-viewer',version:'0.1.0',threeVersion:'0.186.1'},views:[],assumptions:[],references:[],artifacts:[]}));
 await fs.writeFile(path.join(directory,'arch.context.json'),JSON.stringify({goal:'Test',driver:'Test',decisions:[],unresolved:[],nextAction:'Test',instructionVersion:'1'}));
 await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({dependencies:{three:'0.186.1'}}));
 await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{three:'0.186.1'}},'node_modules/three':{version:'0.186.1',resolved:'https://registry.npmjs.org/three/-/three-0.186.1.tgz',integrity:'sha512-test'}}}));
 await registerProject(directory); const built=await buildProjectArtifact('test-house',{authorizeSourceExecution:true});
 expect(built.artifact.cameras).toEqual([{id:'entry',position:[1,2,1],target:[2,1.2,2]}]);
 expect((await inspectArtifact({checkpointId:built.checkpoint.id})).artifactHash).toBe(built.artifactHash);
 const bundle=path.join(temp,'bundle'); await exportCheckpoint(built.checkpoint.id,bundle);
 process.env.ARCH_HOME=path.join(temp,'imported');await importCheckpoint(bundle);
 await restoreCheckpoint(built.checkpoint.id,path.join(temp,'continued'),{activate:true});
 expect(await fs.readFile(path.join(temp,'continued/AGENT_BRIEF.md'),'utf8')).toContain(built.checkpoint.id);
 const continued=await buildProjectArtifact('test-house',{authorizeSourceExecution:true});
 expect(continued.artifactHash).toBe(built.artifactHash);
 expect(continued.checkpoint.files.some(file=>file.path==='AGENT_BRIEF.md')).toBe(false);
 expect((await inspectArtifact({checkpointId:built.checkpoint.id})).artifactHash).toBe(built.artifactHash);
 const plan=built.artifact.files.find(f=>f.path===built.artifact.plan)!;
 await artifactFile(built.checkpoint.id,plan.path);
 await fs.writeFile(path.join(process.env.ARCH_HOME,'blobs/sha256',plan.sha256),'tampered');
 // Listings verify the manifest and checkpoint table, while opening and serving
 // still reject changed asset bytes. No whole-artifact byte scan on every poll.
 expect((await artifactDetails({checkpointId:built.checkpoint.id})).artifactHash).toBe(built.artifactHash);
 await expect(artifactFile(built.checkpoint.id,plan.path)).rejects.toThrow();
 await expect(inspectArtifact({checkpointId:built.checkpoint.id})).rejects.toThrow();
 const metadata=built.checkpoint.files.find(file=>file.path==='outputs/artifact.json')!;
 await fs.writeFile(path.join(process.env.ARCH_HOME,'blobs/sha256',metadata.sha256),'tampered metadata');
 await expect(artifactDetails({checkpointId:built.checkpoint.id})).rejects.toThrow();
 process.env.ARCH_HOME=path.join(temp,'store');
 const generator=path.join(directory,'source/generate.ts');
 const original=await fs.readFile(generator,'utf8');
 await fs.writeFile(generator,original.replace("name:'Test'","name:'Test',materials:{unsafe:{color:'#fff',texture:'http://127.0.0.1/private.png'}}"));
 await expect(buildProjectArtifact('test-house',{authorizeSourceExecution:true})).rejects.toThrow('Asset reference');
 await fs.writeFile(generator,original.replace("walls:[{id:'wall',a:[0,0],b:[4,0]}]","walls:[]"));
 await expect(buildProjectArtifact('test-house',{authorizeSourceExecution:true})).rejects.toThrow('Invalid generated plan');
 }finally {if(prior===undefined)delete process.env.ARCH_HOME;else process.env.ARCH_HOME=prior;await fs.rm(temp,{recursive:true,force:true});}
});
