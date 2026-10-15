import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createAmbientOcclusion } from './ambient-occlusion.js';
import { createFloorReflection } from './floor-reflection.js';
import { NAVIGATION, STAGES, normalizeColliders, moveWithCollision, findSafeLanding, isBlocked } from './navigation.js?v=20261015-delivery2';
import { sampleAutoRoute, auditAutoRoutes, AUTO_TOUR_SPEED } from './auto-tour.js?v=20261015-delivery2';
import { createBgmController } from './bgm.js?v=20261015-bgm1';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const keys = new Set();
const clock = new THREE.Clock();
let renderer, scene, camera, orbit, model, ambientOcclusion, floorReflection, colliders = [], currentStage = 0, floor = 'aerial';
let yaw = 0, pitch = 0, ready = false, roofHidden = false, uiHidden = false, dragging = false;
let frames = 0, fps = 0, fpsElapsed = 0, elapsed = 0, toastTimer = 0, transitionToken = 0;
let stats = { triangles: 0, drawcalls: 0 }, pointer = { x: 0, y: 0 };
let renderScale = 1, rendererName = 'unknown', totalRenderedFrames = 0;
let lowFpsSeconds = 0, adaptiveGraceUntil = 0;
let fullscreenPending = false;
let autoPlaying=false, autoTime=0, autoPauseReason='initial', autoBlockedSeconds=0, transitioning=false;
let routeAudit=null, lookPointerId=null, joystickPointerId=null;
const joystickAxes={x:0,y:0};
const autoLookCamera=new THREE.PerspectiveCamera(), autoTarget=new THREE.Vector3();
const autoEuler=new THREE.Euler(0,0,0,'YXZ');
const RENDER_SCALES = [1, 0.9, 0.8, 0.72, 0.65];
const vecForward = new THREE.Vector3(), tempDirection = new THREE.Vector3();
const loadingErrors = [];
const bgm = createBgmController({ onFocus: () => { keys.clear(); resetJoystick(); } });

