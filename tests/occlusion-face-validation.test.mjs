import assert from 'node:assert/strict';
import test from 'node:test';
import { validatedOcclusionPair } from '../src/lib/occlusion-face-validation.ts';
const front = { version: 1, fileId: 'file', imageId: 'image', targetMaskId: 'mask', revealed: false,
  masks: [{ id: 'mask', shape: 'rectangle', x: 0, y: 0, width: .5, height: .5 }] };
const back = { ...front, revealed: true };
test('review admits only a matching concealed/revealed pair with a valid target', () => {
  assert.ok(validatedOcclusionPair(front, back));
  for (const invalid of [null, [], { ...front, version: 2 }, { ...front, revealed: true },
    { ...front, targetMaskId: 'absent' }, { ...front, masks: [] },
    { ...front, masks: [{ ...front.masks[0], width: 0 }] },
    { ...front, masks: [front.masks[0], front.masks[0]] }]) {
    assert.equal(validatedOcclusionPair(invalid, back), null);
  }
  for (const invalid of [{ ...back, revealed: false }, { ...back, fileId: 'other' },
    { ...back, imageId: 'other' }, { ...back, masks: [{ ...front.masks[0], x: .1 }] }]) {
    assert.equal(validatedOcclusionPair(front, invalid), null);
  }
});
