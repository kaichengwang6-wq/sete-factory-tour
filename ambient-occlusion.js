/**
 * Half-resolution, depth-aware contact occlusion for a metre-scale scene.
 * No extra scene/normal pass: transparent glass with depthWrite=false does not
 * become an occluder. The linear HDR scene is tone-mapped/sRGB encoded once,
 * in the final composite, using the renderer's own current output settings.
 *
 * const ao = createAmbientOcclusion(THREE, renderer);
 * ao.enabled = true; // defaults to the direct-render fallback
 * const sourceStats = ao.render(scene, camera);
 *
 * setSize() takes physical drawing-buffer pixels. Canvas resizing and adaptive
 * renderer pixel-ratio changes are also detected automatically by render().
 */
export function createAmbientOcclusion(T, renderer) {
  const vertexShader = /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  const depthUtilities = /* glsl */`
    uniform sampler2D tDepth;
    uniform mat4 inverseProjection;
    uniform vec2 sourceResolution;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform float isPerspective;
    float linearDepth(float depth) {
      float perspectiveZ = (cameraNear * cameraFar) /
        (cameraFar - depth * (cameraFar - cameraNear));
      return mix(mix(cameraNear, cameraFar, depth), perspectiveZ, isPerspective);
    }
    vec3 viewPosition(vec2 uv, float depth) {
      vec4 p = inverseProjection * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      return p.xyz / p.w;
    }
  `;

  const aoFragment = /* glsl */`
    varying vec2 vUv;
    ${depthUtilities}
    uniform vec2 projectionScale;
    uniform float radius;
    uniform float intensity;
    uniform float maxOcclusion;

    vec3 stableNormal(vec2 uv, vec3 p) {
      vec2 texel = 1.0 / sourceResolution;
      vec2 rightUv = clamp(uv + vec2(texel.x, 0.0), texel * 0.5, 1.0 - texel * 0.5);
      vec2 leftUv = clamp(uv - vec2(texel.x, 0.0), texel * 0.5, 1.0 - texel * 0.5);
      vec2 upUv = clamp(uv + vec2(0.0, texel.y), texel * 0.5, 1.0 - texel * 0.5);
      vec2 downUv = clamp(uv - vec2(0.0, texel.y), texel * 0.5, 1.0 - texel * 0.5);
      vec3 right = viewPosition(rightUv, texture2D(tDepth, rightUv).r) - p;
      vec3 left = p - viewPosition(leftUv, texture2D(tDepth, leftUv).r);
      vec3 up = viewPosition(upUv, texture2D(tDepth, upUv).r) - p;
      vec3 down = p - viewPosition(downUv, texture2D(tDepth, downUv).r);
      vec3 dx = abs(right.z) < abs(left.z) ? right : left;
      vec3 dy = abs(up.z) < abs(down.z) ? up : down;
      vec3 crossProduct = cross(dx, dy);
      vec3 normal = crossProduct / max(length(crossProduct), 1e-7);
      return dot(normal, -p) < 0.0 ? -normal : normal;
    }

    void main() {
      float depth = texture2D(tDepth, vUv).r;
      float distanceToCamera = linearDepth(depth);
      if (depth >= 0.9999998) {
        gl_FragColor = vec4(1.0, min(cameraFar, 65000.0), 0.0, 1.0);
        return;
      }
      vec3 position = viewPosition(vUv, depth);
      vec3 normal = stableNormal(vUv, position);
      float projectionDistance = mix(1.0, max(-position.z, 0.05), isPerspective);
      vec2 screenRadius = projectionScale * radius * 0.5 / projectionDistance;
      // No temporal noise. A fixed interleaved rotation breaks directional bands.
      float noise = fract(52.9829189 * fract(dot(floor(vUv * sourceResolution * 0.5), vec2(0.06711056, 0.00583715))));
      float occlusion = 0.0;
      for (int i = 0; i < 12; i++) {
        float fi = float(i) + 0.5;
        float angle = fi * 2.39996323 + noise * 6.28318531;
        float spread = sqrt(fi / 12.0);
        vec2 sampleUv = vUv + vec2(cos(angle), sin(angle)) * screenRadius * spread;
        if (sampleUv.x <= 0.0 || sampleUv.x >= 1.0 || sampleUv.y <= 0.0 || sampleUv.y >= 1.0) continue;
        float sampleDepth = texture2D(tDepth, sampleUv).r;
        if (sampleDepth >= 0.9999998) continue;
        vec3 delta = viewPosition(sampleUv, sampleDepth) - position;
        float distance = length(delta);
        float rangeWeight = 1.0 - smoothstep(radius * 0.12, radius, distance);
        float normalWeight = max(dot(normal, delta) / max(distance, 0.015) - 0.08, 0.0);
        // Reject same-surface numerical noise and distant silhouettes explicitly.
        float biasWeight = smoothstep(0.015, 0.045, distance);
        occlusion += normalWeight * rangeWeight * biasWeight;
      }
      float visibility = 1.0 - min(maxOcclusion, occlusion * intensity / 12.0);
      // Green carries positive view depth for bilateral filtering/upsampling.
      gl_FragColor = vec4(visibility, min(distanceToCamera, 65000.0), 0.0, 1.0);
    }
  `;

  const blurFragment = /* glsl */`
    varying vec2 vUv;
    uniform sampler2D tAO;
    uniform vec2 aoResolution;
    uniform float radius;
    void main() {
      vec2 center = texture2D(tAO, vUv).rg;
      float sum = 0.0, weightSum = 0.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 sampleUv = clamp(vUv + vec2(float(x), float(y)) / aoResolution, 0.5 / aoResolution, 1.0 - 0.5 / aoResolution);
          vec2 sampleValue = texture2D(tAO, sampleUv).rg;
          float spatialWeight = (x == 0 ? 2.0 : 1.0) * (y == 0 ? 2.0 : 1.0);
          float depthWeight = exp(-abs(sampleValue.g - center.g) * 8.0 / max(radius, 0.1));
          float weight = spatialWeight * depthWeight;
          sum += sampleValue.r * weight;
          weightSum += weight;
        }
      }
      gl_FragColor = vec4(sum / max(weightSum, 1e-5), center.g, 0.0, 1.0);
    }
  `;

  const compositeFragment = /* glsl */`
    varying vec2 vUv;
    ${depthUtilities}
    uniform sampler2D tScene;
    uniform sampler2D tAO;
    uniform vec2 aoResolution;
    uniform float radius;
    uniform float backgroundIsColor;
    uniform float bloomStrength;
    uniform float bloomThreshold;
    void main() {
      vec4 color = texture2D(tScene, vUv);
      float deviceDepth = texture2D(tDepth, vUv).r;
      // THREE clears a flat Color background without tone mapping. Preserve it
      // exactly rather than accidentally grading the sky a second way.
      if (deviceDepth >= 0.9999998 && backgroundIsColor > 0.5) {
        gl_FragColor = color;
        #include <colorspace_fragment>
        return;
      }
      float fullDepth = linearDepth(deviceDepth);
      vec2 grid = vUv * aoResolution - 0.5;
      vec2 base = floor(grid), fraction = fract(grid);
      float sum = 0.0, weightSum = 0.0;
      // Joint bilateral upscale: foreground AO never paints distant wall edges.
      for (int y = 0; y < 2; y++) {
        for (int x = 0; x < 2; x++) {
          vec2 offset = vec2(float(x), float(y));
          vec2 sampleUv = clamp((base + offset + 0.5) / aoResolution, 0.5 / aoResolution, 1.0 - 0.5 / aoResolution);
          vec2 sampleValue = texture2D(tAO, sampleUv).rg;
          vec2 bilinear = mix(1.0 - fraction, fraction, offset);
          float depthWeight = exp(-abs(sampleValue.g - fullDepth) * 8.0 / max(radius, 0.1));
          float weight = bilinear.x * bilinear.y * depthWeight;
          sum += sampleValue.r * weight;
          weightSum += weight;
        }
      }
      float visibility = weightSum > 1e-4 ? sum / weightSum : 1.0;
      vec3 glow = vec3(0.0);
      if (bloomStrength > 0.0001) {
        // Eight bounded HDR taps add only a small optical glow around emitters.
        // This is deliberately not a broad bloom that washes out white paint.
        for (int i = 0; i < 8; i++) {
          float angle = (float(i) + 0.5) * 0.78539816;
          vec2 glowUv = clamp(vUv + vec2(cos(angle), sin(angle)) * 5.5 / sourceResolution, 0.0, 1.0);
          vec3 glowSample = texture2D(tScene, glowUv).rgb;
          float luminance = dot(glowSample, vec3(0.2126, 0.7152, 0.0722));
          glow += glowSample * max(luminance - bloomThreshold, 0.0) / max(luminance, 0.001);
        }
        glow = min(glow / 8.0, vec3(1.0));
      }
      gl_FragColor = vec4(color.rgb * clamp(visibility, 0.65, 1.0) + glow * bloomStrength, color.a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `;

  const supportsHDR = renderer.extensions.has('EXT_color_buffer_float');
  const sourceTarget = new T.WebGLRenderTarget(1, 1, {
    type: supportsHDR ? T.HalfFloatType : T.UnsignedByteType,
    format: T.RGBAFormat,
    minFilter: T.LinearFilter,
    magFilter: T.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    samples: Math.min(4, renderer.capabilities.maxSamples ?? 0),
  });
  sourceTarget.texture.name = 'Factory AO linear HDR scene';
  sourceTarget.texture.colorSpace = T.LinearSRGBColorSpace;
  sourceTarget.depthTexture = new T.DepthTexture(1, 1, T.UnsignedIntType);
  sourceTarget.depthTexture.format = T.DepthFormat;
  sourceTarget.depthTexture.minFilter = T.NearestFilter;
  sourceTarget.depthTexture.magFilter = T.NearestFilter;
  sourceTarget.resolveDepthBuffer = true;

  const createAOTarget = () => new T.WebGLRenderTarget(1, 1, {
    type: T.HalfFloatType,
    minFilter: T.NearestFilter,
    magFilter: T.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const aoTarget = createAOTarget(), blurredTarget = createAOTarget();
  const fullSize = new T.Vector2(1, 1), halfSize = new T.Vector2(1, 1);
  const drawingSize = new T.Vector2(), viewport = new T.Vector4(), scissor = new T.Vector4();
  const shared = {
    tDepth: { value: sourceTarget.depthTexture },
    inverseProjection: { value: new T.Matrix4() },
    sourceResolution: { value: fullSize },
    cameraNear: { value: 0.08 }, cameraFar: { value: 1700 },
    isPerspective: { value: 1 }, radius: { value: 0.8 },
  };
  const material = (fragmentShader, uniforms, toneMapped = false) => new T.ShaderMaterial({
    vertexShader, fragmentShader, uniforms, toneMapped,
    depthTest: false, depthWrite: false, blending: T.NoBlending,
  });
  const aoMaterial = material(aoFragment, {
    ...shared, projectionScale: { value: new T.Vector2() },
    intensity: { value: 1.9 }, maxOcclusion: { value: 0.28 },
  });
  const blurMaterial = material(blurFragment, {
    tAO: { value: aoTarget.texture }, aoResolution: { value: halfSize }, radius: shared.radius,
  });
  const compositeMaterial = material(compositeFragment, {
    ...shared, tScene: { value: sourceTarget.texture }, tAO: { value: blurredTarget.texture },
    aoResolution: { value: halfSize },
    backgroundIsColor: { value: 0 }, bloomStrength: { value: 0.055 }, bloomThreshold: { value: 1.6 },
  }, true);
  const triangle = new T.BufferGeometry();
  triangle.setAttribute('position', new T.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  triangle.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
  const screenScene = new T.Scene(), screenCamera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new T.Mesh(triangle, aoMaterial); quad.frustumCulled = false; screenScene.add(quad);
  let disposed = false;

  function sourceStatistics() {
    return { drawcalls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  }

  const api = {
    enabled: false,
    supported: supportsHDR,
    radius: 0.8,
    intensity: 1.9,
    maxOcclusion: 0.28,
    bloomStrength: 0.055,
    bloomThreshold: 1.6,
    lastError: null,
    setSize(width, height) {
      const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
      if (w === fullSize.x && h === fullSize.y) return;
      fullSize.set(w, h); halfSize.set(Math.max(1, Math.ceil(w / 2)), Math.max(1, Math.ceil(h / 2)));
      sourceTarget.setSize(w, h); aoTarget.setSize(halfSize.x, halfSize.y); blurredTarget.setSize(halfSize.x, halfSize.y);
    },
    render(scene, camera) {
      if (disposed || !api.enabled || !api.supported) {
        renderer.render(scene, camera);
        return { ...sourceStatistics(), ambientOcclusion: false };
      }
      const destination = renderer.getRenderTarget();
      if (destination) api.setSize(destination.width, destination.height);
      else { renderer.getDrawingBufferSize(drawingSize); api.setSize(drawingSize.x, drawingSize.y); }
      const previousAutoClear = renderer.autoClear;
      const previousScissorTest = renderer.getScissorTest();
      renderer.getViewport(viewport); renderer.getScissor(scissor);
      shared.inverseProjection.value.copy(camera.projectionMatrixInverse);
      shared.cameraNear.value = camera.near; shared.cameraFar.value = camera.far;
      shared.isPerspective.value = camera.isPerspectiveCamera ? 1 : 0;
      shared.radius.value = T.MathUtils.clamp(api.radius, 0.2, 2.0);
      aoMaterial.uniforms.intensity.value = T.MathUtils.clamp(api.intensity, 0, 4);
      aoMaterial.uniforms.maxOcclusion.value = T.MathUtils.clamp(api.maxOcclusion, 0, 0.35);
      aoMaterial.uniforms.projectionScale.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
      compositeMaterial.uniforms.backgroundIsColor.value = scene.background?.isColor ? 1 : 0;
      compositeMaterial.uniforms.bloomStrength.value = T.MathUtils.clamp(api.bloomStrength, 0, 0.12);
      compositeMaterial.uniforms.bloomThreshold.value = Math.max(1, api.bloomThreshold);
      let statistics;
      try {
        renderer.autoClear = true; renderer.setScissorTest(false);
        renderer.setRenderTarget(sourceTarget);
        renderer.render(scene, camera);
        statistics = sourceStatistics();
        quad.material = aoMaterial; renderer.setRenderTarget(aoTarget); renderer.render(screenScene, screenCamera);
        quad.material = blurMaterial; renderer.setRenderTarget(blurredTarget); renderer.render(screenScene, screenCamera);
        quad.material = compositeMaterial; renderer.setRenderTarget(destination);
        renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(previousScissorTest);
        renderer.render(screenScene, screenCamera);
        return { ...statistics, ambientOcclusion: true, postprocessPasses: 3 };
      } catch (error) {
        api.lastError = error.message ?? String(error); api.enabled = false;
        renderer.setRenderTarget(destination); renderer.setViewport(viewport);
        renderer.setScissor(scissor); renderer.setScissorTest(previousScissorTest);
        renderer.render(scene, camera);
        return { ...sourceStatistics(), ambientOcclusion: false, error: api.lastError };
      } finally {
        renderer.setRenderTarget(destination); renderer.setViewport(viewport);
        renderer.setScissor(scissor); renderer.setScissorTest(previousScissorTest);
        renderer.autoClear = previousAutoClear;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true; sourceTarget.dispose(); sourceTarget.depthTexture.dispose();
      aoTarget.dispose(); blurredTarget.dispose(); triangle.dispose();
      aoMaterial.dispose(); blurMaterial.dispose(); compositeMaterial.dispose();
    },
  };
  return api;
}