function announce(message, duration = 2400) {
  $('toast').textContent = message;
  $('toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.remove('visible'), duration);
}

function progress(value, text) {
  let fraction = value, label = text;
  if (typeof value === 'object' && value !== null) {
    fraction = value.progress ?? value.fraction ?? (value.total ? value.loaded / value.total : undefined);
    label = value.message ?? value.label ?? text;
  }
  if (typeof value === 'string') { label = value; fraction = undefined; }
  if (Number.isFinite(fraction)) $('progressBar').style.width = `${Math.max(5, Math.min(96, fraction > 1 ? fraction : fraction * 100))}%`;
  if (label) $('loadingMessage').textContent = label;
}

function updateInterface() {
  const stage = STAGES[currentStage];
  $('stageTitle').textContent = stage.title;
  $('stageDescription').textContent = stage.description;
  $('stageNumber').textContent = `${String(currentStage + 1).padStart(2, '0')} / ${String(STAGES.length).padStart(2, '0')}`;
  $('sceneEnglish').textContent = stage.english;
  $('sceneChinese').textContent = stage.caption;
  $('floorBadge').textContent = floor === 'aerial' ? '厂区鸟瞰' : floor === 'ground' ? '一层 · 生产空间' : '夹层 · 参观空间';
  $('viewBadge').textContent = floor === 'aerial' ? '整体视角' : floor === 'ground' ? `展示视点 +${(NAVIGATION.groundY + NAVIGATION.groundEyeHeight).toFixed(2)} m` : '楼面标高 +5.10 m';
  $('hintText').textContent = floor === 'aerial' ? '拖动旋转 · 滚轮缩放' : '拖动观察 · Shift 加速';
  document.body.dataset.floor=floor;
  $('previousButton').disabled = currentStage === 0;
  $('nextButton').disabled = currentStage === STAGES.length - 1;
  $('playLabel').textContent = currentStage === 0 ? '开始演示' : currentStage === STAGES.length - 1 ? '回到鸟瞰' : '下一处空间';
  document.querySelectorAll('.stage-button').forEach((button, index) => {
    button.classList.toggle('current', index === currentStage);
    button.classList.toggle('passed', index < currentStage);
    button.setAttribute('aria-current', index === currentStage ? 'step' : 'false');
  });
  for (const [id, value] of [['aerialButton', 'aerial'], ['groundButton', 'ground'], ['mezzButton', 'mezzanine']]) {
    $(id).classList.toggle('active', floor === value);
    $(id).setAttribute('aria-pressed', String(floor === value));
  }
  $('roofButton').disabled = floor !== 'aerial';
  $('roofButton').title = floor === 'aerial' ? '鸟瞰时隐藏上部建筑与屋面' : '进入鸟瞰后可剖开屋面';
  $('roofButton').setAttribute('aria-pressed', String(roofHidden));
  $('roofLabel').textContent = roofHidden ? '恢复屋面' : '剖开屋面';
  updateAutoInterface();
}

function updateAutoInterface() {
  const label=autoPlaying?'关闭自动漫游':'开启自动漫游';
  for(const [buttonId,labelId] of [['autoTourButton','autoTourLabel'],['touchPauseButton','touchPauseLabel']]){
    const button=$(buttonId),text=$(labelId);if(!button)continue;
    if(text)text.textContent=label;
    button.setAttribute('aria-label',label);button.setAttribute('aria-pressed',String(autoPlaying));
    button.setAttribute('aria-checked',String(autoPlaying));
    button.classList.toggle('is-playing',autoPlaying);
  }
  const status=$('autoTourStatus');
  if(status){
    const route=sampleAutoRoute(STAGES[currentStage].id,autoTime);
    status.textContent=autoPlaying?`自动漫游 · ${route.holding?'观景停留':route.returning?'缓缓返回':'沿线前行'}`:autoPauseReason==='manual'?'手动浏览 · 漫游已关闭':'漫游已关闭 · 手动开启';
  }
}

function pauseAuto(reason='button') {
  autoPlaying=false;autoPauseReason=reason;autoBlockedSeconds=0;
  if(orbit)orbit.enabled=floor==='aerial';
  updateAutoInterface();
}

function toggleAuto() {
  if(!ready||transitioning)return;
  if(autoPlaying){pauseAuto();return;}
  void bgm.beginFromInteraction();
  if(autoPauseReason==='manual'){setStage(currentStage,{autoStart:true});return;}
  autoPlaying=true;autoPauseReason='';autoBlockedSeconds=0;
  if(orbit)orbit.enabled=false;
  keys.clear();resetJoystick();updateAutoInterface();
}

function updateAuto(delta) {
  if(!autoPlaying||transitioning||document.hidden||$('referenceDialog').open)return;
  autoTime+=delta*AUTO_TOUR_SPEED;
  const sample=sampleAutoRoute(STAGES[currentStage].id,autoTime),p=sample.position;
  if(floor==='aerial')camera.position.set(...p);
  else{
    moveWithCollision(camera.position,p[0]-camera.position.x,p[2]-camera.position.z,floor,colliders);
    if(Math.hypot(camera.position.x-p[0],camera.position.z-p[2])>.18)autoBlockedSeconds+=delta;
    else autoBlockedSeconds=0;
    if(autoBlockedSeconds>1.1){pauseAuto('manual');announce('前方有障碍，漫游已暂停。可复位后重新漫游。',4000);return;}
  }
  autoLookCamera.position.copy(camera.position);autoTarget.set(...sample.target);autoLookCamera.lookAt(autoTarget);
  camera.quaternion.slerp(autoLookCamera.quaternion,1-Math.exp(-delta*3.8));
  autoEuler.setFromQuaternion(camera.quaternion,'YXZ');yaw=autoEuler.y;pitch=autoEuler.x;
  orbit.target.copy(autoTarget);
}

function applyRoofState() {
  if (!model) return;
  let changed = false;
  for (const object of model.roofGroups ?? []) {
    changed ||= object.visible !== !roofHidden;
    object.visible = !roofHidden;
  }
  if (changed && renderer) renderer.shadowMap.needsUpdate = true;
  if (floorReflection) {floorReflection.enabled=floor!=='aerial'||roofHidden;floorReflection.invalidate();}
}

function setRenderScale(value) {
  renderScale = THREE.MathUtils.clamp(value, 0.65, 1);
  if (renderer) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5) * renderScale);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
  lowFpsSeconds = 0;
  adaptiveGraceUntil = performance.now() + 2000;
}

