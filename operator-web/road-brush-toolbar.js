import { installPanelDrag } from './panel-drag.js';

/** Persistent mode controls while the operator paints or erases blockages. */
export function installRoadBrushToolbar(container, { onSelect }) {
  const panel = document.createElement('section');
  panel.className = 'road-brush-toolbar';
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', '도로 차단 도구');
  panel.hidden = true;
  panel.innerHTML = '<div class="road-brush-toolbar-handle" title="드래그하여 이동"><span aria-hidden="true">⠿</span><strong>도로 차단</strong><span>드래그하여 이동</span></div><div class="road-brush-toolbar-actions"><button type="button" data-road-tool="paint" aria-pressed="false">그리기</button><button type="button" data-road-tool="erase" aria-pressed="false">지우기</button><button type="button" data-road-tool="exit">종료</button></div>';
  container.append(panel);
  const buttons = [...panel.querySelectorAll('[data-road-tool]')];
  const drag = installPanelDrag({ panel, handle: panel.querySelector('.road-brush-toolbar-handle'), container, enabled: () => !panel.hidden });
  // Toolbar gestures must never start a brush stroke or pan the map.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'contextmenu']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const button = event.target.closest('[data-road-tool]');
    if (button && !button.disabled) onSelect(button.dataset.roadTool === 'exit' ? null : button.dataset.roadTool);
  });
  return {
    setTool(tool) {
      panel.hidden = !tool;
      for (const button of buttons) if (button.dataset.roadTool !== 'exit') button.setAttribute('aria-pressed', String(button.dataset.roadTool === tool));
      if (tool) drag.apply();
    },
    setBusy(busy) {
      for (const button of buttons) if (button.dataset.roadTool !== 'exit') button.disabled = busy;
    },
  };
}
