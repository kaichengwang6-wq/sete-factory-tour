/** Lightweight workshop equipment. Metres; Y up; operator faces +Z. */
const libraries = new WeakMap();

export function createEquipmentLibrary(THREE) {
  if (libraries.has(THREE)) return libraries.get(THREE);
  const T = THREE;
  const material = (color, roughness = .48, metalness = .05) =>
    new T.MeshStandardMaterial({ color, roughness, metalness });
  const m = {
    shell: material(0xe7e5e0, .40, .045),
    soft: material(0xbfc2c0, .44, .35),
    dark: material(0x3b3d3c, .53, .18),
    black: material(0x1d2120, .76, .025),
    steel: material(0xbcc1bf, .33, .78),
    navy: material(0x304656, .86),
    cloth: material(0x788c99, .89),
    skin: material(0xc9ae98, .9),
    amber: material(0xe3a936, .42),
    red: material(0x9c3733, .4),
    green: new T.MeshStandardMaterial({ color: 0x63bd8d, roughness: .35, emissive: 0x3a805d, emissiveIntensity: .38 }),
    glass: new T.MeshStandardMaterial({ color: 0xb8c4c2, transparent: true, opacity: .18, roughness: .34, metalness: 0, envMapIntensity: .2, depthWrite: false, side: T.DoubleSide }),
  };

  // Microscopic spray-paint texture breaks the plastic-looking uniform highlight.
  // Deterministic textures are shared by every instance and never add draw calls.
  function microSurface(brushed = false) {
    const size = 64, data = new Uint8Array(size * size * 4);
    let seed = brushed ? 947 : 283;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      seed = (1664525 * seed + 1013904223) >>> 0;
      const random = seed / 4294967295;
      const value = brushed ? 196 + Math.sin(y * 2.7) * 22 + random * 12 : 212 + random * 40;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(value); data[i + 3] = 255;
    }
    const texture = new T.DataTexture(data, size, size);
    texture.wrapS = texture.wrapT = T.RepeatWrapping;
    texture.magFilter = T.LinearFilter; texture.minFilter = T.LinearMipmapLinearFilter;
    texture.generateMipmaps = true; texture.repeat.set(brushed ? 6 : 12, brushed ? 4 : 12);
    texture.needsUpdate = true;
    return texture;
  }
  const paintTexture = microSurface(), brushedTexture = microSurface(true);
  Object.assign(m.shell, { roughnessMap: paintTexture, bumpMap: paintTexture, bumpScale: .0007, envMapIntensity: .68 });
  Object.assign(m.dark, { roughnessMap: paintTexture, bumpMap: paintTexture, bumpScale: .0009, envMapIntensity: .55 });
  Object.assign(m.steel, { roughnessMap: brushedTexture, bumpMap: brushedTexture, bumpScale: .00025, envMapIntensity: .8 });
  m.soft.envMapIntensity = .65;

  function makeControlTexture() {
    if (typeof document === 'undefined') {
      const tex = new T.DataTexture(new Uint8Array([27, 49, 59, 255]), 1, 1);
      tex.needsUpdate = true;
      return tex;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 320;
    const c = canvas.getContext('2d');
    c.fillStyle = '#17262e'; c.fillRect(0, 0, 256, 320);
    c.fillStyle = '#354a55'; c.fillRect(0, 0, 256, 38);
    c.font = 'bold 15px Arial'; c.fillStyle = '#e2ecef';
    c.fillText('CNC / CONTROL', 13, 25);
    c.font = '12px Arial'; c.fillStyle = '#89b9c5';
    c.fillText('DEMONSTRATION', 13, 61);
    c.strokeStyle = '#44606c'; c.lineWidth = 1;
    for (let x = 15; x < 245; x += 28) { c.beginPath(); c.moveTo(x, 80); c.lineTo(x, 210); c.stroke(); }
    for (let y = 80; y <= 210; y += 26) { c.beginPath(); c.moveTo(15, y); c.lineTo(240, y); c.stroke(); }
    c.strokeStyle = '#82b9c6'; c.lineWidth = 3; c.strokeRect(64, 103, 111, 77);
    c.strokeStyle = '#d2dddd'; c.strokeRect(93, 127, 52, 30);
    c.font = '13px monospace'; c.fillStyle = '#c4d3d8';
    c.fillText('X   --    Y   --', 16, 241);
    c.fillText('Z   --    READY', 16, 267);
    c.fillStyle = '#507683'; c.fillRect(12, 287, 232, 22);
    c.fillStyle = '#e5ecee'; c.font = '11px Arial'; c.fillText('MANUAL     SETUP     VIEW', 21, 302);
    const tex = new T.CanvasTexture(canvas);
    tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }
  const controlTexture = makeControlTexture();
  m.screen = new T.MeshStandardMaterial({ map: controlTexture, roughness: .4, emissiveMap: controlTexture, emissive: 0xffffff, emissiveIntensity: .26, envMapIntensity: .12 });

  function makeBadgeTexture() {
    if (typeof document === 'undefined') return controlTexture;
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
    const c = canvas.getContext('2d');
    c.fillStyle = '#bec5c5'; c.fillRect(0, 0, 512, 256);
    c.strokeStyle = '#828e90'; c.lineWidth = 8; c.strokeRect(4, 4, 504, 248);
    c.fillStyle = '#263238'; c.font = 'bold 43px Arial'; c.fillText('CNC', 27, 63);
    c.font = '21px Arial'; c.fillText('PRECISION MACHINE TOOL', 27, 105);
    c.fillStyle = '#d7b64b'; c.fillRect(26, 135, 460, 93);
    c.fillStyle = '#3b3b32'; c.beginPath(); c.moveTo(60, 151); c.lineTo(88, 207); c.lineTo(32, 207); c.closePath(); c.fill();
    c.fillStyle = '#e2c363'; c.font = 'bold 37px Arial'; c.fillText('!', 54, 199);
    c.fillStyle = '#333a38'; c.font = 'bold 24px Arial'; c.fillText('KEEP GUARD CLOSED', 105, 190);
    const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace; return tex;
  }
  m.badge = new T.MeshStandardMaterial({ map: makeBadgeTexture(), color: 0xd8d8cf, roughness: .52, metalness: .28, envMapIntensity: .35 });

  const boxCache = new Map();
  function chamferBox(w, h, d, bevel = .025) {
    const b = Math.min(bevel, w / 5, h / 5, d / 5);
    const key = `${w}/${h}/${d}/${b}`;
    if (boxCache.has(key)) return boxCache.get(key);
    const x = w / 2 - b, y = h / 2 - b;
    const shape = new T.Shape();
    shape.moveTo(-x, -y); shape.lineTo(x, -y); shape.lineTo(x, y); shape.lineTo(-x, y); shape.closePath();
    const g = new T.ExtrudeGeometry(shape, { depth: d - 2 * b, bevelEnabled: b > 0, bevelSize: b, bevelThickness: b, bevelSegments: 1, steps: 1, curveSegments: 1 });
    g.translate(0, 0, -d / 2 + b);
    boxCache.set(key, g);
    return g;
  }
  const cylinders = new Map();
  function cylinder(r, h, segments = 10, top = r) {
    const key = `${r}/${h}/${segments}/${top}`;
    if (!cylinders.has(key)) cylinders.set(key, new T.CylinderGeometry(top, r, h, segments));
    return cylinders.get(key);
  }

  /** Merge by material: each finished machine has about 13 draw calls. */
  function builder(name) {
    const buckets = new Map();
    function add(mat, geometry, x, y, z, rx = 0, ry = 0, rz = 0) {
      const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
      g.applyMatrix4(new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz)), new T.Vector3(1, 1, 1)));
      if (!buckets.has(mat)) buckets.set(mat, []);
      buckets.get(mat).push(g);
    }
    function box(mat, x, y, z, w, h, d, bevel = .025, ry = 0) { add(mat, chamferBox(w, h, d, bevel), x, y, z, 0, ry); }
    function cyl(mat, x, y, z, r, h, rx = 0, rz = 0, segments = 10, top = r) { add(mat, cylinder(r, h, segments, top), x, y, z, rx, 0, rz); }
    function finish() {
      const group = new T.Group(); group.name = name;
      for (const [mat, geometries] of buckets) {
        const counts = geometries.map(g => g.attributes.position.count);
        const total = counts.reduce((a, b) => a + b, 0);
        const geom = new T.BufferGeometry();
        for (const [key, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
          const data = new Float32Array(total * size); let offset = 0;
          for (let i = 0; i < geometries.length; i++) {
            const arr = geometries[i].getAttribute(key);
            if (arr) data.set(arr.array, offset);
            offset += counts[i] * size;
          }
          geom.setAttribute(key, new T.BufferAttribute(data, size));
        }
        geom.computeBoundingBox(); geom.computeBoundingSphere();
        const mesh = new T.Mesh(geom, m[mat]);
        mesh.name = `${name}_${mat}`;
        mesh.castShadow = mat !== 'glass'; mesh.receiveShadow = mat !== 'glass';
        group.add(mesh);
        geometries.forEach(g => g.dispose());
      }
      return group;
    }
    return { add, box, cyl, finish };
  }

  function control(b, x, y, z, compact = false) {
    const w = compact ? .37 : .46;
    b.box('dark', x, y, z, w, .87, .16, .035);
    b.box('black', x, y + .14, z + .086, w - .08, .43, .012, .003);
    b.add('screen', new T.PlaneGeometry(w - .12, .37), x, y + .14, z + .095);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 4; col++) b.box('soft', x + (col - 1.5) * .07, y - .14 - row * .062, z + .089, .045, .032, .013, .002);
    }
    b.cyl('red', x + .11, y - .34, z + .107, .04, .032, Math.PI / 2, 0, 10);
    b.cyl('amber', x - .085, y - .34, z + .102, .025, .024, Math.PI / 2, 0, 8);
    // Four recessed bezel fixings and a tactile rotary selector.
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) b.cyl('steel', x + dx * (w / 2 - .028), y + dy * .395, z + .086, .009, .007, Math.PI / 2, 0, 6);
    b.cyl('black', x, y - .34, z + .112, .032, .035, Math.PI / 2, 0, 10);
  }

  function badge(b, x, y, z, width = .29) {
    b.add('badge', new T.PlaneGeometry(width, width / 2), x, y, z);
  }

  function servicePanel(b, side, x, y, z, height = 1.40, depth = 1.32) {
    b.box('dark', side * x, y, z, .016, height, depth, .003);
    b.box('shell', side * (x + .010), y, z, .014, height - .035, depth - .035, .003);
    // Surface fixings and louvres remain within the existing machine envelope.
    for (const dy of [-1, 1]) for (const dz of [-1, 1]) b.cyl('steel', side * (x + .02), y + dy * (height / 2 - .07), z + dz * (depth / 2 - .07), .012, .008, 0, Math.PI / 2, 6);
    for (let i = 0; i < 6; i++) b.box('dark', side * (x + .02), y - .25 + i * .067, z, .009, .018, depth * .48, .002);
  }
  function signal(b, x, z, y = 2.24) {
    b.cyl('dark', x, y + .12, z, .025, .25, 0, 0, 6);
    b.cyl('black', x, y + .27, z, .065, .045);
    b.cyl('green', x, y + .325, z, .061, .075);
    b.cyl('amber', x, y + .40, z, .061, .075);
    b.cyl('red', x, y + .475, z, .061, .075);
    b.cyl('dark', x, y + .52, z, .064, .025);
  }
  function table(b, y = .83, z = .23, w = 1.66) {
    b.box('dark', 0, y - .14, z, w + .08, .22, .85);
    b.box('steel', 0, y, z, w, .13, .78, .012);
    for (let i = 0; i < 5; i++) b.box('black', 0, y + .067, z - .27 + i * .135, w - .06, .008, .018, .001);
    b.box('steel', -.21, y + .16, z + .02, .41, .19, .32, .008);
    b.box('dark', -.21, y + .25, z + .02, .21, .05, .30, .004);
    b.box('steel', .30, y + .115, z + .01, .19, .08, .21, .008);
    b.box('black', .30, y + .159, z + .01, .07, .01, .12, .001);
  }
  function base(b, w = 2.62, d = 2.94) {
    b.box('dark', 0, .25, 0, w, .42, d, .055);
    b.box('black', 0, .095, 0, w - .2, .12, d - .18, .018);
    for (const x of [-1, 1]) for (const z of [-1, 1]) b.cyl('dark', x * (w / 2 - .26), .045, z * (d / 2 - .26), .1, .09, 0, 0, 8);
  }
  function enclosed() {
    const b = builder('Enclosed_Machining_Centre'); base(b);
    // Full depth side skins and rear casing, with a recessed operational cavity.
    b.box('shell', -1.16, 1.37, -.10, .27, 1.94, 2.65, .045);
    b.box('shell', 1.15, 1.37, -.10, .29, 1.94, 2.65, .045);
    b.box('shell', 0, 1.38, -1.29, 2.45, 1.95, .28, .045);
    b.box('shell', 0, 2.30, -.10, 2.48, .22, 2.65, .04);
    b.box('black', 0, 1.33, -.99, 1.94, 1.56, .12);
    b.box('dark', 0, 1.51, -.58, .61, 1.32, .59);
    b.box('soft', 0, 1.79, -.10, .55, .67, .59, .04);
    b.cyl('steel', 0, 1.37, -.02, .115, .20, 0, 0, 10);
    b.cyl('dark', 0, 1.23, -.02, .035, .15, 0, 0, 8);
    table(b);
    // Two sliding doors; glazing reveals the machining bed.
    b.box('shell', 0, .67, 1.25, 2.22, .48, .17, .025);
    b.box('shell', 0, 2.16, 1.25, 2.22, .22, .17, .025);
    b.box('soft', -.94, 1.47, 1.25, .17, 1.20, .17, .015);
    b.box('soft', .94, 1.47, 1.25, .17, 1.20, .17, .015);
    for (const x of [-.43, .43]) {
      b.box('dark', x - .385, 1.48, 1.258, .05, 1.13, .052, .008);
      b.box('dark', x + .385, 1.48, 1.258, .05, 1.13, .052, .008);
      b.box('dark', x, .94, 1.258, .82, .05, .052, .008);
      b.box('dark', x, 2.02, 1.258, .82, .05, .052, .008);
    }
    b.box('glass', -.43, 1.48, 1.296, .72, 1.01, .012, .001);
    b.box('glass', .43, 1.48, 1.296, .72, 1.01, .012, .001);
    b.box('steel', -.05, 1.43, 1.37, .035, .43, .035, .006);
    b.box('steel', .05, 1.43, 1.37, .035, .43, .035, .006);
    control(b, 1.07, 1.48, 1.40, true);
    signal(b, -.96, -.71, 2.15);
    servicePanel(b, -1, 1.296, 1.32, -.32, 1.55, 1.53);
    servicePanel(b, 1, 1.296, 1.32, -.32, 1.55, 1.53);
    badge(b, -.71, .66, 1.338, .28);
    // Sliding-door rail, sill drainage slot and panel gap catch grazing light.
    b.box('steel', 0, 2.048, 1.31, 1.80, .025, .032, .004);
    b.box('black', 0, .422, 1.31, 1.65, .016, .02, .002);
    return b.finish();
  }
  function vertical() {
    const b = builder('Vertical_Machining_Centre'); base(b, 2.6, 3.05);
    b.box('dark', 0, 1.17, -.87, .94, 1.77, 1.0, .065);
    b.box('shell', -.50, 1.49, -.92, .20, 1.85, .91, .03);
    b.box('shell', .50, 1.49, -.92, .20, 1.85, .91, .03);
    b.box('black', 0, 1.46, -.34, .56, 1.43, .095, .009);
    for (let i = 0; i < 9; i++) b.box('dark', 0, .91 + i * .13, -.275, .51, .025, .025, .004);
    b.box('steel', -.29, 1.48, -.28, .035, 1.32, .04, .005);
    b.box('steel', .29, 1.48, -.28, .035, 1.32, .04, .005);
    b.box('shell', 0, 1.84, .03, .72, .78, .76, .045);
    b.cyl('steel', 0, 1.35, .13, .13, .22, 0, 0, 12);
    b.cyl('dark', 0, 1.20, .13, .035, .16, 0, 0, 8);
    table(b, .83, .39, 1.95);
    b.box('shell', -1.10, .78, .0, .22, .78, 2.4, .045);
    b.box('shell', 1.10, .78, .0, .22, .78, 2.4, .045);
    b.box('shell', 0, .58, 1.31, 2.40, .31, .24, .035);
    b.box('soft', -1.10, 1.42, .0, .065, .58, 2.22, .015);
    b.box('soft', 1.10, 1.42, .0, .065, .58, 2.22, .015);
    b.box('glass', -.54, 1.29, 1.32, .94, .92, .012, .001);
    b.box('glass', .48, 1.29, 1.32, .94, .92, .012, .001);
    b.box('dark', 0, 1.30, 1.30, .06, .99, .07, .006);
    b.box('dark', 0, 1.78, 1.30, 2.10, .06, .07, .006);
    b.box('steel', -.08, 1.20, 1.40, .035, .32, .035, .005);
    // Segmented cable chain, a restrained arch above the spindle head.
    for (let i = 0; i < 8; i++) {
      const angle = Math.PI * i / 7;
      b.box('black', -.30, 2.18 + Math.sin(angle) * .38, -.48 + Math.cos(angle) * .44, .22, .13, .19, .018);
    }
    b.box('steel', 1.04, 1.73, .76, .12, .11, .69, .015);
    control(b, 1.12, 1.66, 1.19, true);
    signal(b, -.77, -.91, 2.12);
    badge(b, -.70, .58, 1.434, .27);
    return b.finish();
  }
  function compact() {
    const b = builder('Compact_CNC_Centre'); base(b, 2.42, 2.73);
    b.box('shell', -1.04, 1.27, -.06, .30, 1.80, 2.39, .05);
    b.box('shell', 1.04, 1.27, -.06, .30, 1.80, 2.39, .05);
    b.box('shell', 0, 1.28, -1.14, 2.15, 1.82, .24, .04);
    b.box('shell', 0, 2.13, -.06, 2.20, .22, 2.38, .035);
    b.box('dark', 0, 1.22, -.83, 1.77, 1.32, .13);
    b.box('soft', -.41, 1.35, -.34, .58, .82, .60, .03);
    b.cyl('steel', -.41, .99, -.10, .12, .2, 0, 0, 10);
    table(b, .73, .25, 1.49);
    b.box('shell', 0, .65, 1.13, 2.09, .43, .16);
    b.box('soft', 0, 1.98, 1.13, 2.09, .13, .16);
    b.box('dark', -.86, 1.37, 1.13, .10, 1.10, .12, .009);
    b.box('dark', .49, 1.37, 1.13, .10, 1.10, .12, .009);
    b.box('dark', -.185, .85, 1.13, 1.45, .07, .12, .009);
    b.box('dark', -.185, 1.88, 1.13, 1.45, .07, .12, .009);
    b.box('glass', -.185, 1.37, 1.151, 1.25, .96, .014, .001);
    b.box('steel', .40, 1.34, 1.24, .035, .38, .035, .006);
    control(b, .86, 1.46, 1.23, true);
    signal(b, -.88, -.65, 1.98);
    b.box('dark', .58, 2.27, -.70, .42, .24, .51, .03);
    for (let i = 0; i < 5; i++) b.box('dark', -1.20, 1.02 + i * .06, -.32, .012, .02, .55, .001);
    servicePanel(b, 1, 1.184, 1.30, -.22, 1.37, 1.30);
    badge(b, -.66, .65, 1.213, .26);
    b.box('steel', -.185, 1.92, 1.14, 1.48, .026, .033, .004);
    return b.finish();
  }

  function cart() {
    const b = builder('Tool_Trolley');
    b.box('navy', 0, .54, 0, .65, .58, .44, .025);
    b.box('steel', 0, .85, 0, .71, .055, .50, .015);
    b.box('black', 0, .883, 0, .64, .012, .43, .002);
    for (let i = 0; i < 3; i++) {
      b.box('soft', 0, .38 + i * .15, .227, .56, .12, .02, .003);
      b.box('steel', 0, .415 + i * .15, .25, .28, .018, .021, .003);
    }
    for (const x of [-.25, .25]) for (const z of [-.15, .15]) {
      b.cyl('black', x, .105, z, .075, .045, 0, Math.PI / 2, 10);
      b.box('steel', x, .20, z, .04, .12, .04, .003);
    }
    b.box('steel', -.36, .80, 0, .025, .025, .41, .004);
    b.box('steel', -.33, .80, -.19, .10, .025, .025, .004);
    b.box('steel', -.33, .80, .19, .10, .025, .025, .004);
    b.box('dark', -.12, .92, -.05, .18, .06, .12, .005);
    return b.finish();
  }
  function worker() {
    const b = builder('Workshop_Operator');
    // Restrained, adult scale figure: no cartoon face or oversized head.
    b.cyl('navy', -.10, .58, 0, .078, .75, 0, -.025, 8, .092);
    b.cyl('navy', .10, .58, .015, .078, .75, 0, .025, 8, .092);
    b.box('black', -.10, .10, .055, .14, .12, .27, .025);
    b.box('black', .10, .10, .07, .14, .12, .27, .025);
    b.cyl('cloth', 0, 1.18, 0, .19, .49, 0, 0, 8, .215);
    b.box('navy', 0, 1.16, .175, .25, .38, .035, .01);
    b.cyl('cloth', -.225, 1.18, .025, .065, .43, -.14, -.12, 8, .08);
    b.cyl('cloth', .225, 1.18, .025, .065, .43, -.14, .12, 8, .08);
    b.cyl('skin', -.255, .925, .06, .047, .15, -.1, 0, 8);
    b.cyl('skin', .255, .925, .06, .047, .15, -.1, 0, 8);
    b.cyl('skin', 0, 1.465, 0, .065, .10, 0, 0, 8);
    const head = new T.SphereGeometry(.115, 10, 7); head.scale(.88, 1.12, .94);
    b.add('skin', head, 0, 1.60, .015);
    const hair = new T.SphereGeometry(.116, 10, 5, 0, Math.PI * 2, 0, Math.PI * .53); hair.scale(.89, .99, .95);
    b.add('dark', hair, 0, 1.615, .007);
    return b.finish();
  }

  const prototypes = [enclosed(), vertical(), compact()];
  const trolley = cart(), operator = worker();
  const library = {
    createMachine(type = 0) { return prototypes[((type % 3) + 3) % 3].clone(); },
    createCart() { return trolley.clone(); },
    createWorker() { return operator.clone(); },
    materials: m,
    stats: prototypes.map(group => ({ name: group.name, meshes: group.children.length, triangles: group.children.reduce((s, child) => s + child.geometry.attributes.position.count / 3, 0) })),
  };
  libraries.set(THREE, library);
  return library;
}