function adaptRendering(sampleFps, sampleSeconds) {
  if (document.hidden || performance.now() < adaptiveGraceUntil) { lowFpsSeconds = 0; return; }
  lowFpsSeconds = sampleFps < 28 ? lowFpsSeconds + sampleSeconds : 0;
  if (lowFpsSeconds >= 3 && renderScale > 0.65) {
    const nextScale = RENDER_SCALES.find((scale) => scale < renderScale - 0.01) ?? 0.65;
    setRenderScale(nextScale);
  }
}

function lookAtTarget(target) {
  camera.lookAt(new THREE.Vector3(...target));
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  yaw = euler.y; pitch = euler.x;
}

async function setStage(index, { immediate = false, autoStart = autoPlaying } = {}) {
  if (!ready || index < 0 || index >= STAGES.length) return false;
  const token = ++transitionToken;
  transitioning=true;autoPlaying=false;resetJoystick();
  keys.clear();
  dragging = false;lookPointerId=null;
  const stage = STAGES[index];
  let landing;
  try { landing = findSafeLanding(stage.position, stage.floor, colliders); }
  catch (error) { transitioning=false;announce(error.message, 4500); loadingErrors.push(error.message); return false; }
  if (!immediate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    viewport.style.transition = 'opacity 180ms ease';
    viewport.style.opacity = '0.16';
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (token !== transitionToken) return false;
  }
  currentStage = index; floor = stage.floor;
  autoTime=0;autoBlockedSeconds=0;autoPlaying=autoStart;autoPauseReason=autoStart?'':'initial';
  adaptiveGraceUntil = performance.now() + 1500;
  lowFpsSeconds = 0;
  if (floor !== 'aerial') roofHidden = false;
  applyRoofState();
  renderer.shadowMap.needsUpdate = true;
  camera.position.set(...landing);
  camera.fov = floor === 'aerial' ? 47 : 68;
  camera.near = floor === 'aerial' ? 1.0 : .08;
  camera.far = floor === 'aerial' ? 1700 : 400;
  camera.updateProjectionMatrix();
  orbit.enabled = floor === 'aerial'&&!autoPlaying;
  orbit.target.set(...stage.target);
  lookAtTarget(stage.target);
  if (orbit.enabled) orbit.update();
  updateInterface();
  drawMap();
  viewport.style.opacity = '1';
  transitioning=false;
  document.body.classList.remove('stage-menu-open');$('stageMenuButton')?.setAttribute('aria-expanded','false');
  return true;
}

function toggleMap(force) {
  const isVisible = force ?? $('minimapPanel').hidden;
  $('minimapPanel').hidden = !isVisible;
  $('mapButton').setAttribute('aria-pressed', String(isVisible));
  $('mapButton').setAttribute('aria-label', isVisible ? '收起空间定位图' : '显示空间定位图');
  if (isVisible && ready) drawMap();
}

function toggleInterface(force) {
  uiHidden = force ?? !uiHidden;
  document.body.classList.toggle('ui-hidden', uiHidden);
  $('restoreButton').hidden = !uiHidden;
}

async function toggleFullscreen() {
  if (fullscreenPending) return;
  fullscreenPending = true;
  let timeout;
  try {
    const request = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    await Promise.race([
      request,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Fullscreen request timed out')), 2200); }),
    ]);
  } catch { announce('当前窗口无法切换全屏，可按浏览器 F11 进入全屏展示'); }
  finally { clearTimeout(timeout); fullscreenPending = false; }
}

function enterStageFromInteraction(index) {
  if (ready) void bgm.beginFromInteraction();
  return setStage(index);
}

