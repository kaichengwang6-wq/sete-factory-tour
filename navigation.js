// All route bounds, camera stops, and collision policy are independent of scene geometry.
export const NAVIGATION = {
  groundY: 0,
  mezzanineY: 5.1,
  eyeHeight: 1.6,
  groundEyeHeight: 1.8,
  radius: 0.27,
  bounds: { minX: -47.1, maxX: 47.1, frontZ: -0.45, backZ: -190.1 },
  entry: { minX: -2.1, maxX: 2.1, minZ: -2, maxZ: 13 },
  ring: { minX: -47.9, maxX: 47.9, frontZ: 0.2, backZ: -136.4, innerLeft: -43.0, innerRight: 43.0, frontInnerZ: -5.4, backInnerZ: -132.1 },
};

const groundViewY = NAVIGATION.groundY + NAVIGATION.groundEyeHeight;
const eyeHeightForFloor = (floor) => floor === 'ground' ? NAVIGATION.groundEyeHeight : NAVIGATION.eyeHeight;

export const STAGES = [
  { id: 'aerial', label: '厂房整体鸟瞰', title: '从整体，走入精工现场。', description: '先看见厂房的全貌，再沿生产主轴进入现场，最后从夹层理解整个车间。', english: 'THE BIG PICTURE', caption: '厂房 · 整体鸟瞰', floor: 'aerial', position: [-159, 123, 75], target: [0, 3, -88], duration: 1.6 },
  { id: 'entrance', label: '从一层入口进入', title: '沿主轴，进入生产现场。', description: '从一层入口走入厂房，贯通的物流主轴连接各生产单元，两侧设备秩序展开。', english: 'ENTER THE WORKSHOP', caption: '一层 · 生产入口', floor: 'ground', position: [0, groundViewY, 8], target: [0, 2.3, -50], duration: 2.2 },
  { id: 'production', label: '一层生产主轴', title: '机床阵列，清晰而有序。', description: '沿中央物流通道深入，近距离观察精密机床、白色梁柱与明亮的生产空间。', english: 'PRECISION IN EVERY DETAIL', caption: '一层 · 中央物流主轴', floor: 'ground', position: [0, groundViewY, -57], target: [2, 2.6, -111], duration: 2.2 },
  { id: 'gallery', label: '进入夹层参观廊', title: '向上一步，视野展开。', description: '进入独立的夹层参观通道。白色铝板吊顶与线性照明，引导视线走向车间。', english: 'A NEW PERSPECTIVE', caption: '夹层 · 参观通道', floor: 'mezzanine', position: [-45.1, 6.7, -8], target: [-45.1, 6.7, -37], duration: 1.8 },
  { id: 'corner', label: '转角 · 车间总览', title: '透过窗，看见生产全景。', description: '从夹层转角向车间展开视线，机床阵列、生产单元和物流方向一目了然。', english: 'THE WORKSHOP UNFOLDS', caption: '夹层 · 转角观察窗', floor: 'mezzanine', position: [-45.1, 6.7, -25.6], target: [-22, 1.1, -45], duration: 1.5 },
  { id: 'longside', label: '长边 · 俯看机床', title: '独立参观，近观精工。', description: '在长边观察窗前俯看下层设备与操作区域，参观活动与生产运行彼此独立。', english: 'OBSERVE WITHOUT INTERRUPTING', caption: '夹层 · 长边俯视', floor: 'mezzanine', position: [-45.1, 6.7, -65], target: [-27, 1.0, -68], duration: 1.8 },
  { id: 'farend', label: '远端 · 贯通主轴', title: '回望主轴，理解全局。', description: '从远端观察窗回望生产大厅，完整感受中央物流通道与两侧生产阵列的空间关系。', english: 'SEE THE COMPLETE FLOW', caption: '夹层 · 主轴回望', floor: 'mezzanine', position: [0, 6.7, -134.2], target: [0, 1.3, -105], duration: 2.0 },
];

function pointInRect(x, z, minX, maxX, minZ, maxZ) {
  return x >= minX && x <= maxX && z >= minZ && z <= maxZ;
}

