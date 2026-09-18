import { describe, expect, it, vi } from "vitest";

import { installForegroundResume } from "../operator-web/foreground-resume.js";

function eventTarget() {
    const listeners = new Map<string, Set<() => void>>();
    return {
        addEventListener(type: string, listener: () => void) {
            const group = listeners.get(type) ?? new Set();
            group.add(listener);
            listeners.set(type, group);
        },
        removeEventListener(type: string, listener: () => void) { listeners.get(type)?.delete(listener); },
        dispatch(type: string) { for (const listener of listeners.get(type) ?? []) listener(); },
    };
}

describe("foreground resume signals", () => {
    it("coalesces window focus and page visibility when returning from a tab or desktop", () => {
        const windowRef = eventTarget();
        const documentRef = Object.assign(eventTarget(), { hidden: false });
        const onResume = vi.fn();
        installForegroundResume(windowRef, documentRef, onResume);

        windowRef.dispatch("blur");
        documentRef.hidden = true;
        documentRef.dispatch("visibilitychange");
        documentRef.hidden = false;
        documentRef.dispatch("visibilitychange");
        windowRef.dispatch("focus");

        expect(onResume).toHaveBeenCalledTimes(1);
    });

    it("does not request resume on initial focus or while still hidden", () => {
        const windowRef = eventTarget();
        const documentRef = Object.assign(eventTarget(), { hidden: false });
        const onResume = vi.fn();
        installForegroundResume(windowRef, documentRef, onResume);
        windowRef.dispatch("focus");
        expect(onResume).not.toHaveBeenCalled();

        windowRef.dispatch("blur");
        documentRef.hidden = true;
        documentRef.dispatch("visibilitychange");
        windowRef.dispatch("focus");
        expect(onResume).not.toHaveBeenCalled();
    });
});
