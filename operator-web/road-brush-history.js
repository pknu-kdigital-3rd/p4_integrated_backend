/** Local stroke history; revision checks prevent overwriting other road edits. */
export function createBrushHistory(onChange = () => {}) {
  let scenario = '', revision = 0, entries = [], index = 0, busy = false, generation = 0;
  const notify = () => onChange({ canUndo: index > 0 && !busy, canRedo: index < entries.length && !busy });
  function sync(nextScenario, nextRevision) {
    if (scenario === nextScenario && nextRevision < revision) return;
    if (scenario !== nextScenario || (!busy && revision !== nextRevision)) {
      entries = []; index = 0; generation++;
    }
    if (!busy || scenario !== nextScenario) revision = nextRevision;
    scenario = nextScenario;
    notify();
  }
  async function move(direction, restore) {
    if (busy || (direction < 0 ? index === 0 : index === entries.length)) return false;
    const entry = entries[direction < 0 ? index - 1 : index], currentGeneration = generation;
    busy = true; notify();
    try {
      const result = await restore(direction < 0 ? entry.before : entry.after, { scenarioId: scenario, expectedRestrictionRevision: revision });
      if (generation !== currentGeneration) return false;
      revision = result.restrictionRevision; index += direction;
      return true;
    } finally { busy = false; notify(); }
  }
  return {
    sync,
    begin(nextScenario, nextRevision) { sync(nextScenario, nextRevision); busy = true; notify(); },
    record(history, nextRevision) {
      if (history?.before?.length && history?.after?.length) {
        entries = entries.slice(0, index); entries.push(structuredClone(history));
        if (entries.length > 50) entries.shift();
        index = entries.length;
      }
      revision = nextRevision; busy = false; notify();
    },
    finish() { busy = false; notify(); },
    clear() { entries = []; index = 0; generation++; notify(); },
    undo: restore => move(-1, restore),
    redo: restore => move(1, restore),
  };
}
