import {expect,test} from 'bun:test';
import * as THREE from 'three/webgpu';
import {buildDressing} from '../src/build/dressing.ts';
import {MaterialLibrary} from '../src/build/materials.ts';
import type {Plan} from '../src/plan/schema.ts';

test.each([0,1,2])('%i blocked curtain spots leave a rod only when a panel remains',blocked=>{
 const plan:Plan={version:1,name:'Window dressing',materials:{linen:{color:'#ffffff'}},walls:[{id:'wall',a:[0,0],b:[6,0],exterior:true}],rooms:[{id:'room',name:'Room',polygon:[[0,0],[6,0],[6,4],[0,4]]}],openings:[{id:'window',wall:'wall',type:'window',offset:3,width:1.2}],furniture:[]};
 // Exterior wall a→b has its curtains on the positive-z side. The panel
 // centres are 3 ± (0.6 + 0.225 + 0.04), 0.24 m inside the wall centre.
 for(let i=0;i<blocked;i++)plan.furniture!.push({id:`cabinet-${i}`,type:'box',position:[3+(i?1:-1)*.865,.24],size:[.45,.3,.3]});
 const lib=new MaterialLibrary(plan,()=>undefined),mat=new THREE.MeshStandardMaterial();
 const dressing=buildDressing(plan,lib,()=>mat);
 const rods=dressing.children.filter(o=>(o as THREE.Mesh).geometry?.type==='CylinderGeometry' && (o as THREE.Mesh<THREE.CylinderGeometry>).geometry.parameters?.radiusTop===.012);
 expect(rods).toHaveLength(blocked===2?0:1);
 lib.dispose();mat.dispose();
});
