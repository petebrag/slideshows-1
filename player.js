(() => {
  'use strict';
  const slides = [...document.querySelectorAll('.slide')];
  const play = document.getElementById('play');
  const status = document.getElementById('status');
  const speed = document.getElementById('speed');
  const mute = document.getElementById('mute');
  const mutedPicker = document.getElementById('muted-slides');
  const restore = document.getElementById('restore-slide');
  const restoreAll = document.getElementById('restore-all');
  const storageKey = `slideshow-muted:v1:${window.location.pathname}`;
  const slideIds = slides.map(slide => slide.dataset.id);
  let muted = new Set();
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) muted = new Set(saved.filter(id => slideIds.includes(id)));
  } catch { /* Playback still works when browser storage is unavailable. */ }
  let index = 0;
  let playing = false;
  let timer = null;
  let wake = null;
  let requestingWake = false;
  let touchX = null;

  function activeIndices() {
    return slides.flatMap((slide, i) => muted.has(slideIds[i]) ? [] : [i]);
  }
  function nextIndex(delta) {
    if (!activeIndices().length) return -1;
    for (let offset = 1; offset <= slides.length; offset++) {
      const candidate = (index + delta * offset + slides.length) % slides.length;
      if (!muted.has(slideIds[candidate])) return candidate;
    }
    return -1;
  }
  function saveMuted() {
    try { window.localStorage.setItem(storageKey, JSON.stringify([...muted])); }
    catch { status.textContent = 'Mute changes apply now but cannot be saved in this browser.'; }
  }

  function show() {
    const active = activeIndices();
    const empty = active.length === 0;
    slides.forEach((slide, i) => { slide.hidden = i !== index; });
    document.getElementById('empty-slides').hidden = !empty;
    document.getElementById('counter').textContent = empty ? 'All slides muted' : `${index + 1} / ${slides.length}` + (muted.size ? ` · ${active.length} active` : '');
    play.disabled = empty;
    mute.disabled = empty;
    for (const id of ['previous', 'next', 'edge-previous', 'edge-next']) document.getElementById(id).disabled = empty;
    const selection = mutedPicker.value;
    const options = slides.flatMap((slide, i) => {
      if (!muted.has(slideIds[i])) return [];
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `Slide ${i + 1}: ${slide.textContent.trim().replace(/\s+/g, ' ').slice(0, 65)}`;
      return [option];
    });
    mutedPicker.replaceChildren(...options);
    if (options.some(option => option.value === selection)) mutedPicker.value = selection;
    mutedPicker.hidden = restore.hidden = restoreAll.hidden = !muted.size;
    mutedPicker.setAttribute('aria-label', `Muted slides (${muted.size})`);
    play.textContent = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', String(playing));
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (playing && index >= 0 && !document.hidden) {
      timer = setTimeout(() => {
        index = nextIndex(1);
        show();
        schedule();
      }, Number(slides[index].dataset.seconds) * 1000 / Number(speed.value));
    }
  }
  async function releaseWake() {
    const held = wake;
    wake = null;
    if (held) { try { await held.release(); } catch { /* Already released by OS. */ } }
  }
  async function requestWake() {
    if (!playing || document.hidden || wake || requestingWake) return;
    if (!('wakeLock' in navigator)) {
      status.textContent = 'Playing · keep this page open. If the screen sleeps, set iPad Auto-Lock to Never.';
      return;
    }
    requestingWake = true;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!playing || document.hidden) { await lock.release(); return; }
      wake = lock;
      lock.addEventListener('release', () => {
        if (wake === lock) wake = null;
        if (playing) status.textContent = 'Playing · screen-awake lock released. Keep the screen awake manually if needed.';
      });
      status.textContent = 'Playing · looping · keeping screen awake';
    } catch {
      if (playing) status.textContent = 'Playing · screen-awake unavailable. iPad: Settings → Display & Brightness → Auto-Lock → Never, if available.';
    } finally { requestingWake = false; }
  }
  function setPlaying(value) {
    playing = value && activeIndices().length > 0;
    show();
    schedule();
    if (playing) {
      status.textContent = 'Playing · loops continuously';
      requestWake();
    } else {
      status.textContent = 'Paused · press Play to resume';
      releaseWake();
    }
  }
  function step(delta) {
    index = nextIndex(delta);
    show();
    schedule();
  }
  mute.addEventListener('click', () => {
    if (index < 0) return;
    muted.add(slideIds[index]);
    index = nextIndex(1);
    if (index < 0) setPlaying(false);
    else { show(); schedule(); }
    saveMuted();
  });
  function restoreMuted(all) {
    const restoredIndex = Number(mutedPicker.value);
    if (all) muted.clear();
    else muted.delete(slideIds[restoredIndex]);
    if (index < 0) index = all ? 0 : restoredIndex;
    show();
    schedule();
    saveMuted();
  }
  restore.addEventListener('click', () => restoreMuted(false));
  restoreAll.addEventListener('click', () => restoreMuted(true));
  play.addEventListener('click', () => setPlaying(!playing));
  document.getElementById('previous').addEventListener('click', () => step(-1));
  document.getElementById('next').addEventListener('click', () => step(1));
  document.getElementById('edge-previous').addEventListener('click', () => step(-1));
  document.getElementById('edge-next').addEventListener('click', () => step(1));
  speed.addEventListener('change', schedule);
  document.addEventListener('visibilitychange', () => {
    schedule();
    if (document.hidden) releaseWake();
    else if (playing) requestWake();
  });
  window.addEventListener('pagehide', () => { clearTimeout(timer); releaseWake(); });
  window.addEventListener('pageshow', () => { schedule(); if (playing) requestWake(); });
  document.addEventListener('keydown', event => {
    if (event.target.closest('input, textarea, select, button, [contenteditable="true"]')) return;
    if (event.key === 'ArrowRight') { event.preventDefault(); step(1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1); }
    if (event.code === 'Space') { event.preventDefault(); setPlaying(!playing); }
  });
  const stage = document.querySelector('.stage');
  stage.addEventListener('touchstart', event => {
    touchX = event.target.closest('.edge-navigation') ? null : event.touches[0].clientX;
  }, {passive: true});
  stage.addEventListener('touchend', event => {
    if (touchX === null) return;
    const delta = event.changedTouches[0].clientX - touchX;
    touchX = null;
    if (Math.abs(delta) > 65) step(delta < 0 ? 1 : -1);
  }, {passive: true});
  const fullscreen = document.getElementById('fullscreen');
  const root = document.documentElement;
  let presenting = false;
  let nativeFullscreen = false;
  let controlsTimer = null;
  function revealControls() {
    clearTimeout(controlsTimer);
    root.classList.remove('controls-hidden');
    if (!presenting) return;
    controlsTimer = setTimeout(() => {
      // Keep the speed picker and document editor usable while interacting.
      if (document.activeElement?.closest('select, [contenteditable="true"]')) {
        revealControls();
        return;
      }
      if (document.activeElement?.closest('.playback, .controls')) stage.focus({preventScroll: true});
      root.classList.add('controls-hidden');
    }, 3000);
  }
  function setPresentation(value) {
    presenting = value;
    root.classList.toggle('presenting', value);
    root.classList.remove('controls-hidden');
    clearTimeout(controlsTimer);
    fullscreen.textContent = value ? 'Exit full screen' : 'Full screen';
    fullscreen.setAttribute('aria-pressed', String(value));
    if (value) {
      stage.focus({preventScroll: true});
      root.classList.add('controls-hidden');
    }
  }
  async function exitPresentation() {
    setPresentation(false);
    if (document.fullscreenElement) await document.exitFullscreen();
  }
  fullscreen.addEventListener('click', async () => {
    if (presenting) { await exitPresentation(); return; }
    setPresentation(true);
    // Content-only view also works on devices without the browser fullscreen API.
    try { await root.requestFullscreen?.(); }
    catch { /* Keep the content-only view within the browser window. */ }
  });
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
      nativeFullscreen = true;
      if (!presenting) setPresentation(true);
    } else if (nativeFullscreen) {
      nativeFullscreen = false;
      setPresentation(false);
    }
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target?.closest('.edge-navigation')) revealControls();
  });
  document.addEventListener('focusin', event => {
    if (presenting && event.target.closest('.playback, .controls')) revealControls();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && presenting) {
      event.preventDefault();
      exitPresentation();
    } else if (presenting && !event.target.closest('.edge-navigation')) revealControls();
  });
  index = muted.has(slideIds[0]) ? nextIndex(1) : 0;
  show();
})();
