import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, keys, PAL } from "./helpers.ts";
import { loadSource } from "../src/node/load.ts";
import { writeOutputs } from "../src/node/output.ts";
import { encodeGif } from "../src/node/gif.ts";
import { Img } from "../src/core/image.ts";
import { pack, TRANSPARENT } from "../src/core/color.ts";
import { decodeTestGif } from "./fixtures/gif-assertions.ts";

const BLINK = `anim("blink", { fps: 4, w: 3, h: 1 }, rect(0, 0, 3, 1, "r"),
  frame(), frame(px(1, 0, "w")), frame({ hold: 2 }, px(1, 0, "g")))`;
const load = (body: string) => loadSource(PAL + BLINK + "\n" + body, "t.px.js");
const frameKeys = (p: ReturnType<typeof load>, name: string) => p.frames(name).map((f) => keys({ ...p, image: () => f.img } as never, name));

test("anim: frame() items are patches over the shared items, with durations", () => {
  const p = load("");
  const fr = p.frames("blink");
  assert.deepEqual(fr.map((f) => f.ms), [250, 250, 500]);
  assert.deepEqual(frameKeys(p, "blink"), ["rrr", "rwr", "rgr"]);
  assert.deepEqual(p.timeline("blink"), { loop: 1000, step: 250, durations: [250, 250, 500], once: false });
});

test("anim: procedural frames see c.frame / c.frames / c.phase", () => {
  const p = loadSource(PAL + `anim("dot", { frames: 4, fps: 10, w: 4, h: 1 }, (c) => c.px(Math.round(c.phase * c.frames), 0, "w"))`, "t.px.js");
  assert.deepEqual(frameKeys(p, "dot"), ["w...", ".w..", "..w.", "...w"]);
  assert.equal(p.timeline("dot")!.step, 100);
});

test("anim: scenes that place anims animate; delay shifts, frame freezes", () => {
  const p = load(`scene("s", { w: 11, h: 1, bg: "k" }, stamp("blink", 0, 0), stamp("blink", 4, 0, { delay: 250 }), stamp("blink", 8, 0, { frame: 1 }))
scene("still", { w: 3, h: 1 }, stamp("blink", 0, 0, { frame: 2 }))`);
  assert.deepEqual(p.timeline("s"), { loop: 1000, step: 250 });
  assert.deepEqual(frameKeys(p, "s"), ["rrrkrwrkrwr", "rwrkrgrkrwr", "rgrkrgrkrwr", "rgrkrrrkrwr"]);
  assert.equal(p.timeline("still"), undefined, "a frozen frame doesn't animate the scene");
  assert.equal(keys(p, "still"), "rgr");
});

test("anim: loop false holds the last frame; anims combine to the lcm of their loops", () => {
  const p = loadSource(PAL + `anim("a", { fps: 10, loop: false, w: 1, h: 1 }, frame(px(0, 0, "r")), frame(px(0, 0, "w")))
anim("b", { fps: 10, w: 1, h: 1 }, frame(px(0, 0, "g")), frame(px(0, 0, "k")), frame(px(0, 0, "w")))
scene("s", { w: 2, h: 1 }, stamp("a", 0, 0), stamp("b", 1, 0))`, "t.px.js");
  assert.equal(keys({ ...p, image: () => p.image("a", 0, 5000) } as never, "a"), "w");
  assert.deepEqual(p.timeline("s"), { loop: 600, step: 100 });
});

test("anim: frame() is only for anims; options are validated", () => {
  assert.match(failure(PAL + 'sprite("s", { w: 2, h: 2 }, frame(px(0, 0, "r")))', "s").message, /only goes inside an anim/);
  assert.match(failure(PAL + 'anim("a", { w: 2, h: 2 }, frame({ msec: 3 }))').message, /unknown option 'msec'/);
  assert.match(failure(PAL + 'anim("a", { w: 2, h: 2, fsp: 3 })').message, /unknown option 'fsp'/);
});

