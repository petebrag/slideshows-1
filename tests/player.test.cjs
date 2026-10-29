const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function player({saved = null, storageFails = false} = {}) {
  const storage = new Map(saved ? [["slideshow-muted:v1:/deck.html", saved]] : []);
  const elements = new Map();
  const timers = new Map();
  const events = new Map();
  let timerId = 0;
  let requests = 0;
  let releases = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '1', hidden: false, textContent: '', handlers: {},
      replaceChildren(...children) { this.children = children; this.value = children[0]?.value || ''; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute(name, value) { this[name] = value; },
      fire(name) { return this.handlers[name]?.({target: this}); },
      closest() { return null; },
      focus() { document.activeElement = this; },
    });
    return elements.get(id);
  }
  const slides = [element('slide1'), element('slide2')];
  slides.forEach((s, i) => { s.dataset = {seconds: '10', id: 'slide-' + i}; s.textContent = 'Slide ' + (i + 1); });
  const document = {
    createElement: () => ({value: '', textContent: ''}),
    hidden: false, documentElement: {classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); },
      toggle(value, enabled) { enabled ? this.add(value) : this.remove(value); },
      contains(value) { return this.values.has(value); },
    }},
    querySelectorAll: () => slides,
    querySelector: () => element('stage'),
    getElementById: element,
    addEventListener: (name, callback) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    },
  };
  const navigator = {wakeLock: {request: async () => {
    requests++;
    let callback;
    return {
      addEventListener: (name, cb) => { callback = cb; },
      release: async () => { releases++; callback?.(); },
    };
  }}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../player.js'), 'utf8'), {
    document, navigator,
    window: {addEventListener() {}, location: {pathname: '/deck.html'}, localStorage: {
      getItem: key => { if (storageFails) throw Error('blocked'); return storage.get(key); },
      setItem: (key, value) => { if (storageFails) throw Error('blocked'); storage.set(key, value); },
    }},
    setTimeout: (fn, delay) => { timers.set(++timerId, {fn, delay}); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  return {element, slides, timers, document, storage,
    event: (name, event = {}) => events.get(name)?.forEach(callback => callback(event)),
    tick: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); },
    wakeCounts: () => ({requests, releases}),
  };
}

test('autoplay loops and navigation replaces the timer without pausing', () => {
  const p = player();
  p.element('play').fire('click');
  assert.equal(p.timers.size, 1);
  p.tick();
  assert.equal(p.element('counter').textContent, '2 / 2');
  p.tick();
  assert.equal(p.element('counter').textContent, '1 / 2');
  p.element('next').fire('click');
  assert.equal(p.element('play').textContent, 'Pause');
  assert.equal(p.element('counter').textContent, '2 / 2');
  assert.equal(p.timers.size, 1);
  p.tick();
  assert.equal(p.element('counter').textContent, '1 / 2');
});

test('content-only mode works without native fullscreen, reveals on tap, and exits', async () => {
  const p = player();
  const classes = p.document.documentElement.classList;
  await p.element('fullscreen').fire('click');
  assert.equal(classes.contains('presenting'), true);
  assert.equal(classes.contains('controls-hidden'), true);
  p.event('pointerdown');
  assert.equal(classes.contains('controls-hidden'), false);
  p.tick();
  assert.equal(classes.contains('controls-hidden'), true);
  p.event('keydown', {key: 'Escape', target: p.element('stage'), preventDefault() {}});
  assert.equal(classes.contains('presenting'), false);
  assert.equal(classes.contains('controls-hidden'), false);
  assert.equal(p.element('fullscreen').textContent, 'Full screen');
  assert.equal(p.timers.size, 0);
});

test('native fullscreen exit restores the regular page without interrupting playback', async () => {
  const p = player();
  const root = p.document.documentElement;
  root.requestFullscreen = async () => {
    p.document.fullscreenElement = root;
    p.event('fullscreenchange');
  };
  p.element('play').fire('click');
  await p.element('fullscreen').fire('click');
  assert.equal(root.classList.contains('controls-hidden'), true);
  p.document.fullscreenElement = null;
  p.event('fullscreenchange');
  assert.equal(root.classList.contains('presenting'), false);
  assert.equal(p.element('play').textContent, 'Pause');
  assert.equal(p.timers.size, 1);
});

test('speed changes replace the current timer, then pause cancels it', () => {
  const p = player();
  p.element('play').fire('click');
  p.element('speed').value = '2';
  p.element('speed').fire('change');
  assert.equal(p.timers.size, 1);
  assert.equal([...p.timers.values()][0].delay, 5000);
  p.element('play').fire('click');
  assert.equal(p.timers.size, 0);
});

test('edge chevrons navigate and wrap with fullscreen controls hidden', async () => {
  const p = player();
  p.element('play').fire('click');
  await p.element('fullscreen').fire('click');
  p.element('edge-previous').fire('click');
  assert.equal(p.element('counter').textContent, '2 / 2');
  assert.equal(p.element('play').textContent, 'Pause');
  assert.equal(p.timers.size, 1);
  p.element('edge-next').fire('click');
  assert.equal(p.element('counter').textContent, '1 / 2');
  assert.equal(p.document.documentElement.classList.contains('controls-hidden'), true);
});

