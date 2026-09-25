import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers.mjs';
import { validateReview, saveReview, latestReview, dismiss, loadDismissed } from '../skills/nitbot/scripts/lib/memory.mjs';

const review = {
  verdict: 'ship-with-fixes',
  method: 'dual',
  gates: ['G1:ok'],
  findings: [{ id: 'N1', severity: 'P1', title: 'Null total', file: 'a.js', line: 3, scenario: 'empty cart returns NaN' }],
};

test('a finding without a failure scenario is rejected with a usable message', () => {
  const errors = validateReview({ ...review, findings: [{ id: 'N1', severity: 'P9', title: 't', file: 'a.js' }] });
  assert.ok(errors.some((e) => /severity/.test(e)));
  assert.ok(errors.some((e) => /scenario is required/.test(e)));
  assert.deepEqual(validateReview(review), []);
});

test('saved reviews come back as the latest, with fingerprints and open status', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  assert.equal(saveReview(r.dir, 'feat-x', review).ok, true);
  const latest = latestReview(r.dir, 'feat-x');
  assert.equal(latest.findings[0].status, 'open');
  assert.match(latest.findings[0].fingerprint, /^[0-9a-f]{10}$/);
  assert.equal(latestReview(r.dir, 'other'), null);
});

test('dismissals need a reason', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  assert.throws(() => dismiss(r.dir, { title: 'x' }), /reason/);
  dismiss(r.dir, { title: 'Null total', file: 'a.js', reason: 'caller validates (cart.js:12)', by: 'user' });
  assert.equal(loadDismissed(r.dir)[0].id, 'D1');
});
