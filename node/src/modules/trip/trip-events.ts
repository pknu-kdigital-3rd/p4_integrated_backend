const listeners = new Map<string, Set<() => void>>();

export function subscribeTripChanges(vehicleId: bigint, listener: () => void): () => void {
    const key = vehicleId.toString();
    const group = listeners.get(key) ?? new Set<() => void>();
    group.add(listener); listeners.set(key, group);
    return () => { group.delete(listener); if (!group.size) listeners.delete(key); };
}

/** Notify after the state is committed; no database work while a vehicle is idle. */
export function notifyTripChange(vehicleId: bigint): void {
    for (const listener of listeners.get(vehicleId.toString()) ?? []) listener();
}