test('navigation preserves explicit pause and gives each new slide its full interval', () => {
  const p = player();
  p.element('edge-next').fire('click');
  assert.equal(p.element('play').textContent, 'Play');
  assert.equal(p.timers.size, 0);
  p.slides[0].dataset.seconds = '24';
  p.element('speed').value = '2';
  p.element('play').fire('click');
  const priorTimer = [...p.timers.keys()][0];
  p.element('edge-previous').fire('click');
  assert.equal(p.timers.has(priorTimer), false);
  assert.equal(p.timers.size, 1);
  assert.equal([...p.timers.values()][0].delay, 12000);
  p.element('play').fire('click');
  p.element('next').fire('click');
  assert.equal(p.element('play').textContent, 'Play');
  assert.equal(p.timers.size, 0);
});

test('a full side-arrow interaction navigates once without revealing fullscreen controls', async () => {
  const p = player();
  p.element('play').fire('click');
  await p.element('fullscreen').fire('click');
  const classes = p.document.documentElement.classList;
  for (const direction of ['next', 'previous']) {
    const button = p.element('edge-' + direction);
    // Browsers can target the SVG polyline inside the button.
    const target = {closest: selector => selector === '.edge-navigation' || selector.includes('button') ? button : null};
    p.event('pointerdown', {target});
    p.event('focusin', {target});
    assert.equal(classes.contains('controls-hidden'), true);
    p.event('keydown', {target, key: 'Enter'});
    assert.equal(classes.contains('controls-hidden'), true);
    button.fire('click');
    assert.equal(p.element('counter').textContent, direction === 'next' ? '2 / 2' : '1 / 2');
    assert.equal(p.element('play').textContent, 'Pause');
    assert.equal(p.timers.size, 1);
  }
  p.event('pointerdown', {target: p.element('stage')});
  assert.equal(classes.contains('controls-hidden'), false);
});

test('hidden pages stop advancing and visible pages reacquire wake lock', async () => {
  const p = player();
  p.element('play').fire('click');
  await new Promise(setImmediate);
  p.document.hidden = true;
  p.event('visibilitychange');
  await new Promise(setImmediate);
  assert.equal(p.timers.size, 0);
  assert.equal(p.wakeCounts().releases, 1);
  p.document.hidden = false;
  p.event('visibilitychange');
  await new Promise(setImmediate);
  assert.equal(p.wakeCounts().requests, 2);
  assert.equal(p.element('counter').textContent, '1 / 2');
  assert.equal(p.timers.size, 1);
});

test('pausing during an outstanding wake request releases the late lock', async () => {
  const p = player();
  p.element('play').fire('click');
  p.element('play').fire('click');
  await new Promise(setImmediate);
  assert.equal(p.wakeCounts().releases, 1);
  assert.equal(p.element('play').textContent, 'Play');
  assert.equal(p.timers.size, 0);
});


test('mute skips current slide in autoplay and both navigation directions; restore resumes inclusion', () => {
  const p = player();
  p.element('play').fire('click');
  p.element('mute').fire('click');
  assert.equal(p.slides[0].hidden, true);
  assert.equal(p.slides[1].hidden, false);
  assert.equal(p.element('play').textContent, 'Pause');
  p.tick();
  assert.equal(p.slides[1].hidden, false);
  p.element('previous').fire('click');
  assert.equal(p.slides[1].hidden, false);
  p.element('next').fire('click');
  assert.equal(p.slides[1].hidden, false);
  assert.equal(p.element('muted-slides').children.length, 1);
  p.element('restore-slide').fire('click');
  p.tick();
  assert.equal(p.element('counter').textContent, '1 / 2');
  assert.equal(p.element('restore-slide').hidden, true);
});

test('muted slides persist across reloads and stale IDs are ignored', () => {
  const p = player();
  p.element('mute').fire('click');
  const saved = p.storage.get('slideshow-muted:v1:/deck.html');
  const reloaded = player({saved});
  assert.equal(reloaded.slides[0].hidden, true);
  assert.equal(reloaded.slides[1].hidden, false);
  const stale = player({saved: '["old-slide"]'});
  assert.equal(stale.element('counter').textContent, '1 / 2');
});

test('all muted pauses safely; restoring one or all makes playback available', () => {
  const p = player();
  p.element('play').fire('click');
  p.element('mute').fire('click');
  p.element('mute').fire('click');
  assert.equal(p.slides.every(slide => slide.hidden), true);
  assert.equal(p.element('empty-slides').hidden, false);
  assert.equal(p.element('play').disabled, true);
  assert.equal(p.timers.size, 0);
  p.element('next').fire('click');
  assert.equal(p.element('counter').textContent, 'All slides muted');
  p.element('muted-slides').value = '1';
  p.element('restore-slide').fire('click');
  assert.equal(p.slides[1].hidden, false);
  assert.equal(p.element('play').disabled, false);
  assert.equal(p.element('play').textContent, 'Play');
  p.element('restore-all').fire('click');
  assert.equal(p.element('restore-all').hidden, true);
  p.element('next').fire('click');
  assert.equal(p.element('counter').textContent, '1 / 2');
});

test('invalid or unavailable storage does not break muting or restoring', () => {
  for (const config of [{saved: '{bad'}, {saved: '{}'}, {storageFails: true}]) {
    const p = player(config);
    p.element('mute').fire('click');
    assert.equal(p.slides[0].hidden, true);
    p.element('restore-all').fire('click');
    p.element('previous').fire('click');
    assert.equal(p.slides[0].hidden, false);
  }
});
