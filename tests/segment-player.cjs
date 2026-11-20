const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');

class FakeAudio extends EventTarget {
  constructor() { super(); this.paused = true; this.readyState = 1; this._time = 0; this.seeks = []; this.starts = []; }
  get currentTime() { return this._time; }
  set currentTime(t) { this._time = t; this.seeks.push(t); queueMicrotask(() => this.dispatchEvent(new Event('seeked'))); }
  pause() { this.paused = true; }
  play() { this.paused = false; this.starts.push(this.currentTime); return Promise.resolve(); }
}
global.Audio = FakeAudio;
global.cancelAnimationFrame = () => {};
const source = readFileSync(require.resolve('../js/lib/segment-player.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('切句时先暂停旧片段，定位完成后才播放新片段', async () => {
  const { SegmentPlayer } = await modulePromise;
  const player = new SegmentPlayer();
  player.el.paused = false;
  let ready;
  player._waitReady = () => new Promise(resolve => { ready = resolve; });
  const playback = player.playRange(12, 14);
  assert.equal(player.el.paused, true);
  assert.deepEqual(player.el.starts, []);
  ready();
  await playback;
  assert.deepEqual(player.el.starts, [12]);
  assert.equal(player.range.t1, 14);
});

test('取消加载中的播放后，迟到的请求不再改动音频位置', async () => {
  const { SegmentPlayer } = await modulePromise;
  for (const kind of ['playRange', 'playFrom']) {
    const player = new SegmentPlayer();
    let ready;
    player._waitReady = () => new Promise(resolve => { ready = resolve; });
    const playback = player[kind](12, 14);
    player.stop();
    ready();
    await playback;
    assert.deepEqual(player.el.seeks, []);
    assert.deepEqual(player.el.starts, []);
  }
});

test('快速切题时，旧请求晚到也只能播放最后选中的句子', async () => {
  const { SegmentPlayer } = await modulePromise;
  const player = new SegmentPlayer();
  const ready = [];
  player._waitReady = () => new Promise(resolve => ready.push(resolve));
  const old = player.playRange(1, 2);
  const latest = player.playRange(20, 23);
  ready[1]();
  await latest;
  ready[0]();
  await old;
  assert.deepEqual(player.el.seeks, [20]);
  assert.deepEqual(player.el.starts, [20]);
  assert.equal(player.range.t0, 20);
});
