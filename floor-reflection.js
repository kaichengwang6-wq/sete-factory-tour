/**
 * Restrained, rough planar reflection for the finished factory floor only.
 * Call update(camera) before rendering the main scene. The reflection is linear
 * HDR, so the existing floor shader retains its textures and is tone-mapped once.
 * Static views are cached; moving views normally refresh every fourth frame.
 */
export function createFloorReflection(T, renderer, scene, floorMesh) {
  if (!floorMesh?.isMesh) throw new Error('Floor reflection requires the finished floor mesh');
  floorMesh.updateWorldMatrix(true, false);
  const floorBounds = new T.Box3().setFromObject(floorMesh);
  const planeHeight = floorBounds.max.y + 0.001;
  const planeOrigin = new T.Vector3(0, planeHeight, 0), planeNormal = new T.Vector3(0, 1, 0);
  const reflectedCamera = new T.PerspectiveCamera();
  const reflectedPlane = new T.Plane();
  const view = new T.Vector3(), cameraPosition = new T.Vector3(), previousCameraPosition = new T.Vector3(), forwardPoint = new T.Vector3();
  const target = new T.Vector3(), rotation = new T.Matrix4(), clip = new T.Vector4(), q = new T.Vector4();
  const projectionTextureMatrix = new T.Matrix4();
  const lastCameraMatrix = new T.Matrix4(), lastProjectionMatrix = new T.Matrix4();
  const drawingSize = new T.Vector2(), savedViewport = new T.Vector4(), savedScissor = new T.Vector4();
  const supportsHDR = renderer.extensions.has('EXT_color_buffer_float');
  const reflectionTarget = new T.WebGLRenderTarget(1, 1, {
    type: supportsHDR ? T.HalfFloatType : T.UnsignedByteType,
    minFilter: T.LinearFilter, magFilter: T.LinearFilter,
    depthBuffer: true, stencilBuffer: false,
  });
  reflectionTarget.texture.name = 'Finished floor linear rough reflection';
  reflectionTarget.texture.colorSpace = T.LinearSRGBColorSpace;
  const uniforms = {
    floorReflectionMap: { value: reflectionTarget.texture },
    floorReflectionMatrix: { value: projectionTextureMatrix },
    floorReflectionTexel: { value: new T.Vector2(1, 1) },
    floorReflectionStrength: { value: 0 },
  };
  let enabled = true, strength = 0.12, valid = false, disposed = false, rendering = false;
  let frames = 0, lastUpdateFrame = -100, updateCount = 0;
  const patchedMaterials = [];

  for (const material of new Set(Array.isArray(floorMesh.material) ? floorMesh.material : [floorMesh.material])) {
    const originalCompile = material.onBeforeCompile;
    const originalCacheKey = material.customProgramCacheKey;
    material.onBeforeCompile = function (shader, activeRenderer) {
      originalCompile.call(this, shader, activeRenderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader.replace('#include <common>', /* glsl */`
        #include <common>
        uniform mat4 floorReflectionMatrix;
        varying vec4 vFloorReflectionCoord;
        varying vec3 vFloorReflectionWorldPosition;
        varying vec3 vFloorReflectionWorldNormal;
      `).replace('#include <worldpos_vertex>', /* glsl */`
        #include <worldpos_vertex>
        vec4 floorReflectionWorld = modelMatrix * vec4(transformed, 1.0);
        vFloorReflectionWorldPosition = floorReflectionWorld.xyz;
        vFloorReflectionWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
        vFloorReflectionCoord = floorReflectionMatrix * floorReflectionWorld;
      `);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', /* glsl */`
        #include <common>
        uniform sampler2D floorReflectionMap;
        uniform vec2 floorReflectionTexel;
        uniform float floorReflectionStrength;
        varying vec4 vFloorReflectionCoord;
        varying vec3 vFloorReflectionWorldPosition;
        varying vec3 vFloorReflectionWorldNormal;
      `).replace('#include <opaque_fragment>', /* glsl */`
        if (floorReflectionStrength > 0.0001 && vFloorReflectionCoord.w > 0.0) {
          vec2 floorReflectionUv = vFloorReflectionCoord.xy / vFloorReflectionCoord.w;
          vec3 floorWorldNormal = normalize(vFloorReflectionWorldNormal);
          float floorTopFace = smoothstep(0.8, 0.98, floorWorldNormal.y);
          if (floorTopFace > 0.0 && all(greaterThan(floorReflectionUv, vec2(0.0))) && all(lessThan(floorReflectionUv, vec2(1.0)))) {
            vec2 spread = floorReflectionTexel * (2.0 + roughnessFactor * 6.0);
            vec3 reflectedLight = texture2D(floorReflectionMap, floorReflectionUv).rgb * 4.0;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv + vec2(spread.x, 0.0)).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv - vec2(spread.x, 0.0)).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv + vec2(0.0, spread.y)).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv - vec2(0.0, spread.y)).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv + spread * 0.7071).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv - spread * 0.7071).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv + vec2(spread.x, -spread.y) * 0.7071).rgb;
            reflectedLight += texture2D(floorReflectionMap, floorReflectionUv + vec2(-spread.x, spread.y) * 0.7071).rgb;
            reflectedLight /= 12.0;
            vec3 floorViewDirection = normalize(cameraPosition - vFloorReflectionWorldPosition);
            float floorFacing = clamp(abs(dot(floorWorldNormal, floorViewDirection)), 0.0, 1.0);
            float softFresnel = 0.25 + 0.75 * pow(1.0 - floorFacing, 3.0);
            vec2 edgeDistance = min(floorReflectionUv, 1.0 - floorReflectionUv);
            float edgeFade = smoothstep(0.0, 0.035, min(edgeDistance.x, edgeDistance.y));
            float reflectionWeight = floorReflectionStrength * softFresnel * edgeFade * floorTopFace;
            outgoingLight = mix(outgoingLight, reflectedLight, reflectionWeight);
          }
        }
        #include <opaque_fragment>
      `);
    };
    material.customProgramCacheKey = function () {
      return `${originalCacheKey.call(this)}|factory-finished-floor-reflection-v1`;
    };
    material.needsUpdate = true;
    patchedMaterials.push({ material, originalCompile, originalCacheKey });
  }

  function cameraChanged(camera) {
    const current = camera.matrixWorld.elements, previous = lastCameraMatrix.elements;
    const projection = camera.projectionMatrix.elements, lastProjection = lastProjectionMatrix.elements;
    for (let i = 0; i < 16; i++) {
      if (Math.abs(current[i] - previous[i]) > 0.0001 || Math.abs(projection[i] - lastProjection[i]) > 0.00001) return true;
    }
    return false;
  }

  const api = {
    get enabled() { return enabled; },
    set enabled(value) { enabled = Boolean(value); uniforms.floorReflectionStrength.value = enabled && valid ? strength : 0; },
    get strength() { return strength; },
    set strength(value) { strength = T.MathUtils.clamp(Number(value) || 0, 0, 0.25); uniforms.floorReflectionStrength.value = enabled && valid ? strength : 0; },
    supported: supportsHDR,
    planeHeight,
    needsUpdate: true,
    lastError: null,
    stats: { width: 1, height: 1, updates: 0, drawcalls: 0, triangles: 0 },
    invalidate() { api.needsUpdate = true; },
    update(camera) {
      frames++;
      if (disposed || rendering || !enabled || !supportsHDR || !camera.isPerspectiveCamera) return false;
      camera.updateWorldMatrix(true, false);
      cameraPosition.setFromMatrixPosition(camera.matrixWorld);
      if (cameraPosition.y <= planeHeight + 0.04) { uniforms.floorReflectionStrength.value = 0; return false; }
      renderer.getDrawingBufferSize(drawingSize);
      const scale = Math.min(0.5, 960 / drawingSize.x, 540 / drawingSize.y);
      const width = Math.max(1, Math.round(drawingSize.x * scale)), height = Math.max(1, Math.round(drawingSize.y * scale));
      const resized = width !== reflectionTarget.width || height !== reflectionTarget.height;
      if (resized) {
        reflectionTarget.setSize(width, height);
        uniforms.floorReflectionTexel.value.set(1 / width, 1 / height);
        api.needsUpdate = true;
      }
      const changed = cameraChanged(camera);
      const jumped = valid && cameraPosition.distanceTo(previousCameraPosition.setFromMatrixPosition(lastCameraMatrix)) > 3;
      if (!api.needsUpdate && !jumped && frames - lastUpdateFrame < 4) return false;
      if (!api.needsUpdate && !changed && updateCount >= 2) return false;

      view.subVectors(planeOrigin, cameraPosition).reflect(planeNormal).negate().add(planeOrigin);
      rotation.extractRotation(camera.matrixWorld);
      forwardPoint.set(0, 0, -1).applyMatrix4(rotation).add(cameraPosition);
      target.subVectors(planeOrigin, forwardPoint).reflect(planeNormal).negate().add(planeOrigin);
      reflectedCamera.position.copy(view);
      reflectedCamera.up.set(0, 1, 0).applyMatrix4(rotation).reflect(planeNormal);
      reflectedCamera.lookAt(target);
      reflectedCamera.near = camera.near; reflectedCamera.far = camera.far;
      reflectedCamera.layers.mask = camera.layers.mask;
      reflectedCamera.updateMatrixWorld();
      reflectedCamera.projectionMatrix.copy(camera.projectionMatrix);
      projectionTextureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
      projectionTextureMatrix.multiply(reflectedCamera.projectionMatrix).multiply(reflectedCamera.matrixWorldInverse);

      // Oblique near-plane clipping keeps all original floor/site surfaces and
      // underground source geometry below the finished floor out of the mirror.
      reflectedPlane.setFromNormalAndCoplanarPoint(planeNormal, planeOrigin);
      reflectedPlane.applyMatrix4(reflectedCamera.matrixWorldInverse);
      clip.set(reflectedPlane.normal.x, reflectedPlane.normal.y, reflectedPlane.normal.z, reflectedPlane.constant);
      const projection = reflectedCamera.projectionMatrix.elements;
      q.set((Math.sign(clip.x) + projection[8]) / projection[0], (Math.sign(clip.y) + projection[9]) / projection[5], -1, (1 + projection[10]) / projection[14]);
      clip.multiplyScalar(2 / clip.dot(q));
      projection[2] = clip.x; projection[6] = clip.y; projection[10] = clip.z + 1 - 0.003; projection[14] = clip.w;
      reflectedCamera.projectionMatrixInverse.copy(reflectedCamera.projectionMatrix).invert();

      const previousTarget = renderer.getRenderTarget(), previousAutoClear = renderer.autoClear;
      const previousScissorTest = renderer.getScissorTest();
      const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate, previousShadowNeedsUpdate = renderer.shadowMap.needsUpdate;
      const previousVisible = floorMesh.visible, previousXREnabled = renderer.xr.enabled;
      renderer.getViewport(savedViewport); renderer.getScissor(savedScissor);
      rendering = true;
      try {
        floorMesh.visible = false;
        renderer.xr.enabled = false; renderer.shadowMap.autoUpdate = false; renderer.shadowMap.needsUpdate = false;
        renderer.autoClear = true; renderer.setScissorTest(false);
        renderer.setRenderTarget(reflectionTarget); renderer.render(scene, reflectedCamera);
        valid = true; updateCount++; lastUpdateFrame = frames; api.needsUpdate = false;
        lastCameraMatrix.copy(camera.matrixWorld); lastProjectionMatrix.copy(camera.projectionMatrix);
        uniforms.floorReflectionStrength.value = strength;
        api.stats = { width, height, updates: updateCount, drawcalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
        return true;
      } catch (error) {
        api.lastError = error.message ?? String(error); api.enabled = false;
        return false;
      } finally {
        floorMesh.visible = previousVisible;
        renderer.setRenderTarget(previousTarget); renderer.setViewport(savedViewport);
        renderer.setScissor(savedScissor); renderer.setScissorTest(previousScissorTest);
        renderer.autoClear = previousAutoClear; renderer.xr.enabled = previousXREnabled;
        renderer.shadowMap.autoUpdate = previousShadowAutoUpdate; renderer.shadowMap.needsUpdate = previousShadowNeedsUpdate;
        rendering = false;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; valid = false; uniforms.floorReflectionStrength.value = 0;
      for (const { material, originalCompile, originalCacheKey } of patchedMaterials) {
        material.onBeforeCompile = originalCompile; material.customProgramCacheKey = originalCacheKey; material.needsUpdate = true;
      }
      reflectionTarget.dispose();
    },
  };
  return api;
}
