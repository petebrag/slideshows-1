const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function player() {
  const elements = new Map();
  const timers = new Map();
  const events = new Map();
  let timerId = 0;
  let requests = 0;
  let releases = 0;
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '1', hidden: false, textContent: '', handlers: {},
      addEventListener(name, callback) { this.handlers[name] = callback; },
      setAttribute(name, value) { this[name] = value; },
      fire(name) { return this.handlers[name]?.({target: this}); },
      closest() { return null; },
      focus() { document.activeElement = this; },
    });
    return elements.get(id);
  }
  const slides = [element('slide1'), element('slide2')];
  slides.forEach(s => { s.dataset = {seconds: '10'}; });
  const document = {
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
    window: {addEventListener() {}},
    setTimeout: (fn, delay) => { timers.set(++timerId, {fn, delay}); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  return {element, slides, timers, document,
    event: (name, event = {}) => events.get(name)?.forEach(callback => callback(event)),
    tick: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); },
    wakeCounts: () => ({requests, releases}),
  };
}

test('autoplay loops and manual navigation pauses without a leftover timer', () => {
  const p = player();
  p.element('play').fire('click');
  assert.equal(p.timers.size, 1);
  p.tick();
  assert.equal(p.element('counter').textContent, '2 / 2');
  p.tick();
  assert.equal(p.element('counter').textContent, '1 / 2');
  p.element('next').fire('click');
  assert.equal(p.element('play').textContent, 'Play');
  assert.equal(p.element('counter').textContent, '2 / 2');
  assert.equal(p.timers.size, 0);
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
  assert.equal(p.element('play').textContent, 'Play');
  assert.equal(p.timers.size, 0);
  p.element('edge-next').fire('click');
  assert.equal(p.element('counter').textContent, '1 / 2');
  assert.equal(p.document.documentElement.classList.contains('controls-hidden'), true);
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