/** placements: { x, z, y?:0, rotation?:0 (radians), type?:0|1|2, scale?:1 }. */
export function instantiateMachines(THREE, placements) {
  const library = createEquipmentLibrary(THREE);
  const root = new THREE.Group(); root.name = 'Instanced_Workshop_Equipment';
  const grouped = [[], [], []];
  for (const item of placements) grouped[((item.type ?? 0) % 3 + 3) % 3].push(item);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  for (let type = 0; type < 3; type++) {
    const rows = grouped[type]; if (!rows.length) continue;
    const model = library.createMachine(type);
    for (const part of model.children) {
      const instance = new THREE.InstancedMesh(part.geometry, part.material, rows.length);
      instance.name = `Instances_${part.name}`;
      instance.castShadow = part.castShadow; instance.receiveShadow = part.receiveShadow;
      rows.forEach((p, i) => {
        position.set(p.x, p.y || 0, p.z); quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotation || 0);
        const s = p.scale ?? 1; scale.set(s, s, s);
        instance.setMatrixAt(i, matrix.compose(position, quaternion, scale));
      });
      instance.instanceMatrix.needsUpdate = true;
      instance.computeBoundingBox(); instance.computeBoundingSphere();
      root.add(instance);
    }
  }
  root.userData.placements = placements;
  root.userData.equipmentStats = library.stats;
  return root;
}