function configureUI() {
  STAGES.forEach((stage, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'stage-button';
    button.innerHTML = `<span class="stage-index">${String(index + 1).padStart(2, '0')}</span><span class="stage-label">${stage.label}</span><span class="stage-indicator"></span>`;
    button.addEventListener('click', () => enterStageFromInteraction(index));
    $('stageList').appendChild(button);
  });
  $('playButton').addEventListener('click', () => enterStageFromInteraction(currentStage === STAGES.length - 1 ? 0 : currentStage + 1));
  $('nextButton').addEventListener('click', () => enterStageFromInteraction(Math.min(STAGES.length - 1, currentStage + 1)));
  $('previousButton').addEventListener('click', () => enterStageFromInteraction(Math.max(0, currentStage - 1)));
  $('aerialButton').addEventListener('click', () => enterStageFromInteraction(0));
  $('groundButton').addEventListener('click', () => enterStageFromInteraction(1));
  $('mezzButton').addEventListener('click', () => enterStageFromInteraction(3));
  $('resetButton').addEventListener('click', () => { setStage(currentStage); announce('已复位当前观景视角'); });
  $('roofButton').addEventListener('click', () => {
    if (!ready || floor !== 'aerial') return;
    roofHidden = !roofHidden; applyRoofState(); updateInterface();
    announce(roofHidden ? '已剖开上部建筑与屋面，显示内部空间' : '已恢复完整建筑外观');
  });
  $('mapButton').addEventListener('click', () => toggleMap());
  $('closeMap').addEventListener('click', () => toggleMap(false));
  $('hideButton').addEventListener('click', () => toggleInterface(true));
  $('restoreButton').addEventListener('click', () => toggleInterface(false));
  $('fullscreenButton').addEventListener('click', toggleFullscreen);
  $('autoTourButton')?.addEventListener('click',toggleAuto);
  $('touchPauseButton')?.addEventListener('click',toggleAuto);
  $('stageMenuButton')?.addEventListener('click',()=>{
    const expanded=document.body.classList.toggle('stage-menu-open');
    $('stageMenuButton').setAttribute('aria-expanded',String(expanded));
  });
  $('retryButton').addEventListener('click', () => location.reload());
  const dialog = $('referenceDialog');
  $('referenceButton').addEventListener('click', () => { keys.clear();resetJoystick();if(autoPlaying)pauseAuto();dialog.showModal(); });
  $('closeReference').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  const references = {
    aerial: ['reference-aerial.jpg', '原方案厂房鸟瞰效果图', '左侧大体量厂房为本次展示主体。'],
    workshop: ['reference-workshop.jpg', '原方案生产车间效果图', '参考白色梁柱、银白机床与明亮有序的生产空间。'],
    window: ['reference-window.png', '原方案观察窗界面效果图', '参考银灰金属围护与横向观察窗，网页模型按实际夹层高度呈现俯视关系。'],
  };
  document.querySelectorAll('[data-reference]').forEach((button) => button.addEventListener('click', () => {
    const data = references[button.dataset.reference];
    $('referenceImage').src = `./assets/${data[0]}`; $('referenceImage').alt = data[1]; $('referenceCaption').textContent = data[2];
    document.querySelectorAll('[data-reference]').forEach((item) => item.classList.toggle('active', item === button));
  }));
  document.addEventListener('fullscreenchange', () => {
    $('fullscreenButton').setAttribute('aria-label', document.fullscreenElement ? '退出全屏' : '进入全屏');
    $('fullscreenButton').setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
  });
  updateInterface();
}

