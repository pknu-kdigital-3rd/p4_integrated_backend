/** Keeps a panel of the given size fully inside bounds; returns its top-left. */
export function clampPanelPosition({left, top}, panel, bounds) {
  const maxLeft = Math.max(0, bounds.width - panel.width);
  const maxTop = Math.max(0, bounds.height - panel.height);
  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

/**
 * Lets `handle` drag `panel` anywhere inside `container` (the panel's positioned
 * parent). Buttons inside the handle keep working; the last position is kept in
 * `storage` under `storageKey` and re-clamped whenever the container resizes.
 * While `enabled()` is false (the panel is docked elsewhere) it neither drags nor
 * positions the panel.
 */
export function installPanelDrag({panel, handle, container, storage = null, storageKey = 'panelPosition', enabled = () => true}) {
  let drag = null;
  let position = null;
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) ?? 'null');
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.top)) position = saved;
  } catch { /* storage unavailable or corrupt: keep the stylesheet position */ }

  function apply() {
    if (!enabled() || !position || panel.hidden || document.fullscreenElement === panel) return;
    const bounds = container.getBoundingClientRect();
    const size = panel.getBoundingClientRect();
    position = clampPanelPosition(position, size, bounds);
    Object.assign(panel.style, {left: `${position.left}px`, top: `${position.top}px`, right: 'auto', bottom: 'auto'});
  }

  function save() {
    try { storage?.setItem(storageKey, JSON.stringify(position)); } catch { /* best effort */ }
  }

  handle.style.touchAction = 'none';
  handle.style.cursor = 'move';
  handle.addEventListener('pointerdown', event => {
    if (!enabled() || event.button !== 0 || event.target.closest('button') || document.fullscreenElement === panel) return;
    const bounds = container.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    drag = {pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, bounds};
    handle.setPointerCapture(event.pointerId);
    // The iframe would otherwise swallow pointer events when the cursor crosses it.
    panel.classList.add('dragging');
    event.preventDefault();
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    position = {left: event.clientX - drag.bounds.left - drag.offsetX, top: event.clientY - drag.bounds.top - drag.offsetY};
    apply();
  });
  const end = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    panel.classList.remove('dragging');
    save();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);

  new ResizeObserver(apply).observe(container);
  return {apply};
}