test("anim: build writes a strip, Aseprite-style JSON, GIFs and animated sheets", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-anim-"));
  try {
    const p = load(`sheet("all", ["blink"])`);
    const r = writeOutputs(p, dir);
    assert.deepEqual(r.errors, []);
    const j = JSON.parse(readFileSync(join(dir, "anims", "blink.json"), "utf8"));
    assert.deepEqual(Object.values(j.frames).map((f: any) => f.duration), [250, 250, 500]);
    assert.deepEqual(j.meta.frameTags, [{ name: "blink", from: 0, to: 2, direction: "forward" }]);
    assert.ok(readFileSync(join(dir, "anims", "blink.gif")).subarray(0, 6).toString() === "GIF89a");
    assert.ok(readFileSync(join(dir, "_preview", "blink.gif")).length > 0);
    const s = JSON.parse(readFileSync(join(dir, "all.json"), "utf8"));
    assert.deepEqual(Object.keys(s.frames), ["blink_0", "blink_1", "blink_2"]);
    assert.equal(s.meta.frameTags[0].to, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gif: frames decode back to the same pixels and delays", () => {
  const a = new Img(5, 3), b = new Img(5, 3);
  a.fill(pack(255, 0, 0));
  b.fill(pack(0, 0, 255));
  a.data[0] = TRANSPARENT;
  b.data[7] = pack(255, 255, 255);
  const g = decodeTestGif(encodeGif([{ img: a, ms: 120 }, { img: a, ms: 80 }, { img: b, ms: 50 }]));
  assert.equal(g.frames.length, 2, "repeated frames merge");
  assert.deepEqual(g.frames.map((f) => f.delay), [20, 5]);
  assert.deepEqual(g.frames[0].pixels, a.data);
  assert.deepEqual(g.frames[1].pixels, b.data);
});

test("gif: many colors are reduced to one palette and still decode", () => {
  const img = new Img(40, 40);
  for (let i = 0; i < img.data.length; i++) img.data[i] = pack(i % 256, (i * 7) % 256, (i * 13) % 256);
  const g = decodeTestGif(encodeGif([{ img, ms: 100 }]));
  assert.equal(g.frames[0].pixels.length, 1600);
});

test("gif: rounding mixed frame delays preserves the loop boundary and minimum delay", () => {
  const a = new Img(1, 1).fill(pack(255, 0, 0)), b = new Img(1, 1).fill(pack(0, 0, 255));
  const mixed = [105, 100, 95, 100, 105, 100, 95, 100].map((ms, i) => ({ ms, img: i % 2 ? b : a }));
  const delays = decodeTestGif(encodeGif(mixed)).frames.map(frame => frame.delay);
  assert.deepEqual(delays, [11, 10, 9, 10, 11, 10, 9, 10]);
  assert.equal(delays.reduce((sum, delay) => sum + delay, 0), 80);
  const fast = decodeTestGif(encodeGif([{ img: a, ms: 5 }, { img: b, ms: 25 }, { img: a, ms: 25 }], { loop: false }));
  assert.deepEqual(fast.frames.map(frame => frame.delay), [2, 3, 2]);
  assert.equal(fast.loop, false);
});

test("gif: big noisy frames survive LZW table resets exactly", () => {
  const img = new Img(200, 150);
  let s = 7;
  for (let i = 0; i < img.data.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    img.data[i] = pack((s >>> 16) % 16 * 16, 0, 0);
  }
  const g = decodeTestGif(encodeGif([{ img, ms: 100 }]));
  assert.deepEqual(g.frames[0].pixels, img.data);
});

test("gif: a long transparent hold splits without wrapping delay or changing pixels", () => {
  const a = new Img(2, 1), b = new Img(2, 1);
  a.set(0, 0, pack(255, 0, 0));
  b.set(1, 0, pack(0, 0, 255));
  const run = Array.from({ length: 10 }, () => ({ img: a, ms: 60_000 }));
  const encoded = encodeGif([...run, { img: a, ms: 55_360 }, { img: b, ms: 100 }], { loop: false });
  const decoded = decodeTestGif(encoded);
  assert.deepEqual(decoded.frames.map(frame => frame.delay), [65_534, 2, 10]);
  assert.ok(decoded.frames.every(frame => frame.disposal === 2));
  assert.deepEqual(decoded.frames.map(frame => frame.pixels), [a.data, a.data, b.data]);
  assert.equal(decoded.loop, false);
  assert.throws(() => encodeGif([{ img: a, ms: Infinity }]), /duration must be finite/);
  assert.throws(() => encodeGif([{ img: a, ms: Number.MAX_SAFE_INTEGER }]), /more than 600 image blocks/);
});