function installControls() {
  viewport.addEventListener('pointerdown', (event) => {
    if (!ready || event.button !== 0 || $('referenceDialog').open || lookPointerId!==null) return;
    pauseAuto('manual');
    if(floor==='aerial')return;
    lookPointerId=event.pointerId;
    event.preventDefault();
    dragging = true; pointer.x = event.clientX; pointer.y = event.clientY;
    viewport.setPointerCapture(event.pointerId); viewport.focus({ preventScroll: true });
  },{capture:true});
  viewport.addEventListener('pointermove', (event) => {
    if (!dragging || floor === 'aerial' || event.pointerId!==lookPointerId) return;
    yaw -= (event.clientX - pointer.x) * 0.0026;
    pitch = THREE.MathUtils.clamp(pitch - (event.clientY - pointer.y) * 0.0023, -1.42, 1.42);
    pointer.x = event.clientX; pointer.y = event.clientY;
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
  });
  const stopLook=event=>{if(event.pointerId===lookPointerId){dragging=false;lookPointerId=null;}};
  viewport.addEventListener('pointerup',stopLook);
  viewport.addEventListener('pointercancel',stopLook);
  viewport.addEventListener('lostpointercapture',stopLook);
  viewport.addEventListener('wheel',()=>{if(floor==='aerial'&&ready)pauseAuto('manual');},{passive:true});
  window.addEventListener('blur', () => { keys.clear(); dragging = false;lookPointerId=null;resetJoystick(); });
  document.addEventListener('visibilitychange', () => { keys.clear();resetJoystick(); });
  document.addEventListener('keydown', (event) => {
    if (!ready || $('referenceDialog').open || event.ctrlKey || event.metaKey || event.altKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift'].includes(key)) {
      if (floor !== 'aerial') { event.preventDefault();pauseAuto('manual'); keys.add(key); }
      return;
    }
    if (event.repeat) return;
    if(key===' '){event.preventDefault();toggleAuto();}
    else if (key === 'h') toggleInterface();
    else if (key === 'm') toggleMap();
    else if (key === 'f') toggleFullscreen();
    else if (key === 'r') setStage(currentStage);
    else if (key === 'pagedown') { event.preventDefault(); enterStageFromInteraction(Math.min(STAGES.length - 1, currentStage + 1)); }
    else if (key === 'pageup') { event.preventDefault(); enterStageFromInteraction(Math.max(0, currentStage - 1)); }
    else if (key === 'escape') { keys.clear();resetJoystick(); dragging = false;document.body.classList.remove('stage-menu-open');$('stageMenuButton')?.setAttribute('aria-expanded','false');if (uiHidden) toggleInterface(false); }
  });
  document.addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
  installJoystick();
}

function resetJoystick(){
  joystickAxes.x=0;joystickAxes.y=0;joystickPointerId=null;
  $('joystickKnob')?.style.setProperty('transform','translate(0px, 0px)');
  $('moveJoystick')?.classList.remove('is-active');
}

function installJoystick(){
  const joystick=$('moveJoystick');if(!joystick)return;
  function update(event){
    const rect=joystick.getBoundingClientRect(),radius=Math.min(rect.width,rect.height)*.30;
    let dx=event.clientX-rect.left-rect.width/2,dy=event.clientY-rect.top-rect.height/2;
    const length=Math.hypot(dx,dy),ratio=length>radius?radius/length:1;dx*=ratio;dy*=ratio;
    const magnitude=Math.hypot(dx,dy)/radius;
    joystickAxes.x=magnitude<.12?0:dx/radius;joystickAxes.y=magnitude<.12?0:dy/radius;
    $('joystickKnob').style.transform=`translate(${dx}px, ${dy}px)`;
  }
  joystick.addEventListener('pointerdown',event=>{
    if(!ready||floor==='aerial'||joystickPointerId!==null)return;
    event.preventDefault();event.stopPropagation();pauseAuto('manual');joystickPointerId=event.pointerId;
    joystick.setPointerCapture(event.pointerId);joystick.classList.add('is-active');update(event);
  });
  joystick.addEventListener('pointermove',event=>{if(event.pointerId===joystickPointerId){event.preventDefault();update(event);}});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])joystick.addEventListener(type,event=>{if(event.pointerId===joystickPointerId)resetJoystick();});
}

