/** Hides the normal-monitoring sections while the virtual workspace is open,
 * and puts every one of them back exactly as it was on the way out.
 *
 * Their visibility is decided by several unrelated parts of the dashboard -
 * sign-in state, demo mode, whether a vehicle is selected - so the workspace
 * switch has no way to recompute it correctly. Recording what was hidden is the
 * only way to leave the sidebar the way it was found.
 */
export function createSectionVisibility(elements) {
  const sections = [...elements];
  let saved = null;

  return {
    hide() {
      // Hiding twice without an intervening restore must not overwrite the
      // saved state with the hidden one this call is about to write.
      saved ??= sections.map((element) => element.hidden);
      for (const element of sections) element.hidden = true;
    },
    restore() {
      if (!saved) return;
      sections.forEach((element, index) => { element.hidden = saved[index]; });
      saved = null;
    },
  };
}
