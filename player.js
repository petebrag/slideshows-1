(() => {
  'use strict';
  const slides = [...document.querySelectorAll('.slide')];
  const play = document.getElementById('play');
  const status = document.getElementById('status');
  const speed = document.getElementById('speed');
  let index = 0;
  let playing = false;
  let timer = null;
  let wake = null;
  let requestingWake = false;
  let touchX = null;

  function show() {
    slides.forEach((slide, i) => { slide.hidden = i !== index; });
    document.getElementById('counter').textContent = `${index + 1} / ${slides.length}`;
    play.textContent = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-pressed', String(playing));
  }
  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (playing && !document.hidden) {
      timer = setTimeout(() => {
        index = (index + 1) % slides.length;
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
    playing = value;
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
    index = (index + delta + slides.length) % slides.length;
    show();
    schedule();
  }
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
  show();
})();
