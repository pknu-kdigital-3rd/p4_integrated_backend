const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ structuredClone });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../road-brush-history.js'), 'utf8').replace('export function', 'function'), context);
const entry = { before: [{ restrictionId: '1', isActive: false, geometry: { type: 'Polygon', coordinates: [] } }], after: [{ restrictionId: '1', isActive: true, geometry: { type: 'Polygon', coordinates: [] } }] };

test('undo and redo restore exact snapshots using the latest revision', async () => {
  const flags = [];
  const history = context.createBrushHistory(state => flags.push(state));
  history.begin('7', 0); history.record(entry, 1);
  const calls = [];
  const restore = async (states, scope) => { calls.push({ states, ...scope }); return { restrictionRevision: scope.expectedRestrictionRevision + 1 }; };
  await history.undo(restore);
  await history.redo(restore);
  assert.deepEqual(calls.map(call => call.states), [entry.before, entry.after]);
  assert.deepEqual(calls.map(call => call.expectedRestrictionRevision), [1, 2]);
  assert.equal(flags.at(-1).canUndo, true);
  assert.equal(flags.at(-1).canRedo, false);
});

test('a failed restore keeps history retryable and a new stroke clears redo', async () => {
  const history = context.createBrushHistory();
  history.begin('7', 0); history.record(entry, 1);
  await assert.rejects(history.undo(async () => { throw new Error('occupied'); }));
  assert.equal(await history.undo(async () => ({ restrictionRevision: 2 })), true);
  history.begin('7', 2); history.record(entry, 3);
  assert.equal(await history.redo(async () => { throw new Error('must not run'); }), false);
});

test('external road edits and scenario changes invalidate history', async () => {
  const history = context.createBrushHistory();
  history.begin('7', 0); history.record(entry, 1);
  history.sync('7', 2);
  assert.equal(await history.undo(() => { throw new Error('must not run'); }), false);
  history.begin('7', 2); history.record(entry, 3);
  history.sync('8', 3);
  assert.equal(await history.undo(() => { throw new Error('must not run'); }), false);
});

test('an older polling response cannot clear successful stroke history', async () => {
  const history = context.createBrushHistory();
  history.begin('7', 0); history.record(entry, 1);
  history.sync('7', 0);
  assert.equal(await history.undo(async (states, scope) => {
    assert.equal(scope.expectedRestrictionRevision, 1);
    return { restrictionRevision: 2 };
  }), true);
});

test('a late undo response cannot populate another scenario history', async () => {
  const history = context.createBrushHistory();
  history.begin('7', 0); history.record(entry, 1);
  let resolve;
  const undo = history.undo(() => new Promise(done => { resolve = done; }));
  history.sync('8', 0);
  resolve({ restrictionRevision: 2 });
  assert.equal(await undo, false);
  assert.equal(await history.redo(() => { throw new Error('must not run'); }), false);
});
