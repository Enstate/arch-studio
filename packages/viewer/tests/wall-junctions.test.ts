import {expect,test} from 'bun:test';
import * as THREE from 'three/webgpu';
import {Octree} from 'three/examples/jsm/math/Octree.js';
import {buildHouse} from '../src/build/house.ts';
import {BUILTIN,MaterialLibrary} from '../src/build/materials.ts';
import type {Plan} from '../src/plan/schema.ts';

test.each(['corner','tee'] as const)('%s wall junction has one exposed face at its shared outer plane',async kind=>{
 const plan:Plan={version:1,name:'Wall junction',walls:[
  {id:'through',a:[0,0],b:[6,0]},
  {id:'branch',a:[kind==='corner'?6:3,0],b:[kind==='corner'?6:3,3]},
 ],materials:Object.fromEntries(Object.keys(BUILTIN).map(key=>[key,{color:'#ffffff'}]))};
 const lib=new MaterialLibrary(plan,()=>undefined),house=await buildHouse(plan,lib,{resolveUrl:()=>undefined});
 try{
  house.walls.updateMatrixWorld(true);
  const x=kind==='corner'?5.99:3.01;
  const hits=new THREE.Raycaster(new THREE.Vector3(x,1.4,-1),new THREE.Vector3(0,0,1)).intersectObject(house.walls,true);
  const nearest=hits.filter(hit=>Math.abs(hit.distance-hits[0]!.distance)<1e-5);
  expect(nearest).toHaveLength(1);
  const branch=house.colliders.children.find(mesh=>new THREE.Box3().setFromObject(mesh).max.z===3)!;
  const closed=new Octree().fromGraphNode(branch.clone());
  const colliderHit=closed.rayIntersect(new THREE.Ray(new THREE.Vector3(kind==='corner'?6:3,1.4,-1),new THREE.Vector3(0,0,1)));
  expect(colliderHit).toBeTruthy();
  if(colliderHit)expect(colliderHit.position.z).toBeCloseTo(-.06);
  // Removing a covered end must leave the free end closed.
  const end=new THREE.Raycaster(new THREE.Vector3(kind==='corner'?6:3,1.4,4),new THREE.Vector3(0,0,-1)).intersectObject(house.walls,true);
  expect(end.length).toBeGreaterThan(0);
  expect(end[0]!.point.z).toBeCloseTo(3);
 }finally{house.dispose();lib.dispose();}
});

test.each(['lower wall','opening'] as const)('an end beside a %s remains visible',async kind=>{
 const plan:Plan={version:1,name:'Exposed wall end',walls:[
  {id:'through',a:[0,0],b:[6,0],height:kind==='lower wall'?1:2.6},
  {id:'branch',a:[3,0],b:[3,3],height:2.6},
 ],openings:kind==='opening'?[{id:'gap',type:'opening',wall:'through',offset:3,width:1.2,height:2}]:[],
 materials:Object.fromEntries(Object.keys(BUILTIN).map(key=>[key,{color:'#ffffff'}]))};
 const lib=new MaterialLibrary(plan,()=>undefined),house=await buildHouse(plan,lib,{resolveUrl:()=>undefined});
 try{
  house.walls.updateMatrixWorld(true);
  const hits=new THREE.Raycaster(new THREE.Vector3(3,1.4,-1),new THREE.Vector3(0,0,1)).intersectObject(house.walls,true);
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.point.z).toBeCloseTo(-.06);
 }finally{house.dispose();lib.dispose();}
});
