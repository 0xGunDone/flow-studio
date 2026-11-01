'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelInfo, modelSettings, frameReferences, requestFor } = require('./renderer.js');

const aspects = { landscape: '16:9', portrait: '9:16', square: '1:1', 'four-three': '4:3', 'three-four': '3:4' };
const orientations = ['landscape', 'portrait'];
const veoFamilies = ['lite', 'fast', 'quality'];
const currentCatalog = [];
function add(id, family, methods, duration, orientation, resolution = 'standard') {
  currentCatalog.push({ id, family, methods, duration, aspect: aspects[orientation], resolution });
}
for (const [prefix, family] of [['gemini-3.1-flash-image', 'Nano Banana 2.1'], ['gemini-3.1-flash-lite-image', 'Nano Banana 2 Lite']]) {
  for (const orientation of Object.keys(aspects)) {
    for (const [suffix, resolution] of [['', 'standard'], ['-2k', '2K'], ['-4k', '4K']]) add(`${prefix}-${orientation}${suffix}`, family, ['image'], '', orientation, resolution);
  }
}
for (const family of veoFamilies) {
  const name = `Veo 3.1 ${family[0].toUpperCase()}${family.slice(1)}`;
  for (const seconds of ['4', '6', '8']) {
    for (const orientation of orientations) {
      add(`veo-3.1-${family}-${seconds}s-${orientation}`, name, ['text'], seconds, orientation);
      add(`veo-3.1-${family}-i2v-${seconds}s-${orientation}`, name, ['frames'], seconds, orientation);
    }
  }
  for (const orientation of orientations) add(`veo-3.1-${family}-extend-8s-${orientation}`, name, ['extend'], '8', orientation);
  add(`veo-3.1-${family}`, name, ['text'], '8', 'landscape');
}
for (const family of ['lite', 'fast']) {
  for (const orientation of orientations) add(`veo-3.1-${family}-r2v-8s-${orientation}`, `Veo 3.1 ${family[0].toUpperCase()}${family.slice(1)}`, ['ingredients'], '8', orientation);
}
for (const seconds of ['4', '6', '8', '10']) {
  for (const orientation of orientations) add(`omni-1.1-flash-${seconds}s-${orientation}`, 'Omni 1.1 Flash', ['text', 'ingredients'], seconds, orientation);
}
for (const orientation of orientations) add(`omni-1.1-flash-edit-${orientation}`, 'Omni 1.1 Flash', ['edit'], 'source', orientation);
add('omni-1.1-flash', 'Omni 1.1 Flash', ['text', 'ingredients'], '8', 'landscape');

test('separate settings cover every current catalog ID without treating variants as families', () => {
  assert.equal(currentCatalog.length, 90);
  assert.equal(new Set(currentCatalog.map(entry => entry.id)).size, 90);
  for (const { id, ...expected } of currentCatalog) {
    const { family, methods, duration, aspect, resolution } = modelSettings({ id });
    assert.deepEqual({ family, methods, duration, aspect, resolution }, expected, id);
  }
  assert.equal(new Set(currentCatalog.map(entry => entry.family)).size, 6);
});

test('short aliases normalize to the same eight-second landscape selection', () => {
  for (const alias of ['veo-3.1-lite', 'veo-3.1-fast', 'veo-3.1-quality', 'omni-1.1-flash']) {
    const selection = id => {
      const { family, methods, duration, aspect, resolution } = modelSettings({ id });
      return { family, methods, duration, aspect, resolution };
    };
    assert.deepEqual(selection(alias), selection(`${alias}-8s-landscape`), alias);
  }
  const selections = currentCatalog.map(({ id }) => {
    const { family, methods, duration, aspect, resolution } = modelSettings({ id });
    return JSON.stringify([family, methods, duration, aspect, resolution]);
  });
  assert.equal(new Set(selections).size, 86);
});

test('method choices retain only supported family, duration and resolution combinations', () => {
  const selections = currentCatalog.map(({ id }) => modelSettings({ id }));
  assert.deepEqual([...new Set(selections.filter(entry => entry.methods.includes('frames')).map(entry => entry.family))].sort(), ['Veo 3.1 Fast', 'Veo 3.1 Lite', 'Veo 3.1 Quality']);
  const ingredients = selections.filter(entry => entry.methods.includes('ingredients'));
  assert.deepEqual([...new Set(ingredients.map(entry => entry.family))].sort(), ['Omni 1.1 Flash', 'Veo 3.1 Fast', 'Veo 3.1 Lite']);
  assert.deepEqual([...new Set(ingredients.filter(entry => !entry.info.omni).map(entry => entry.duration))], ['8']);
  assert.deepEqual([...new Set(selections.filter(entry => entry.methods.includes('extend')).map(entry => entry.duration))], ['8']);
  assert.deepEqual([...new Set(selections.filter(entry => entry.info.kind === 'video').map(entry => entry.resolution))], ['standard']);
  for (const entry of selections) {
    if (entry.info.i2v) assert.deepEqual([entry.info.minImages, entry.info.maxImages], [1, 2], entry.info.id);
    if (entry.info.r2v) assert.deepEqual([entry.info.minImages, entry.info.maxImages], [1, 3], entry.info.id);
    if (entry.info.kind === 'video' && !entry.info.omni && ['4', '6'].includes(entry.duration)) assert.equal(entry.info.requiredTier, 'Ultra', entry.info.id);
  }
});

test('editing gets its duration from the source video and accepts no frame method', () => {
  for (const orientation of orientations) {
    const { info, methods, duration } = modelSettings({ id: `omni-1.1-flash-edit-${orientation}`, description: 'Omni 1.1 Flash · Video Edit' });
    assert.deepEqual(methods, ['edit']);
    assert.equal(duration, 'source');
    assert.equal(info.seconds, undefined);
    assert.deepEqual([info.minVideos, info.maxVideos, info.maxImages], [1, 1, 5]);
  }
});

test('frame slots preserve roles, require a start frame and enforce an unsupported end frame', () => {
  const start = { name: 'start.png', dataUrl: 'data:image/png;base64,c3RhcnQ=' };
  const end = { name: 'end.png', dataUrl: 'data:image/png;base64,ZW5k' };
  const model = { id: 'veo-3.1-lite-i2v-8s-landscape' };
  const info = modelInfo(model);
  assert.deepEqual(frameReferences([null, null], info), []);
  assert.throws(() => frameReferences([null, null], info, true), /Добавьте начальный кадр/);
  assert.throws(() => frameReferences([null, end], info), /Добавьте начальный кадр/);
  assert.deepEqual(frameReferences([start, null], info, true), [start]);
  assert.deepEqual(frameReferences([start, end], info, true), [start, end]);
  assert.deepEqual(requestFor(model, 'Scene', frameReferences([start, end], info, true), ''), { model: model.id, prompt: 'Scene', images: [start.dataUrl, end.dataUrl] });
  assert.throws(() => frameReferences([start, end], modelInfo({ id: 'veo_3_1_i2v_lite_landscape' }), true), /не поддерживает конечный кадр/);
});