function updateWalk(delta) {
  if (floor === 'aerial' || $('referenceDialog').open || transitioning) return;
  const forward = Number(keys.has('w') || keys.has('arrowup')) - Number(keys.has('s') || keys.has('arrowdown'))-joystickAxes.y;
  const right = Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft'))+joystickAxes.x;
  if (!forward && !right) return;
  const speed = (keys.has('shift') ? 6.4 : 3.0) * Math.min(delta, 0.08) / Math.max(1, Math.hypot(forward, right));
  const dx = (-Math.sin(yaw) * forward + Math.cos(yaw) * right) * speed;
  const dz = (-Math.cos(yaw) * forward - Math.sin(yaw) * right) * speed;
  moveWithCollision(camera.position, dx, dz, floor, colliders);
}

function drawMap() {
  if (!camera) return;
  const canvas = $('minimap'), context = canvas.getContext('2d');
  const width = canvas.width, height = canvas.height;
  const scale = 1.66, ox = width / 2, oz = 350;
  const x = (value) => ox + value * scale, z = (value) => oz + value * scale;
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#f0f4f5'; context.fillRect(x(-47.7), z(-190.8), 95.4 * scale, 190.8 * scale);
  context.strokeStyle = '#b9c9ce'; context.lineWidth = 1.2; context.strokeRect(x(-47.7), z(-190.8), 95.4 * scale, 190.8 * scale);
  context.fillStyle = '#e7edef'; context.fillRect(x(-47.7), z(-190.8), 95.4 * scale, (190.8 + NAVIGATION.ring.backZ) * scale);
  context.strokeStyle = '#ccd7db'; context.lineWidth = .7;
  for (const axisX of [-31.8, -15.9, 0, 15.9, 31.8]) { context.beginPath(); context.moveTo(x(axisX), z(0)); context.lineTo(x(axisX), z(-190.8)); context.stroke(); }
  for (let axisZ = -19.1; axisZ > NAVIGATION.ring.backInnerZ; axisZ -= 13.1) { context.beginPath(); context.moveTo(x(-47.7), z(axisZ)); context.lineTo(x(47.7), z(axisZ)); context.stroke(); }
  context.fillStyle = '#dbe5e8';
  for (let machineX = -35; machineX <= 35; machineX += 10) {
    if (Math.abs(machineX) < 4) continue;
    for (let machineZ = -27; machineZ > -130; machineZ -= 13.1) context.fillRect(x(machineX - 2.4), z(machineZ - 3), 4.8 * scale, 6 * scale);
  }
  context.fillStyle = '#f6f9fa'; context.fillRect(x(-2.2), z(NAVIGATION.ring.backZ), 4.4 * scale, -NAVIGATION.ring.backZ * scale);
  const ring = NAVIGATION.ring;
  const routeLeft = (ring.minX + ring.innerLeft) / 2, routeRight = (ring.maxX + ring.innerRight) / 2;
  const routeFront = (ring.frontZ + ring.frontInnerZ) / 2, routeBack = (ring.backZ + ring.backInnerZ) / 2;
  context.strokeStyle = '#84aab3'; context.lineWidth = 2.0; context.setLineDash([4, 3]);
  context.strokeRect(x(routeLeft), z(routeBack), (routeRight - routeLeft) * scale, (routeFront - routeBack) * scale); context.setLineDash([]);
  context.font = '10px "Segoe UI","Microsoft YaHei",sans-serif'; context.textAlign = 'center'; context.fillStyle = '#8fa3aa';
  context.fillText('辅助工艺区', x(0), z(-161)); context.fillText('生产大厅', x(0), z(-83)); context.fillText('一层入口', x(0), z(0) + 19);
  for (const stage of STAGES.slice(3)) { context.beginPath(); context.arc(x(stage.position[0]), z(stage.position[2]), 2.7, 0, Math.PI * 2); context.fillStyle = '#a2bcc4'; context.fill(); }
  if (floor !== 'aerial') {
    const px = x(camera.position.x), pz = z(camera.position.z);
    camera.getWorldDirection(tempDirection);
    const angle = Math.atan2(tempDirection.z, tempDirection.x);
    context.beginPath(); context.moveTo(px, pz); context.arc(px, pz, 21, angle - .5, angle + .5); context.closePath(); context.fillStyle = '#5d8b9925'; context.fill();
    context.beginPath(); context.arc(px, pz, 4, 0, Math.PI * 2); context.fillStyle = '#436f7e'; context.fill(); context.lineWidth = 1.5; context.strokeStyle = 'white'; context.stroke();
  }
  $('mapLocation').textContent = floor === 'aerial' ? '整体鸟瞰 · 参观环线示意' : `${floor === 'ground' ? '一层' : '夹层 +5.10 m'} · X ${camera.position.x.toFixed(1)} / Z ${camera.position.z.toFixed(1)} m`;
}

