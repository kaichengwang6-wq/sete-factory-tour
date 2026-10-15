import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiateMachines, instantiateAccessories } from './equipment.js';

// The source shell and placements are extracted from the supplied SketchUp model.
// New finish and equipment elements are an explicitly separate design layer.
export async function createFactoryScene(T, scene, onProgress = () => {}) {
  const [manifest, layout, sourceWindows, sourceLuminaires] = await Promise.all([
    fetch('./assets/source-manifest.json').then(r => { if (!r.ok) throw new Error('原模型清单加载失败'); return r.json(); }),
    fetch('./assets/layout.json').then(r => { if (!r.ok) throw new Error('空间布局加载失败'); return r.json(); }),
    fetch('./assets/source-inner-window-openings.json').then(r => { if (!r.ok) throw new Error('观察窗定位加载失败'); return r.json(); }),
    fetch('./assets/source-luminaire-emitting-faces.json').then(r => { if (!r.ok) throw new Error('灯具定位加载失败'); return r.json(); }),
  ]);
  // A local indirect-light approximation for the enclosed visitor circuit. It enters
  // diffuse irradiance (not emissive), so the material BRDF, AO and direct shadows remain.
  // The spatial mask prevents this warm reflected light from tinting the production floor.
  function galleryIndirect(material,strength){
    const bounds=layout.gallery??{};
    const previousCompile=material.onBeforeCompile,previousKey=material.customProgramCacheKey();
    material.userData.galleryIndirectStrength=strength;
    material.onBeforeCompile=function(shader,renderer){
      previousCompile.call(this,shader,renderer);
      shader.uniforms.galleryBounceColor={value:new T.Color(0xffd3a0)};
      shader.uniforms.galleryBounceStrength={value:strength};
      shader.uniforms.galleryInnerBounds={value:new T.Vector4(bounds.innerLeft??-43,bounds.innerRight??43,bounds.frontInnerZ??-5.4,bounds.backInnerZ??-132.1)};
      shader.uniforms.galleryBackZ={value:bounds.backZ??-136.4};
      shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vGalleryWorldPosition;')
        .replace('#include <worldpos_vertex>',`#include <worldpos_vertex>
          vec4 galleryWorldPosition=vec4(transformed,1.0);
          #ifdef USE_BATCHING
            galleryWorldPosition=batchingMatrix*galleryWorldPosition;
          #endif
          #ifdef USE_INSTANCING
            galleryWorldPosition=instanceMatrix*galleryWorldPosition;
          #endif
          vGalleryWorldPosition=(modelMatrix*galleryWorldPosition).xyz;
        `);
      shader.fragmentShader=shader.fragmentShader.replace('#include <common>',`#include <common>
        varying vec3 vGalleryWorldPosition;
        uniform vec3 galleryBounceColor;
        uniform float galleryBounceStrength;
        uniform vec4 galleryInnerBounds;
        uniform float galleryBackZ;
      `).replace('#include <lights_fragment_maps>',`#include <lights_fragment_maps>
        #if defined(RE_IndirectDiffuse)
          vec3 gp=vGalleryWorldPosition;
          float galleryOuterX=smoothstep(galleryInnerBounds.x-5.1,galleryInnerBounds.x-4.8,gp.x)*(1.0-smoothstep(galleryInnerBounds.y+4.8,galleryInnerBounds.y+5.1,gp.x));
          float galleryOuterZ=smoothstep(galleryBackZ-.12,galleryBackZ+.08,gp.z)*(1.0-smoothstep(.12,.35,gp.z));
          float galleryHallX=smoothstep(galleryInnerBounds.x-.12,galleryInnerBounds.x+.12,gp.x)*(1.0-smoothstep(galleryInnerBounds.y-.12,galleryInnerBounds.y+.12,gp.x));
          float galleryHallZ=smoothstep(galleryInnerBounds.w-.12,galleryInnerBounds.w+.12,gp.z)*(1.0-smoothstep(galleryInnerBounds.z-.12,galleryInnerBounds.z+.12,gp.z));
          float galleryHeight=smoothstep(5.00,5.11,gp.y)*(1.0-smoothstep(8.36,8.47,gp.y));
          float galleryMask=galleryOuterX*galleryOuterZ*(1.0-galleryHallX*galleryHallZ)*galleryHeight;
          irradiance+=galleryBounceColor*galleryBounceStrength*galleryMask;
        #endif
      `);
    };
    material.customProgramCacheKey=()=>`${previousKey}|gallery-indirect-v1`;
    return material;
  }
  const roofGroups = [], glassGroups = [], colliders = [];
  const loader = new GLTFLoader();
  let loaded = 0;
  // Fetch the independent building parts together so remote latency is not paid
  // once for each model. Keep insertion order deterministic for the scene.
  const sourceModels = await Promise.all(manifest.files.map(async (entry) => {
    const gltf = await loader.loadAsync(entry.url);
    loaded++;
    onProgress(loaded / (manifest.files.length + 2), `正在载入原厂房结构 · ${loaded}/${manifest.files.length}`);
    return { entry, gltf };
  }));
  for (const { entry, gltf } of sourceModels) {
    const object = gltf.scene; object.name = `Original_${entry.role}`;
    const correctedMaterials = new Set();
    object.traverse(mesh => {
      if (!mesh.isMesh) return;
      mesh.receiveShadow = true;
      mesh.castShadow = entry.role !== 'site';
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        // SketchUp RGB swatches are exported as normalized bytes; convert them once.
        if (!correctedMaterials.has(m)) {
          m.color?.convertSRGBToLinear();correctedMaterials.add(m);
          if(entry.role==='building' && m.opacity>=1 && m.isMeshStandardMaterial)galleryIndirect(m,.62);
        }
        m.roughness = Math.max(m.roughness ?? 0.7, 0.55);
        m.metalness = Math.min(m.metalness ?? 0, 0.35);
        if (m.name === 'Lampn__Emissive') {
          m.color.set(0xf7f9ff);m.emissive.set(0xf1f5ff);m.emissiveIntensity=2.2;m.roughness=.62;
        }
        if (entry.role==='upper' && /^\[Color M0[78]\]$/.test(m.name)) m.color.set(0x899093);
        if (m.opacity < 1) {
          m.transparent=true;m.opacity=Math.min(m.opacity,.18);m.depthWrite=false;
          mesh.castShadow=false;glassGroups.push(mesh);
        }
      }
    });
    scene.add(object);
    if (entry.role === 'roof' || entry.role === 'upper') roofGroups.push(object);
  }
  onProgress(.72, '正在布置精密机床与参观空间');
  const design = new T.Group(); design.name = 'Interior_design_proposal'; scene.add(design);
  const exterior = new T.Group(); exterior.name = 'Landscape_and_context'; scene.add(exterior);
  const roof = new T.Group(); roof.name = 'Proposed_roof_and_solar'; scene.add(roof); roofGroups.push(roof);
  const mats = {
    white: new T.MeshStandardMaterial({color:0xf0f2f2,roughness:.76}),
    ceiling: new T.MeshStandardMaterial({color:0xf5f6f6,roughness:.73}),
    silver: new T.MeshStandardMaterial({color:0xbdc4c7,metalness:.48,roughness:.44}),
    rib: new T.MeshStandardMaterial({color:0xd1d5d5,metalness:.30,roughness:.46,envMapIntensity:1.25}),
    dark: new T.MeshStandardMaterial({color:0x343e42,roughness:.66}),
    joint: new T.MeshStandardMaterial({color:0xadb4b7,roughness:.86}),
    line: new T.MeshStandardMaterial({color:0xc4b478,roughness:.82}),
    walkway: new T.MeshStandardMaterial({color:0xb9c0c2,roughness:.76,metalness:.02}),
    light: new T.MeshStandardMaterial({color:0xfff3df,emissive:0xffddb0,emissiveIntensity:1.65,roughness:.65}),
    workLight: new T.MeshStandardMaterial({color:0xf7f9ff,emissive:0xf1f5ff,emissiveIntensity:2.0,roughness:.65}),
    green: new T.MeshStandardMaterial({color:0x56705b,roughness:1}),
    bark: new T.MeshStandardMaterial({color:0x787467,roughness:1}),
    solar: new T.MeshStandardMaterial({color:0x263e55,metalness:.4,roughness:.35}),
  };
  // Separate gallery finishes leave work-light fixtures and exterior metalwork neutral.
  mats.galleryCeiling=galleryIndirect(mats.ceiling.clone(),.95);
  mats.gallerySilver=galleryIndirect(mats.silver.clone(),.72);
  galleryIndirect(mats.rib,.82);galleryIndirect(mats.walkway,.70);
  const boxGeo = new T.BoxGeometry(1,1,1), dummy = new T.Object3D();
  function box(parent, mat, w,h,d,x,y,z) {
    const m = new T.Mesh(boxGeo,mat); m.scale.set(w,h,d); m.position.set(x,y,z); m.receiveShadow=true; m.castShadow=true; parent.add(m); return m;
  }
  function batch(parent, mat, records, geometry=boxGeo) {
    if (!records.length) return;
    const m = new T.InstancedMesh(geometry,mat,records.length);
    records.forEach((r,i) => { dummy.position.set(r[3],r[4],r[5]); dummy.rotation.set(0,r[6]??0,0); dummy.scale.set(r[0],r[1],r[2]); dummy.updateMatrix();m.setMatrixAt(i,dummy.matrix); });
    m.receiveShadow=true; m.castShadow=true; m.computeBoundingSphere(); parent.add(m);return m;
  }
  function rectangleCollider(x,z,w,d,minY=0,maxY=3,floors=['ground']) {
    colliders.push({min:[x-w/2,minY,z-d/2],max:[x+w/2,maxY,z+d/2],floors});
  }
  function floorMaterial() {
    const c=document.createElement('canvas');c.width=c.height=512;const ctx=c.getContext('2d');
    ctx.fillStyle='#bdc3c5';ctx.fillRect(0,0,512,512);
    let seed=834;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    for(let i=0;i<19000;i++){const v=150+Math.floor(rnd()*80);ctx.fillStyle=`rgba(${v},${v},${v},.035)`;ctx.fillRect(rnd()*512,rnd()*512,1,1);}
    ctx.strokeStyle='rgba(111,123,129,.13)';ctx.lineWidth=1;ctx.strokeRect(.5,.5,511,511);
    const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;tex.wrapS=tex.wrapT=T.RepeatWrapping;tex.repeat.set(24,48);tex.anisotropy=8;
    return new T.MeshStandardMaterial({map:tex,color:0xf5f6f6,roughness:.65,metalness:.025});
  }
  box(design,floorMaterial(),95.25,.035,190.6,0,.025,-95.4).name='Finished_ground_floor';
  // The mezzanine floor itself is original geometry. A thin finish follows its perimeter.
  const g=layout.gallery??{};
  const back=g.backZ??-136.4, innerBack=g.backInnerZ??-132.1, frontInner=g.frontInnerZ??-5.4;
  const left=g.innerLeft??-43,right=g.innerRight??43;
  const finishFloor=5.115, ceilingY=8.35;
  box(design,mats.walkway,4.9,.025,-back,-45.45,finishFloor,back/2);
  box(design,mats.walkway,4.9,.025,-back,45.45,finishFloor,back/2);
  box(design,mats.walkway,86,.025,-frontInner,0,finishFloor,frontInner/2);
  box(design,mats.walkway,86,.025,Math.abs(back-innerBack),0,finishFloor,(back+innerBack)/2);

  // Continuous white aluminium ceilings, with panel joints and recessed light lines.
  const ceilingRects = [
    {x:-45.45,z:back/2,w:4.9,d:-back}, {x:45.45,z:back/2,w:4.9,d:-back},
    {x:0,z:frontInner/2,w:86,d:-frontInner}, {x:0,z:(back+innerBack)/2,w:86,d:Math.abs(back-innerBack)},
  ];
  const joints=[], led=[], ledHousing=[];
  for(const r of ceilingRects){
    box(design,mats.galleryCeiling,r.w,.09,r.d,r.x,ceilingY,r.z).name='White_aluminium_gallery_ceiling';
    if(r.d>r.w){
      for(let z=r.z-r.d/2+.9;z<r.z+r.d/2;z+=1.2) joints.push([r.w,.008,.012,r.x,ceilingY-.049,z]);
      for(const dx of [-1.2,1.2]){
        ledHousing.push([.16,.018,r.d-.3,r.x+dx,ceilingY-.061,r.z]);
        led.push([.065,.02,r.d-.5,r.x+dx,ceilingY-.077,r.z]);
      }
      joints.push([.012,.01,r.d,r.x,ceilingY-.049,r.z]);
    }else{
      for(let x=-41.5;x<42;x+=1.2) joints.push([.012,.008,r.d,x,ceilingY-.049,r.z]);
      for(const dz of [-1.1,1.1]){ledHousing.push([r.w-.2,.018,.16,r.x,ceilingY-.061,r.z+dz]);led.push([r.w-.4,.02,.065,r.x,ceilingY-.077,r.z+dz]);}
    }
  }
  batch(design,mats.joint,joints);batch(design,mats.dark,ledHousing);
  const galleryLightLines=batch(design,mats.light,led);
  galleryLightLines.name='Gallery_recessed_warm_white_lines';
  galleryLightLines.castShadow=false;galleryLightLines.receiveShadow=false;
  const glassMat = new T.MeshPhysicalMaterial({color:0xf4f8f8,metalness:0,roughness:.1,transparent:true,opacity:.035,depthWrite:false,side:T.DoubleSide});
  const ribs=[],frames=[],walls=[];
  function galleryWall(axis,constant,start,end,sourceSide){
    const alongX=axis==='x',length=end-start,center=(start+end)/2;
    const add=(arr,len,h,t,c,y)=>arr.push(alongX?[len,h,t,c,y,constant]:[t,h,len,constant,y,c]);
    // A complete metal-clad wall, with closed four-sided window reveals.
    // All parts share the same wall plane. The sill, piers and head overlap the frame.
    const base=5.105, sill=5.915, head=7.99, top=8.40, frame=.095;
    const bottomH=sill-base, topH=top-head, openingH=head-sill;
    add(walls,length,bottomH,.20,center,(base+sill)/2);
    add(walls,length,topH,.20,center,(head+top)/2);
    const ribBand=(lo,hi,y0,y1)=>{
      for(let q=lo+.025;q<hi-.015;q+=.065)add(ribs,.012,y1-y0,.218,q,(y0+y1)/2);
    };
    ribBand(start,end,base,sill);ribBand(start,end,head,top);
    const openings=sourceWindows.groups[sourceSide].map(w=>w.span)
      .filter(([a,b])=>b>start && a<end)
      .map(([a,b])=>[Math.max(start+.15,a),Math.min(end-.15,b)])
      .sort((a,b)=>a[0]-b[0]);
    let cursor=start;
    const infill=(a,b)=>{if(b-a<.005)return;add(walls,b-a,openingH,.20,(a+b)/2,(sill+head)/2);ribBand(a,b,sill,head);};
    for(const [a,b] of openings){
      infill(cursor,a);cursor=b;
      const winWidth=b-a;
      // Frame extends into the surrounding cladding on every edge, leaving no reveal gap.
      add(frames,winWidth+frame,frame,.27,(a+b)/2,sill);
      add(frames,winWidth+frame,frame,.27,(a+b)/2,head);
      add(frames,frame,openingH,.27,a,(sill+head)/2);
      add(frames,frame,openingH,.27,b,(sill+head)/2);
      const window=alongX?box(design,glassMat,winWidth-frame,openingH-frame,.025,(a+b)/2,(sill+head)/2,constant):box(design,glassMat,.025,openingH-frame,winWidth-frame,constant,(sill+head)/2,(a+b)/2);
      window.castShadow=false;window.receiveShadow=false;window.name='Observation_glass';glassGroups.push(window);
      if(winWidth>7)add(frames,.035,openingH-frame,.12,(a+b)/2,(sill+head)/2);
    }
    infill(cursor,end);
  }
  galleryWall('z',left,innerBack,frontInner,'left');
  galleryWall('z',right,innerBack,frontInner,'right');
  galleryWall('x',frontInner,left,right,'front');
  galleryWall('x',innerBack,left,right,'back');
  batch(design,mats.rib,walls);batch(design,mats.gallerySilver,ribs);batch(design,mats.gallerySilver,frames);
  // A 100 mm flush skirting finishes the solid window-wall base without changing its openings.
  const skirtingY=finishFloor+.0625;
  const skirting=batch(design,mats.gallerySilver,[
    [.035,.10,frontInner-innerBack,left-.1175,skirtingY,(frontInner+innerBack)/2],
    [.035,.10,frontInner-innerBack,right+.1175,skirtingY,(frontInner+innerBack)/2],
    [right-left,.10,.035,0,skirtingY,frontInner+.1175],
    [right-left,.10,.035,0,skirtingY,innerBack-.1175],
  ]);
  skirting.name='Gallery_100mm_metal_skirting';skirting.castShadow=false;

  // Existing equipment placeholders define each machining cell; detailed machinery is illustrative.
  const machines=[],carts=[],shadows=[],cellLines=[];
  const sourceCells=layout.equipment??[];
  for(let i=0;i<sourceCells.length;i++){
    const cell=sourceCells[i],x=cell.center[0],z=cell.center[2];
    const count=cell.depth>=6.8?2:1;
    for(let j=0;j<count;j++){
      const zz=z+(count===2?(j===0?-2.05:2.05):0),rotation=(i%2===0?0:Math.PI);
      machines.push({x,z:zz,y:.045,rotation,type:(i+j)%3});
      rectangleCollider(x,zz,2.8,3.2,.02,3.0);
      shadows.push([3.4,1,3.9,x,.052,zz]);
    }
    const halfW=Math.min(cell.width/2,2.1),halfD=Math.min(cell.depth/2,4.5);
    cellLines.push([.04,.008,halfD*2,x-halfW,.05,z],[.04,.008,halfD*2,x+halfW,.05,z],[halfW*2,.008,.04,x,.05,z-halfD],[halfW*2,.008,.04,x,.05,z+halfD]);
    if(i%3===0)carts.push({x:x+1.45,z:z+.3,rotation:Math.PI/2});
  }
  design.add(instantiateMachines(T,machines));design.add(instantiateAccessories(T,{carts,workers:[]}));
  batch(design,mats.line,cellLines);
  // Contact shadows keep industrial equipment grounded without hundreds of realtime lights.
  const sc=document.createElement('canvas');sc.width=sc.height=128;const sx=sc.getContext('2d');
  const grad=sx.createRadialGradient(64,64,10,64,64,64);grad.addColorStop(0,'rgba(30,39,42,.48)');grad.addColorStop(.55,'rgba(30,39,42,.28)');grad.addColorStop(1,'rgba(30,39,42,0)');sx.fillStyle=grad;sx.fillRect(0,0,128,128);
  const shadowGeo=new T.PlaneGeometry(1,1);shadowGeo.rotateX(-Math.PI/2);
  const shadowMat=new T.MeshBasicMaterial({map:new T.CanvasTexture(sc),transparent:true,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1});
  const shadowBatch=batch(design,shadowMat,shadows,shadowGeo);if(shadowBatch){shadowBatch.castShadow=false;shadowBatch.receiveShadow=false;}
  const columnShadows=[],seenColumnFeet=new Set();
  for(const column of layout.columns??[]){
    const a=column.min,b=column.max;if(!a||!b||a[1]>.3||b[1]<2||b[0]-a[0]>2.5||b[2]-a[2]>2.5)continue;
    const x=(a[0]+b[0])/2,z=(a[2]+b[2])/2,key=`${x.toFixed(2)},${z.toFixed(2)}`;
    if(seenColumnFeet.has(key))continue;seenColumnFeet.add(key);
    columnShadows.push([b[0]-a[0]+1.8,1,b[2]-a[2]+1.8,x,.068,z]);
  }
  const columnShadowBatch=batch(design,shadowMat,columnShadows,shadowGeo);if(columnShadowBatch){columnShadowBatch.castShadow=false;columnShadowBatch.receiveShadow=false;}

  // Main logistics strip: verified 4.4m clear corridor, with restrained edge markings.
  const aisleX=layout.mainAisle?.centerX??0;
  const lane=[];
  for(const side of [-1,1]) lane.push([.055,.012,187,aisleX+side*2.18,.058,-93.5]);
  batch(design,mats.line,lane);
  const fixtures=[],emitters=[];
  for(let z=-13;z>-164;z-=13.1){
    for(const x of [-33,-17,0,17,33]){
      fixtures.push([.24,.075,3.2,x,8.74,z]);emitters.push([.15,.03,3.0,x,8.689,z]);
    }
  }
  batch(roof,mats.silver,fixtures);
  const workLightLines=batch(roof,mats.workLight,emitters);
  workLightLines.name='Workshop_neutral_white_linear_fixtures';
  workLightLines.castShadow=false;workLightLines.receiveShadow=false;
  // The LOD lamp housing extends 3mm past its source luminous face. This overlay
  // restores the original emitting aperture 3mm below the housing, at its true plan position.
  const originalLightFaces=sourceLuminaires.lights.map(l=>[l.width,1,l.depth,l.center[0],l.proposedFaceY,l.center[2]]);
  const luminousMaterial=new T.MeshBasicMaterial({color:new T.Color(3.45,3.52,3.65),side:T.DoubleSide});
  const luminousGeometry=new T.PlaneGeometry(1,1);luminousGeometry.rotateX(Math.PI/2);
  const luminousBatch=batch(roof,luminousMaterial,originalLightFaces,luminousGeometry);
  luminousBatch.castShadow=false;luminousBatch.receiveShadow=false;
  // Approximately 4800 K design intent: neutral task light, separate from the warm visitor circuit.
  // Six existing static shadow maps retain machine/column depth; no additional shadow lights.
  for(const z of [-28,-73,-118])for(const x of [-24,24]){
    const l=new T.SpotLight(0xf1f5ff,275,60,1.22,.90,2);l.position.set(x,8.55,z);l.target.position.set(x,0,z-3);
    l.name='Workshop_neutral_task_light';l.userData.designCCT=4800;
    l.castShadow=true;l.shadow.mapSize.set(1024,1024);l.shadow.camera.near=.4;l.shadow.camera.far=58;
    l.shadow.bias=-.00012;l.shadow.normalBias=.025;l.shadow.radius=3;scene.add(l,l.target);
  }
  // Restrained neutral fill from the side walls. The task spots already cover the central aisle.
  for(const z of [-28,-73,-118])for(const x of [-41,41]){
    const l=new T.PointLight(0xf0f4ff,72,37,2);l.position.set(x,4.6,z);
    l.name='Workshop_neutral_side_fill';l.userData.designCCT=5000;scene.add(l);
  }
  // 3300 K visitor lighting: downward wide soft cones sit beneath the real inner LED lines.
  // Keeping every cone below the ceiling removes the former near-field white ceiling blobs.
  // Warm spill stays local to the gallery; the 16 unshadowed lights replace 14 points and 3 central fills.
  const galleryLightY=ceilingY-.15;
  function galleryWash(x,z,targetX,targetZ){
    const l=new T.SpotLight(0xffdfb5,28,18,1.08,1,2);
    l.name='Gallery_3300K_linear_wallwash';l.userData.designCCT=3300;
    l.position.set(x,galleryLightY,z);l.target.position.set(targetX,6.0,targetZ);
    l.castShadow=false;scene.add(l,l.target);
  }
  for(const z of [-12,-36,-60,-84,-108,-130]){
    galleryWash(left-1.25,z,left-.15,z);
    galleryWash(right+1.25,z,right+.15,z);
  }
  for(const x of [-24,24]){
    galleryWash(x,frontInner+1.6,x,frontInner+.45);
    galleryWash(x,innerBack-1.05,x,innerBack-.15);
  }
  for(const column of layout.columns??[]){
    const min=column.min,max=column.max;
    if(min&&max&&max[0]-min[0]<2.5&&max[2]-min[2]<2.5&&max[1]>1.6)colliders.push({min,max});
  }
  // The ground-floor restricted process block remains a distinct region in navigation.
  for(const wall of layout.groundWallColliders??[])colliders.push(wall);
  for(const segment of layout.groundCollisionSegments??[]){
    const a=segment.a,b=segment.b;
    if(Math.abs(a[0]-b[0])>.1 && Math.abs(a[1]-b[1])>.1)continue;
    colliders.push({min:[Math.min(a[0],b[0])-.015,.15,Math.min(a[1],b[1])-.015],max:[Math.max(a[0],b[0])+.015,2.25,Math.max(a[1],b[1])+.015],floors:['ground']});
  }
  // Raised logistics portals are a new design layer, sized to the 4.4m central aisle.
  for(const z of [.4,-18.8]){
    box(design,mats.silver,.13,4.32,.2,-2.27,2.16,z);
    box(design,mats.silver,.13,4.32,.2,2.27,2.16,z);
    box(design,mats.silver,4.67,.15,.23,0,4.38,z);
    box(design,mats.white,4.6,.37,.38,0,4.65,z);
    const portalLight=box(design,mats.workLight,4.25,.04,.065,0,4.27,z+.14);
    portalLight.castShadow=false;portalLight.receiveShadow=false;
  }

  // Roof and environmental context use lightweight instances rather than unrelated detailed assets.
  box(roof,mats.white,96.2,.22,191.4,0,25.58,-95.4);
  const panels=[],panelRails=[];
  for(let x=-44;x<44;x+=3.5)for(let z=-10;z>-180;z-=6.8){panels.push([3.25,.06,6.3,x,25.74,z]);panelRails.push([.025,.008,6.3,x,25.778,z]);for(let dz=-2;dz<=2;dz+=2)panelRails.push([3.25,.008,.018,x,25.778,z+dz]);}
  batch(roof,mats.solar,panels);batch(roof,mats.silver,panelRails);
  // Broad neutral ground and a quiet tree belt frame the selected building.
  const ground=new T.Mesh(new T.PlaneGeometry(1600,1600),new T.MeshStandardMaterial({color:0xb9c4bc,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.set(0,-.18,-70);ground.receiveShadow=true;exterior.add(ground);
  const pavement=new T.MeshStandardMaterial({color:0x7d888b,roughness:1});
  box(exterior,pavement,15,.04,272,65,-.07,-92);box(exterior,pavement,165,.04,14,0,-.07,26);box(exterior,pavement,165,.04,14,0,-.07,-212);
  const roadLines=[];for(let z=32;z>-210;z-=7)roadLines.push([.12,.01,3.2,65,-.042,z]);for(let x=-72;x<75;x+=7)roadLines.push([3.2,.01,.12,x,-.042,26]);batch(exterior,mats.ceiling,roadLines);
  const trunks=[],crowns=[];
  for(let i=0;i<33;i++){const z=18-i*7.5;for(const x of [-83,78]){trunks.push([.35,3.8,.35,x,1.8,z]);crowns.push([2.0,2.7,2.0,x,4.8,z]);}}
  batch(exterior,mats.bark,trunks);batch(exterior,mats.green,crowns,new T.IcosahedronGeometry(1,1));
  // The adjacent glass block is context only, without invented interior floors.
  const ctxGlass=new T.MeshStandardMaterial({color:0x90a9b5,metalness:.35,roughness:.3});
  const cx=11,cz=45;
  box(exterior,ctxGlass,70,12,23,cx,6,cz);
  box(exterior,mats.white,71,.35,24,cx,12.1,cz);
  const mullions=[];for(let x=cx-35;x<=cx+35;x+=2.5){mullions.push([.10,12,.16,x,6,cz+11.6],[.10,12,.16,x,6,cz-11.6]);}for(let y=1;y<12;y+=3.7)mullions.push([70,.12,.16,cx,y,cz+11.6]);batch(exterior,mats.silver,mullions);

  // Minimal wayfinding printed in the actual model, not fabricated live process metrics.
  function label(text,sub,width=6){
    const c=document.createElement('canvas');c.width=1024;c.height=256;const x=c.getContext('2d');x.fillStyle='#edf1f1';x.fillRect(0,0,1024,256);x.fillStyle='#34434a';x.font='500 72px "Microsoft YaHei", sans-serif';x.fillText(text,50,114);x.fillStyle='#7a8b91';x.font='24px Arial';x.fillText(sub,52,179);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return new T.Mesh(new T.PlaneGeometry(width,width/4),new T.MeshStandardMaterial({map:tex,roughness:.8}));
  }
  const sign=label('塞特精工','PRECISION MANUFACTURING',12);sign.position.set(0,6.3,.55);scene.add(sign);
  const gallerySign=label('参观通道','OBSERVATION GALLERY',3.8);gallerySign.position.set(-47.35,6.7,-11);gallerySign.rotation.y=Math.PI/2;design.add(gallerySign);
  // Small process-view labels are mounted on the existing solid sill bands, never across glass.
  for(const [text,sub,z,side] of [
    ['01  精密加工','PRECISION MACHINING',-22,-1],
    ['02  机床阵列','MACHINING CELLS',-70,-1],
    ['03  物流主轴','LOGISTICS SPINE',-116,1],
  ]){
    const plaque=label(text,sub,1.6);
    plaque.position.set(side<0?left-.137:right+.137,5.59,z);
    plaque.rotation.y=side*Math.PI/2;plaque.name='Gallery_process_view_label';
    plaque.receiveShadow=true;plaque.castShadow=false;design.add(plaque);
  }
  onProgress(1,'三维空间已准备就绪');
  return {roofGroups,glassGroups,colliders,layout,sourceManifest:manifest,design,metadata:{cells:sourceCells.length,machines:machines.length,mezzanineLevel:5.1}};
}