export function isOnNavigableFloor(x, z, floor) {
  if (floor === 'aerial') return true;
  const radius = NAVIGATION.radius;
  if (floor === 'ground') {
    const b = NAVIGATION.bounds, e = NAVIGATION.entry;
    return pointInRect(x, z, b.minX + radius, b.maxX - radius, b.backZ + radius, b.frontZ) ||
      pointInRect(x, z, e.minX + radius, e.maxX - radius, e.minZ, e.maxZ - radius);
  }
  const r = NAVIGATION.ring;
  if (!pointInRect(x, z, r.minX + radius, r.maxX - radius, r.backZ + radius, r.frontZ - radius)) return false;
  return x <= r.innerLeft - radius || x >= r.innerRight + radius || z >= r.frontInnerZ + radius || z <= r.backInnerZ - radius;
}

export function normalizeColliders(colliders = []) {
  return colliders.flatMap((item) => {
    const box = item.box ?? item.box3 ?? item;
    if (!box.min || !box.max) return [];
    const min = Array.isArray(box.min) ? { x: box.min[0], y: box.min[1], z: box.min[2] } : box.min;
    const max = Array.isArray(box.max) ? { x: box.max[0], y: box.max[1], z: box.max[2] } : box.max;
    if (![min.x, min.y, min.z, max.x, max.y, max.z].every(Number.isFinite)) return [];
    return [{ min: { ...min }, max: { ...max }, floors: item.floors ?? (item.floor ? [item.floor] : null) }];
  });
}

export function isBlocked(x, z, floor, colliders) {
  if (!isOnNavigableFloor(x, z, floor)) return true;
  const feet = floor === 'mezzanine' ? NAVIGATION.mezzanineY : NAVIGATION.groundY;
  const radius = NAVIGATION.radius;
  for (const box of colliders) {
    if (box.floors && !box.floors.includes(floor)) continue;
    if (box.max.y <= feet + 0.22 || box.min.y >= feet + eyeHeightForFloor(floor) + 0.12) continue;
    if (x > box.min.x - radius && x < box.max.x + radius && z > box.min.z - radius && z < box.max.z + radius) return true;
  }
  return false;
}

// Substeps prevent tunnelling; per-axis resolution permits natural wall sliding.
export function moveWithCollision(position, deltaX, deltaZ, floor, colliders) {
  if (floor === 'aerial') return false;
  const steps = Math.max(1, Math.ceil(Math.hypot(deltaX, deltaZ) / 0.12));
  const stepX = deltaX / steps, stepZ = deltaZ / steps;
  let moved = false;
  for (let i = 0; i < steps; i++) {
    if (!isBlocked(position.x + stepX, position.z, floor, colliders)) { position.x += stepX; moved ||= stepX !== 0; }
    if (!isBlocked(position.x, position.z + stepZ, floor, colliders)) { position.z += stepZ; moved ||= stepZ !== 0; }
  }
  position.y = (floor === 'mezzanine' ? NAVIGATION.mezzanineY : NAVIGATION.groundY) + eyeHeightForFloor(floor);
  return moved;
}

export function findSafeLanding(preferred, floor, colliders) {
  const y = (floor === 'mezzanine' ? NAVIGATION.mezzanineY : NAVIGATION.groundY) + eyeHeightForFloor(floor);
  if (floor === 'aerial') return [...preferred];
  if (!isBlocked(preferred[0], preferred[2], floor, colliders)) return [preferred[0], y, preferred[2]];
  for (let distance = 0.4; distance <= 6; distance += 0.4) {
    for (let a = 0; a < 24; a++) {
      const angle = a / 24 * Math.PI * 2, x = preferred[0] + Math.cos(angle) * distance, z = preferred[2] + Math.sin(angle) * distance;
      if (!isBlocked(x, z, floor, colliders)) return [x, y, z];
    }
  }
  throw new Error(`无法为${floor === 'ground' ? '一层' : '夹层'}找到可通行的观景落点`);
}
