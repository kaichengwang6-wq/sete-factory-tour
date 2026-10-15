const STORAGE_KEY = 'sete-factory-bgm-v1';
const clamp = (value) => Math.max(0, Math.min(1, value));

/** Music is unlocked by a deliberate presentation action, never by page load. */
export function createBgmController({ src = './assets/sete-ambient.mp3', onFocus = () => {} } = {}) {
  const root = document.getElementById('musicControl');
  const toggle = document.getElementById('musicToggleButton');
  const label = document.getElementById('musicToggleLabel');
  const statusText = document.getElementById('musicStatus');
  const volumeButton = document.getElementById('musicVolumeButton');
  const panel = document.getElementById('musicVolumePanel');
  const slider = document.getElementById('musicVolume');
  const volumeText = document.getElementById('musicVolumeValue');
  let preferences = {};
  try { preferences = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch {}
  let volume = Number.isFinite(preferences.volume) ? clamp(preferences.volume) : .25;
  let userDisabled = preferences.disabled === true;
  let allowed = false, status = 'idle', lastError = '', resumeOnVisible = false;
  let generation = 0, fadeFrame = 0, level = 0, disposed = false;
  let context = null, gain = null, source = null;
  const listeners = [];
  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'none';
  audio.volume = 0;
  audio.setAttribute('playsinline', '');

  function listen(target, type, callback, options) {
    target?.addEventListener(type, callback, options);
    listeners.push(() => target?.removeEventListener(type, callback, options));
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ volume, disabled: userDisabled })); } catch {}
  }
  function setLevel(value) {
    level = clamp(value);
    if (gain) gain.gain.setValueAtTime(level, context.currentTime);
    else audio.volume = level;
  }
  function cancelFade() { cancelAnimationFrame(fadeFrame); fadeFrame = 0; }
  function fadeTo(target, duration, complete) {
    cancelFade();
    const initial = level, started = performance.now();
    function frame(now) {
      const progress = Math.min(1, (now - started) / duration);
      const eased = progress * progress * (3 - 2 * progress);
      setLevel(initial + (target - initial) * eased);
      if (progress < 1) fadeFrame = requestAnimationFrame(frame);
      else { fadeFrame = 0; complete?.(); }
    }
    fadeFrame = requestAnimationFrame(frame);
  }
  function prepareAudio() {
    if (!audio.getAttribute('src')) audio.src = src;
    else if (audio.error) audio.load();
    // A gain node keeps the volume slider effective on mobile browsers as well.
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!context && AudioContextClass) {
      let nextContext;
      try {
        nextContext = new AudioContextClass();
        const nextGain = nextContext.createGain();
        const nextSource = nextContext.createMediaElementSource(audio);
        nextGain.gain.value = 0;
        nextSource.connect(nextGain); nextGain.connect(nextContext.destination);
        context = nextContext; gain = nextGain; source = nextSource;
        audio.volume = 1;
      } catch { nextContext?.close().catch(() => {}); }
    }
  }
  function render() {
    const active = allowed && !userDisabled && ['starting', 'playing', 'suspended'].includes(status);
    let text = active ? '关闭音乐' : status === 'blocked' ? '点击播放' : status === 'error' ? '重试音乐' : '播放音乐';
    const descriptions = {
      idle: userDisabled ? '音乐已关闭' : '开始展示时轻柔播放',
      starting: '正在准备背景音乐',
      playing: volume === 0 ? '背景音乐 · 音量为零' : '背景音乐 · 循环播放',
      suspended: '页面离开时暂停音乐',
      blocked: '请点击播放音乐',
      error: '音乐暂未加载，可点击重试',
    };
    if (label) label.textContent = text;
    if (toggle) {
      toggle.setAttribute('aria-label', text);
      toggle.setAttribute('aria-pressed', String(active));
      toggle.title = descriptions[status] || descriptions.idle;
    }
    if (statusText) statusText.textContent = descriptions[status] || descriptions.idle;
    root?.classList.toggle('music-playing', active);
    if (root) root.dataset.state = status;
    if (slider) {
      slider.value = String(Math.round(volume * 100));
      slider.setAttribute('aria-valuetext', `${Math.round(volume * 100)}%`);
    }
    if (volumeText) volumeText.textContent = `${Math.round(volume * 100)}%`;
  }
  async function requestPlayback() {
    if (disposed || userDisabled || !allowed || document.hidden) return false;
    const token = ++generation;
    cancelFade();
    status = 'starting'; lastError = '';
    render();
    try {
      prepareAudio();
      setLevel(0);
      // Both requests happen in the original gesture stack, before any await.
      const resume = context && context.state !== 'running' ? context.resume() : Promise.resolve();
      resume.catch(() => {});
      const playback = audio.play();
      await Promise.all([resume, playback]);
      if (token !== generation || disposed) return false;
      if (!allowed || userDisabled || document.hidden) { audio.pause(); return false; }
      status = 'playing'; resumeOnVisible = false;
      fadeTo(volume, 1100);
      render();
      return true;
    } catch (error) {
      if (token !== generation || disposed) return false;
      cancelFade(); setLevel(0); audio.pause();
      lastError = error?.name || 'PlaybackError';
      status = error?.name === 'NotAllowedError' ? 'blocked' : 'error';
      render();
      return false;
    }
  }
  function beginFromInteraction() {
    if (disposed || userDisabled || document.hidden) return Promise.resolve(false);
    if (navigator.userActivation && !navigator.userActivation.isActive) return Promise.resolve(false);
    if (['playing', 'starting'].includes(status)) return Promise.resolve(true);
    allowed = true;
    return requestPlayback();
  }
  function turnOff() {
    generation++; allowed = false; userDisabled = true; resumeOnVisible = false;
    status = 'idle'; lastError = ''; persist(); render();
    if (audio.paused || document.hidden) { cancelFade(); setLevel(0); audio.pause(); }
    else fadeTo(0, 380, () => { if (!allowed) audio.pause(); });
  }
  function toggleMusic() {
    if (allowed && ['starting', 'playing', 'suspended'].includes(status)) { turnOff(); return; }
    userDisabled = false; allowed = true; persist();
    void requestPlayback();
  }
  function setVolume(value) {
    volume = clamp(Number(value) / 100);
    persist();
    if (status === 'playing') fadeTo(volume, 100);
    render();
  }
  function suspend() {
    if (disposed) return;
    resumeOnVisible = allowed && !userDisabled && ['starting', 'playing', 'suspended'].includes(status);
    generation++; cancelFade(); setLevel(0); audio.pause();
    if (resumeOnVisible) status = 'suspended';
    render();
  }
  function resume() {
    if (resumeOnVisible && allowed && !userDisabled && !document.hidden) {
      resumeOnVisible = false;
      void requestPlayback();
    }
  }
  function showVolume(open) {
    if (!panel || !volumeButton) return;
    panel.hidden = !open;
    volumeButton.setAttribute('aria-expanded', String(open));
  }
  listen(toggle, 'click', toggleMusic);
  listen(volumeButton, 'click', () => showVolume(panel?.hidden));
  listen(slider, 'input', () => setVolume(slider.value));
  listen(root, 'focusin', onFocus);
  listen(root, 'keydown', (event) => {
    // Preserve native slider arrows/button Space; never steer the camera here.
    event.stopPropagation();
    if (event.key === 'Escape') { showVolume(false); volumeButton?.focus(); }
  });
  listen(document, 'pointerdown', (event) => { if (root && !root.contains(event.target)) showVolume(false); });
  listen(document, 'visibilitychange', () => document.hidden ? suspend() : resume());
  listen(window, 'pagehide', suspend);
  listen(window, 'pageshow', resume);
  listen(audio, 'error', () => {
    if (disposed || !allowed) return;
    generation++; cancelFade(); setLevel(0); audio.pause();
    status = 'error'; lastError = `MediaError:${audio.error?.code || 'unknown'}`;
    render();
  });
  render();

  return Object.freeze({
    beginFromInteraction,
    snapshot() {
      return Object.freeze({ status, volume, userDisabled, allowed, playing: !audio.paused,
        currentTime: audio.currentTime, resumeOnVisible, lastError, contextState: context?.state || 'none' });
    },
    dispose() {
      disposed = true; generation++; cancelFade(); audio.pause();
      listeners.forEach((remove) => remove());
      source?.disconnect(); gain?.disconnect();
      context?.close().catch(() => {});
      audio.removeAttribute('src'); audio.load();
    },
  });
}
