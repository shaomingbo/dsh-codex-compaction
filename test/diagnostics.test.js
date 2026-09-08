import test from 'node:test';
import assert from 'node:assert/strict';
import { operationDiagnostic } from '../src/runtime-adapter.js';

test('owner diagnostics retain only allowed numbers and fixed enums', () => {
  const diagnostics = { version: 1, phase: 'waiting-headers', requests: 1, elapsedMs: 120000, httpStatus: NaN,
    lastEvent: 'SECRET', requestBytes: 'SECRET', input: 'SECRET', headers: { authorization: 'SECRET' }, accountId: 'SECRET' };
  const expected = { version: 1, phase: 'waiting-headers', elapsedMs: 120000, requests: 1 };
  assert.deepEqual(operationDiagnostic(undefined, { diagnostics }), expected);
  assert.deepEqual(operationDiagnostic({ operation: { diagnostics: () => diagnostics } }), expected);
  assert.equal(operationDiagnostic(undefined, { diagnostics: { ...diagnostics, phase: 'SECRET' } }), undefined);
});

test('extended diagnostic counts expose only fixed event names and safe integers', () => {
  const diagnostics = { version: 1, phase: 'reading-sse', budgetMs: 300000, lastEvent: 'reasoning-done',
    eventCounts: { 'reasoning-added': 1, 'reasoning-done': 1, 'compaction-added': 1, SECRET: 12, 'output-text-delta': 'SECRET', completed: Infinity } };
  assert.deepEqual(operationDiagnostic(undefined, { diagnostics }), { version: 1, phase: 'reading-sse', budgetMs: 300000,
    lastEvent: 'reasoning-done', eventCounts: { 'reasoning-added': 1, 'reasoning-done': 1, 'compaction-added': 1 } });
});

test('optional owner deadline diagnostics retain only safe budgets and setup/total kinds', () => {
  for (const timeoutKind of ['setup', 'total']) {
    const expected = { version: 1, phase: 'reading-sse', setupBudgetMs: 120000, totalBudgetMs: 1800000,
      timeoutBudgetMs: timeoutKind === 'setup' ? 120000 : 1800000, timeoutKind };
    const diagnostics = { ...expected, body: 'SECRET', credentials: 'SECRET', timeoutMessage: 'SECRET' };
    assert.deepEqual(operationDiagnostic(undefined, { diagnostics }), expected);
    assert.deepEqual(operationDiagnostic({ operation: { diagnostics: () => diagnostics } }), expected);
  }
  const base = { version: 1, phase: 'bound' };
  assert.deepEqual(operationDiagnostic(undefined, { diagnostics: base }), base, 'older owners need no deadline extension');
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '120000', null, {}, 'SECRET']) {
    assert.deepEqual(operationDiagnostic(undefined, { diagnostics: { ...base,
      setupBudgetMs: value, totalBudgetMs: value, timeoutBudgetMs: value, timeoutKind: value } }), base);
  }
  for (const timeoutKind of ['idle', 'SETUP', 'setup\n', 'total SECRET']) {
    assert.deepEqual(operationDiagnostic(undefined, { diagnostics: { ...base, timeoutKind } }), base);
  }
  const zero = { ...base, setupBudgetMs: 0, totalBudgetMs: 0, timeoutBudgetMs: 0 };
  assert.deepEqual(operationDiagnostic(undefined, { diagnostics: zero }), zero);
});

test('diagnostic extension is optional and cannot replace an owner failure', () => {
  assert.equal(operationDiagnostic({ operation: {} }), undefined);
  assert.equal(operationDiagnostic({ operation: { diagnostics: () => { throw new Error('SECRET'); } } }), undefined);
});
