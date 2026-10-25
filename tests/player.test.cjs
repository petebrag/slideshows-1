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
      fire(name) { this.handlers[name]?.({target: this}); },
    });
    return elements.get(id);
  }
  const slides = [element('slide1'), element('slide2')];
  slides.forEach(s => { s.dataset = {seconds: '10'}; });
  const document = {
    hidden: false, documentElement: {},
    querySelectorAll: () => slides,
    querySelector: () => element('stage'),
    getElementById: element,
    addEventListener: (name, callback) => events.set(name, callback),
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
    event: name => events.get(name)(),
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