function animate() {
  requestAnimationFrame(animate);
  if (!renderer || !ready) return;
  const measuredDelta = clock.getDelta();
  const delta = Math.min(measuredDelta, 0.1);
  elapsed += delta; fpsElapsed += measuredDelta; frames++;
  if(autoPlaying)updateAuto(delta);
  else if (floor === 'aerial') orbit.update(); else updateWalk(delta);
  if (model?.update) model.update(delta, elapsed, camera);
  floorReflection?.update(camera);
  const sourceStats = ambientOcclusion ? ambientOcclusion.render(scene,camera) : (renderer.render(scene,camera),null);
  totalRenderedFrames++;
  stats = sourceStats ?? { drawcalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  if (fpsElapsed > .65) {
    fps = Math.round(frames / fpsElapsed);
    adaptRendering(frames / fpsElapsed, fpsElapsed);
    frames = 0; fpsElapsed = 0;
    updateAutoInterface();
    if (!$('minimapPanel').hidden) drawMap();
  }
}

async function initialize() {
  configureUI();
  try {
    progress(.04, '正在初始化桌面三维显示');
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: false });
    const context = renderer.getContext();
    const rendererInfo = context.getExtension('WEBGL_debug_renderer_info');
    rendererName = String(context.getParameter(rendererInfo ? rendererInfo.UNMASKED_RENDERER_WEBGL : context.RENDERER));
    setRenderScale(1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = .96;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    ambientOcclusion = createAmbientOcclusion(THREE,renderer);ambientOcclusion.enabled=true;
    viewport.appendChild(renderer.domElement);
    scene = new THREE.Scene(); scene.background = new THREE.Color('#e7edf0');
    scene.fog = new THREE.Fog('#e7edf0', 330, 950);
    camera = new THREE.PerspectiveCamera(47, window.innerWidth / window.innerHeight, 0.08, 1700);
    camera.position.set(...STAGES[0].position);
    orbit = new OrbitControls(camera, renderer.domElement); orbit.enableDamping = true; orbit.dampingFactor = .08;
    orbit.minDistance = 35; orbit.maxDistance = 480; orbit.maxPolarAngle = Math.PI * .49; orbit.minPolarAngle = .12;
    orbit.target.set(...STAGES[0].target); orbit.update();
    const environment = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environmentTarget = pmrem.fromScene(environment, .07);
    scene.environment = environmentTarget.texture; scene.environmentIntensity = .22;
    environment.dispose(); pmrem.dispose();
    // Neutral daylight supports white task lighting; warm light stays in the visitor gallery.
    scene.add(new THREE.HemisphereLight('#edf2f7', '#807c72', .42));
    const sun = new THREE.DirectionalLight('#fff3de', 2.7); sun.position.set(-80, 130, 40);
    sun.target.position.set(0, 0, -76); sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -115, right: 115, top: 125, bottom: -125, near: 5, far: 410 });
    sun.shadow.normalBias = .12; sun.shadow.bias = -.0003; scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#eef1f5', .11); fill.position.set(75, 50, -170); scene.add(fill);
    const bounce = new THREE.DirectionalLight('#eeece4', .32); bounce.position.set(0,-20,-80);bounce.target.position.set(0,8,-80);scene.add(bounce,bounce.target);
    progress(.08, '正在读取厂房模型与材质');
    const { createFactoryScene } = await import('./scene.js?v=20261015-delivery2');
    model = await createFactoryScene(THREE, scene, progress);
    if (!model) throw new Error('场景初始化未返回模型数据');
    floorReflection=createFloorReflection(THREE,renderer,scene,scene.getObjectByName('Finished_ground_floor'));
    floorReflection.strength=.16;
    colliders = normalizeColliders(model.colliders);
    routeAudit=auditAutoRoutes(STAGES,(x,z,level)=>isBlocked(x,z,level,colliders));
    if(!routeAudit.passed)throw new Error('自动漫游路径与模型相交，请检查观景路线');
    progress(.97, '正在准备观景机位与参观路线');
    ready = true;
    await setStage(0, { immediate: true, autoStart: false });
    installControls();
    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
      setRenderScale(renderScale);
    });
    renderer.domElement.addEventListener('webglcontextlost', (event) => {
      event.preventDefault(); ready = false;
      fail(new Error('显卡显示连接已中断，请重新加载恢复展示'));
    });
    ambientOcclusion.render(scene, camera);
    $('progressBar').style.width = '100%'; $('loadingMessage').textContent = '场景已就绪';
    await new Promise((resolve) => setTimeout(resolve, 160));
    $('loadingScreen').classList.add('loaded');
    setTimeout(() => { $('loadingScreen').hidden = true; }, 700);
    adaptiveGraceUntil=performance.now()+5000;
    clock.start(); animate();
  } catch (error) { fail(error); }
}

