import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { instantiateMachines, instantiateAccessories } from './equipment.js';

// The source shell and placements are extracted from the supplied SketchUp model.
// New finish and equipment elements are an explicitly separate design layer.
export async function createFactoryScene(T, scene, onProgress = () => {}) {
  const [manifest, layout, sourceWindows, sourceLuminaires, sourceRoof] = await Promise.all([
    fetch('./assets/source-manifest.json?v=20261016-model1').then(r => { if (!r.ok) throw new Error('原模型清单加载失败'); return r.json(); }),
    fetch('./assets/layout.json?v=20261016-model1').then(r => { if (!r.ok) throw new Error('空间布局加载失败'); return r.json(); }),
    fetch('./assets/source-inner-window-openings.json?v=20261016-model1').then(r => { if (!r.ok) throw new Error('观察窗定位加载失败'); return r.json(); }),
    fetch('./assets/source-industrial-lights.json?v=20261016-model1').then(r => { if (!r.ok) throw new Error('灯具定位加载失败'); return r.json(); }),
    fetch('./assets/source-roof-layout.json?v=20261016-model1').then(r => { if (!r.ok) throw new Error('屋面定位加载失败'); return r.json(); }),
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
    const gltf = await loader.loadAsync(`${entry.url}?v=20261016-model1`);
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
          if(['building','gallery'].includes(entry.role) && m.opacity>=1 && m.isMeshStandardMaterial)galleryIndirect(m,.62);
        }
        m.roughness = Math.max(m.roughness ?? 0.7, 0.55);
        m.metalness = Math.min(m.metalness ?? 0, 0.35);
        if (entry.role === 'industrial-lights') { m.roughness=.48;m.metalness=.38; }
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
  const exterior = new T.Group(); exterior.name = 'Neutral_presentation_ground'; scene.add(exterior);
  const roof = new T.Group(); roof.name = 'Roof_solar_panels'; scene.add(roof); roofGroups.push(roof);
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
  // The new SKP supplies the one authoritative wall and frame assembly, including
  // its actual openings and the upper boundary at 8.85 m. Do not overlay new walls.
  const sourceGallery=scene.getObjectByName('Original_gallery');
  if(!sourceGallery)throw new Error('参观廊原模型资源缺失。');
  const finishedGalleryMaterials=new Set();
  sourceGallery.traverse(mesh=>{
    if(!mesh.isMesh)return;
    mesh.userData.sourceGallery=true;
    for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
      if(finishedGalleryMaterials.has(material))continue;
      finishedGalleryMaterials.add(material);
      const silverFrame=/^\[Color M0[17]\]$/.test(material.name);
      // Keep the existing indirect-light shader hook while changing only the finish.
      material.color.set(silverFrame?0xc0c7ca:0xf1f0ec);
      material.metalness=silverFrame ? .55 : .015;
      material.roughness=silverFrame ? .43 : .86;
      material.envMapIntensity=silverFrame ? .65 : .75;
      material.userData.galleryFinish=silverFrame?'silver_frame':'matte_white_wall';
      material.needsUpdate=true;
    }
  });
  const glassMat=new T.MeshPhysicalMaterial({color:0xf5f8f8,metalness:0,roughness:.14,
    transparent:true,opacity:.035,depthWrite:false,side:T.DoubleSide,
    ior:1.45,reflectivity:.12,specularIntensity:.12,envMapIntensity:.18});
  glassMat.forceSinglePass=true;
  const glassGeometry=new T.PlaneGeometry(1,1),seenWindowBounds=new Set();
  const observationGlazing=new T.Group();observationGlazing.name='Source_observation_glazing';design.add(observationGlazing);
  for(const [side,windows] of Object.entries(sourceWindows.groups)){
    for(const opening of windows){
      const {min,max,clearMin,clearMax}=opening;
      if(![min,max,clearMin,clearMax].every(v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite)))
        throw new Error('观察窗净尺寸缺失，请更新模型资源。');
      const key=[...min,...max].map(v=>v.toFixed(5)).join(',');
      if(seenWindowBounds.has(key))continue;
      seenWindowBounds.add(key);
      const alongZ=side==='left'||side==='right',spanAxis=alongZ?2:0;
      const width=clearMax[spanAxis]-clearMin[spanAxis],height=clearMax[1]-clearMin[1];
      if(width<=0||height<=0)throw new Error('观察窗净尺寸无效。');
      const pane=new T.Mesh(glassGeometry,glassMat);
      // A 1 mm overlap under each source reveal closes the glazing edge without
      // changing the visible opening; one plane avoids doubled glass reflections.
      pane.scale.set(width+.002,height+.002,1);
      pane.position.set((min[0]+max[0])/2,(clearMin[1]+clearMax[1])/2,(min[2]+max[2])/2);
      pane.position.setComponent(spanAxis,(clearMin[spanAxis]+clearMax[spanAxis])/2);
      if(alongZ)pane.rotation.y=Math.PI/2;
      pane.name='Observation_glass';pane.userData.sourceWindow=opening.id??opening.path;
      pane.userData.clearMin=[...clearMin];pane.userData.clearMax=[...clearMax];
      pane.castShadow=false;pane.receiveShadow=false;pane.renderOrder=3;
      observationGlazing.add(pane);glassGroups.push(pane);
    }
  }
  observationGlazing.userData.windowCount=seenWindowBounds.size;
  // The navigation ring remains authoritative. These same 200 mm source wall
  // boundaries also prevent walking through glazing, and apply only upstairs.
  const galleryFloor=g.floorTop??5.1,galleryWallTop=9.85,galleryWallThickness=sourceWindows.wallThickness??.2;
  rectangleCollider(left+galleryWallThickness/2,(innerBack+frontInner)/2,galleryWallThickness,frontInner-innerBack,galleryFloor,galleryWallTop,['mezzanine']);
  rectangleCollider(right-galleryWallThickness/2,(innerBack+frontInner)/2,galleryWallThickness,frontInner-innerBack,galleryFloor,galleryWallTop,['mezzanine']);
  rectangleCollider((left+right)/2,frontInner-galleryWallThickness/2,right-left,galleryWallThickness,galleryFloor,galleryWallTop,['mezzanine']);
  rectangleCollider((left+right)/2,innerBack+galleryWallThickness/2,right-left,galleryWallThickness,galleryFloor,galleryWallTop,['mezzanine']);
  // A 100 mm flush skirting finishes the solid window-wall base without changing its openings.
  const skirtingY=finishFloor+.0625;
  const skirting=batch(design,mats.gallerySilver,[
    [.035,.10,frontInner-innerBack,left-.0175,skirtingY,(frontInner+innerBack)/2],
    [.035,.10,frontInner-innerBack,right+.0175,skirtingY,(frontInner+innerBack)/2],
    [right-left,.10,.035,0,skirtingY,frontInner+.0175],
    [right-left,.10,.035,0,skirtingY,innerBack-.0175],
  ]);
  skirting.name='Gallery_100mm_metal_skirting';skirting.castShadow=false;

  // Existing equipment placeholders define each machining cell; detailed machinery is illustrative.
  const machines=[],carts=[],shadows=[],cellLines=[];
  const sourceCells=layout.equipment??[];
  for(let i=0;i<sourceCells.length;i++){
    const cell=sourceCells[i],x=cell.center[0],z=cell.center[2],displayIndex=cell.displayIndex??i;
    const count=cell.depth>=6.8?2:1;
    for(let j=0;j<count;j++){
      const zz=z+(count===2?(j===0?-2.05:2.05):0),rotation=(displayIndex%2===0?0:Math.PI);
      machines.push({x,z:zz,y:.045,rotation,type:(displayIndex+j)%3});
      rectangleCollider(x,zz,2.8,3.2,.02,3.0);
      shadows.push([3.4,1,3.9,x,.052,zz]);
    }
    const halfW=Math.min(cell.width/2,2.1),halfD=Math.min(cell.depth/2,4.5);
    cellLines.push([.04,.008,halfD*2,x-halfW,.05,z],[.04,.008,halfD*2,x+halfW,.05,z],[halfW*2,.008,.04,x,.05,z-halfD],[halfW*2,.008,.04,x,.05,z+halfD]);
    if(displayIndex%3===0)carts.push({x:x+1.45,z:z+.3,rotation:Math.PI/2});
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
  // Each luminous aperture belongs to one unique pendant from the revised SKP.
  // The source housing uses shared geometry; no extra visible fixtures are invented.
  const lightGroup=new T.Group();lightGroup.name='Workshop_source_light_apertures';design.add(lightGroup);
  const originalLightFaces=sourceLuminaires.lights.map(l=>[
    l.emitterRadius,1,l.emitterRadius,l.emitterCenter[0],l.emitterCenter[1]-.003,l.emitterCenter[2],
  ]);
  const luminousMaterial=new T.MeshBasicMaterial({color:new T.Color(3.45,3.52,3.65),side:T.DoubleSide});
  const luminousGeometry=new T.CircleGeometry(1,32);luminousGeometry.rotateX(Math.PI/2);
  const luminousBatch=batch(lightGroup,luminousMaterial,originalLightFaces,luminousGeometry);
  luminousBatch.name='Source_378_white_light_apertures';
  luminousBatch.castShadow=false;luminousBatch.receiveShadow=false;
  // Sample the real lamp positions for bounded realtime lighting. All 378 apertures
  // remain visible, while six static shadow maps model the combined task illumination.
  function nearestLamp(x,z){
    return sourceLuminaires.lights.reduce((best,light)=>
      Math.hypot(light.emitterCenter[0]-x,light.emitterCenter[2]-z)<Math.hypot(best.emitterCenter[0]-x,best.emitterCenter[2]-z)?light:best
    );
  }
  for(const z of [-28,-73,-118])for(const x of [-24,24]){
    const source=nearestLamp(x,z),p=source.emitterCenter;
    const l=new T.SpotLight(0xf1f5ff,275,60,1.22,.90,2);l.position.set(p[0],p[1]-.035,p[2]);l.target.position.set(p[0],0,p[2]);
    l.name='Workshop_source_4800K_task_light';l.userData.designCCT=4800;l.userData.sourceId=source.id;
    l.castShadow=true;l.shadow.mapSize.set(1024,1024);l.shadow.camera.near=.4;l.shadow.camera.far=58;
    l.shadow.bias=-.00012;l.shadow.normalBias=.025;l.shadow.radius=3;scene.add(l,l.target);
  }
  // Broad bounced light uses the outer source fixtures, with no new wall-mounted fittings.
  for(const z of [-28,-73,-118])for(const x of [-41,41]){
    const source=nearestLamp(x,z),p=source.emitterCenter;
    const l=new T.PointLight(0xf1f5ff,72,37,2);l.position.set(p[0],p[1]-.035,p[2]);
    l.name='Workshop_source_4800K_bounce';l.userData.designCCT=4800;l.userData.sourceId=source.id;scene.add(l);
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
  }

  // The actual roof is supplied by the revised model at +23.60 m. Solar panels
  // sit directly above it and leave the new rooftop structure unobstructed.
  const panels=[],panelRails=[];
  const roofTop=sourceRoof.roofPlane.y;
  const roofObstacles=[...sourceRoof.obstacles.map(o=>o.web_bounds_m),...sourceRoof.rootAppendages.map(o=>o.bounds)];
  for(let x=-44;x<44;x+=3.5)for(let z=-10;z>-180;z-=6.8){
    if(roofObstacles.some(([min,max])=>x+1.625>min[0]-.5 && x-1.625<max[0]+.5 && z+3.15>min[2]-.5 && z-3.15<max[2]+.5))continue;
    panels.push([3.25,.06,6.3,x,roofTop+.10,z]);panelRails.push([.025,.008,6.3,x,roofTop+.138,z]);
    for(let dz=-2;dz<=2;dz+=2)panelRails.push([3.25,.008,.018,x,roofTop+.138,z+dz]);
  }
  batch(roof,mats.solar,panels);batch(roof,mats.silver,panelRails);
  const ground=new T.Mesh(new T.PlaneGeometry(1600,1600),new T.MeshStandardMaterial({color:0xd2d5d6,roughness:1}));
  ground.name='Plain_light_gray_shadow_ground';ground.rotation.x=-Math.PI/2;ground.position.set(0,-.18,-70);ground.receiveShadow=true;exterior.add(ground);

  // Minimal wayfinding printed in the actual model, not fabricated live process metrics.
  function label(text,sub,width=6){
    const c=document.createElement('canvas');c.width=1024;c.height=256;const x=c.getContext('2d');x.fillStyle='#edf1f1';x.fillRect(0,0,1024,256);x.fillStyle='#34434a';x.font='500 72px "Microsoft YaHei", sans-serif';x.fillText(text,50,114);x.fillStyle='#7a8b91';x.font='24px Arial';x.fillText(sub,52,179);const tex=new T.CanvasTexture(c);tex.colorSpace=T.SRGBColorSpace;return new T.Mesh(new T.PlaneGeometry(width,width/4),new T.MeshStandardMaterial({map:tex,roughness:.8}));
  }
  const logoTexture=await new T.TextureLoader().loadAsync('./assets/sat-logo.png');
  logoTexture.colorSpace=T.SRGBColorSpace;logoTexture.anisotropy=8;
  const logoMaterial=new T.MeshStandardMaterial({map:logoTexture,roughness:.78,metalness:0});
  function brandSign(width,name){
    const sign=new T.Mesh(new T.PlaneGeometry(width,width*129/476),logoMaterial);
    sign.name=name;sign.receiveShadow=true;return sign;
  }
  const sign=brandSign(12,'SAT_entrance_sign');sign.position.set(0,6.3,.55);scene.add(sign);
  // Preserve the original rear facade sign's position and height, with the artwork
  // fitted proportionally instead of stretching it across the old wide image panel.
  const [signMin,signMax]=sourceRoof.removedSignBounds[0];
  const rearSign=brandSign((signMax[1]-signMin[1])*476/129,'SAT_original_rear_facade_sign');
  rearSign.position.set((signMin[0]+signMax[0])/2,(signMin[1]+signMax[1])/2,signMin[2]-.005);rearSign.rotation.y=Math.PI;scene.add(rearSign);roofGroups.push(rearSign);
  const gallerySign=label('参观通道','OBSERVATION GALLERY',3.8);gallerySign.position.set(-47.35,6.7,-11);gallerySign.rotation.y=Math.PI/2;design.add(gallerySign);
  // Small process-view labels are mounted on the existing solid sill bands, never across glass.
  for(const [text,sub,z,side] of [
    ['01  精密加工','PRECISION MACHINING',-22,-1],
    ['02  机床阵列','MACHINING CELLS',-70,-1],
    ['03  物流主轴','LOGISTICS SPINE',-116,1],
  ]){
    const plaque=label(text,sub,1.6);
    plaque.position.set(side<0?left-.003:right+.003,5.59,z);
    plaque.rotation.y=side*Math.PI/2;plaque.name='Gallery_process_view_label';
    plaque.receiveShadow=true;plaque.castShadow=false;design.add(plaque);
  }
  onProgress(1,'三维空间已准备就绪');
  return {roofGroups,glassGroups,colliders,layout,sourceManifest:manifest,design,metadata:{cells:sourceCells.length,machines:machines.length,mezzanineLevel:5.1,sourceLamps:sourceLuminaires.count,revision:'20261016',homepageBackground:'unchanged'}};
}