/** Batch tools and operators with the same shared prototype geometries. */
export function instantiateAccessories(THREE, { carts = [], workers = [] } = {}) {
  const library = createEquipmentLibrary(THREE);
  const root = new THREE.Group(); root.name = 'Instanced_Workshop_Accessories';
  const transform = new THREE.Matrix4(), position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(), axis = new THREE.Vector3(0, 1, 0);
  const sets = [[carts, library.createCart()], [workers, library.createWorker()]];
  for (const [rows, prototype] of sets) {
    if (!rows.length) continue;
    for (const part of prototype.children) {
      const instances = new THREE.InstancedMesh(part.geometry, part.material, rows.length);
      instances.name = `Instances_${part.name}`;
      instances.castShadow = part.castShadow; instances.receiveShadow = part.receiveShadow;
      rows.forEach((item, index) => {
        position.set(item.x, item.y ?? 0, item.z);
        quaternion.setFromAxisAngle(axis, item.rotation ?? 0);
        scale.setScalar(item.scale ?? 1);
        instances.setMatrixAt(index, transform.compose(position, quaternion, scale));
      });
      instances.instanceMatrix.needsUpdate = true;
      instances.computeBoundingBox(); instances.computeBoundingSphere();
      root.add(instances);
    }
  }
  root.userData.counts = { carts: carts.length, workers: workers.length };
  return root;
}