function fail(error) {
  loadingErrors.push(error.message ?? String(error));
  console.error('Factory tour initialization failed:', error);
  $('loadingScreen').hidden = false; $('loadingScreen').classList.remove('loaded');
  $('loadingTitle').textContent = '三维场景暂未载入';
  $('loadingMessage').textContent = location.protocol === 'file:' ? '请使用项目内的启动脚本打开网页，浏览器不能直接读取本地三维模型。' : `载入未完成：${error.message ?? '请检查本机服务与模型资源后重试。'}`;
  $('loadingNote').textContent = '原方案参考图片已保留，实时三维尚未完成载入。';
  $('retryButton').hidden = false;
}

window.__tourDebug = {
  snapshot() { return { ready, stage: currentStage, stageId: STAGES[currentStage].id, floor, pos: camera ? camera.position.toArray() : null, target: orbit ? orbit.target.toArray() : null, roofHidden, fps, ...stats, rendererName, renderScale, pixelRatio: renderer?.getPixelRatio() ?? null, shadowAutoUpdate: renderer?.shadowMap.autoUpdate ?? null, colliderCount: colliders.length, errors: [...loadingErrors], currentPositionBlocked: ready && floor !== 'aerial' ? isBlocked(camera.position.x, camera.position.z, floor, colliders) : false, autoPlaying, autoTime, autoPauseReason,autoSpeed:AUTO_TOUR_SPEED,routeAudit,people:0,joystick:{...joystickAxes},bgm:bgm.snapshot() }; },
  async freshStats(durationMs = 2000) {
    const startedAt = performance.now(), initialFrames = totalRenderedFrames;
    await new Promise((resolve) => setTimeout(resolve, THREE.MathUtils.clamp(durationMs, 500, 5000)));
    const measurementElapsedMs = performance.now() - startedAt, renderedFrames = totalRenderedFrames - initialFrames;
    return { ...this.snapshot(), fps: Number((renderedFrames / measurementElapsedMs * 1000).toFixed(1)), measurementElapsedMs: Math.round(measurementElapsedMs), renderedFrames };
  },
  setRenderScale(value) { setRenderScale(value); return renderScale; },
  setStage(index, immediate = true, autoStart = false) { return setStage(index, { immediate,autoStart }); },
  pauseAuto() {pauseAuto();},
  toggleAuto,
  move(dx, dz) { if (!ready) return false; const moved = moveWithCollision(camera.position, dx, dz, floor, colliders); drawMap(); return moved; },
  setPosition(x, z) { if (!ready || floor === 'aerial' || isBlocked(x, z, floor, colliders)) return false; camera.position.x = x; camera.position.z = z; drawMap(); return true; },
  get stages() { return STAGES.map((stage) => ({ id: stage.id, floor: stage.floor, position: [...stage.position] })); },
};

initialize();
