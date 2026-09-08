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

test('diagnostic extension is optional and cannot replace an owner failure', () => {
  assert.equal(operationDiagnostic({ operation: {} }), undefined);
  assert.equal(operationDiagnostic({ operation: { diagnostics: () => { throw new Error('SECRET'); } } }), undefined);
});
