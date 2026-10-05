import { installPanelDrag } from './panel-drag.js';

/** Pin buttons own the pointer from press through drop, including on touch. */
export function installRoutePointToolbar(container, { onStart, onMove, onDrop, onCancel, onExit }) {
  const panel = document.createElement('section');
  panel.className = 'route-point-toolbar road-brush-toolbar';
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', '경로 위치 선택');
  panel.hidden = true;
  panel.innerHTML = '<div class="road-brush-toolbar-handle"><span aria-hidden="true">⠿</span><strong>경로 위치 선택</strong><button type="button" data-point-exit>종료</button></div><div class="route-point-toolbar-pins">'
    + ['origin', 'destination', 'waypoint'].map((kind, index) => `<button type="button" data-point-kind="${kind}" aria-label="${['출발', '도착', '경유지'][index]}" aria-pressed="false"><svg viewBox="0 0 60 80" aria-hidden="true"><path d="M30 2C14.5 2 2 14.5 2 30c0 14 13 31 28 48 15-17 28-34 28-48C58 14.5 45.5 2 30 2Z"/><text x="30" y="35" text-anchor="middle">${['출발', '도착', '경유지'][index]}</text></svg></button>`).join('')
    + '</div><small data-point-preview hidden></small>';
  container.append(panel);
  const buttons = [...panel.querySelectorAll('[data-point-kind]')];
  const preview = panel.querySelector('[data-point-preview]');
  const panelDrag = installPanelDrag({ panel, handle: panel.querySelector('.road-brush-toolbar-handle'), container, enabled: () => !panel.hidden });
  let gesture = null;
  let busy = false;
  let suppressClick = false;
  const select = kind => {
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.pointKind === kind));
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'contextmenu']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  for (const button of buttons) {
    button.addEventListener('pointerdown', event => {
      if (busy || event.button !== 0 || gesture) return;
      event.preventDefault();
      event.stopPropagation();
      suppressClick = false;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, button };
      button.setPointerCapture(event.pointerId);
      select(button.dataset.pointKind);
      onStart(button.dataset.pointKind, event);
    });
    button.addEventListener('pointermove', event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      event.preventDefault();
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) >= 6) gesture.moved = true;
      if (gesture.moved) onMove(event);
    });
    const finish = (event, cancelled) => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const previous = gesture;
      gesture = null;
      suppressClick = true;
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      if (cancelled) { onCancel(); select(null); return; }
      if (!previous.moved) return; // A tap leaves the selected pin in locate mode.
      const bounds = container.getBoundingClientRect();
      const menu = panel.getBoundingClientRect();
      const within = rect => event.clientX >= rect.left && event.clientX <= rect.left + rect.width
        && event.clientY >= rect.top && event.clientY <= rect.top + rect.height;
      if (within(bounds) && !within(menu)) onDrop(event);
      else { onCancel(); select(null); }
    };
    button.addEventListener('pointerup', event => finish(event, false));
    button.addEventListener('pointercancel', event => finish(event, true));
    button.addEventListener('lostpointercapture', event => finish(event, true));
  }
  panel.addEventListener('click', event => {
    event.stopPropagation();
    if (event.target.closest('[data-point-exit]')) { onExit(); return; }
    const button = event.target.closest('[data-point-kind]');
    if (!button || busy) return;
    if (suppressClick && event.detail !== 0) { suppressClick = false; return; }
    select(button.dataset.pointKind);
    onStart(button.dataset.pointKind, event);
  });
  return {
    open(kind = null) { panel.hidden = false; select(kind); panelDrag.apply(); },
    close() {
      panel.hidden = true;
      const previous = gesture;
      gesture = null;
      if (previous?.button.hasPointerCapture(previous.id)) previous.button.releasePointerCapture(previous.id);
      select(null);
    },
    isOpen: () => !panel.hidden,
    setSelection: select,
    setPreview(message) { preview.textContent = message; },
    setBusy(value) { busy = value; for (const button of buttons) button.disabled = busy; },
  };
}
