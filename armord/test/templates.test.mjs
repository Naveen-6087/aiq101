import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { listTemplates, readTemplate, renderTemplate } from '../dist/templates.js';
import { runPolicyTests } from '../dist/policy-test.js';
import { PolicyStore } from '../dist/store.js';

const all = listTemplates();

test('every expected template ships', () => {
  const names = all.map((t) => t.name);
  for (const n of ['armordev', 'armorops', 'armor-readonly', 'armor-balanced', 'armor-lockdown', 'armor-architect', 'armor-quality-guardian', 'armor-pay', 'armor-health', 'armor-edu', 'armor-ci']) assert.ok(names.includes(n), n);
});

for (const t of all) {
  test(`template ${t.name} compiles with no problems`, () => {
    const store = new PolicyStore();
    store.addSource(t.file, readFileSync(t.file, 'utf8'));
    assert.deepEqual(store.problems.filter((p) => p.severity === 'error'), []);
    assert.equal(store.localDocuments().length, 1);
  });
  test(`template ${t.name} passes its cases`, () => {
    assert.ok(t.casesFile, 'needs a cases file');
    const { results, problems } = runPolicyTests([t.file], t.casesFile);
    assert.deepEqual(problems.filter((p) => p.severity === 'error'), []);
    assert.ok(results.length >= 4);
    assert.deepEqual(results.filter((r) => !r.ok).map((r) => `${r.name}: want ${r.expect} got ${r.got} (${r.reason})`), []);
  });
}

test('readTemplate rejects unknown and unsafe names; renderTemplate leaves no placeholders', () => {
  assert.throws(() => readTemplate('nope'), /unknown template/);
  assert.throws(() => readTemplate('../x'), /invalid/);
  assert.equal(renderTemplate('armordev').includes('{{'), false);
});
