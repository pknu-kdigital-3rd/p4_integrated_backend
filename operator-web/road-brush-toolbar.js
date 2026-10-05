import { installPanelDrag } from './panel-drag.js';

/** Persistent mode controls while the operator paints or erases blockages. */
export function installRoadBrushToolbar(container, { onSelect, onUndo, onRedo }) {
  const panel = document.createElement('section');
  panel.className = 'road-brush-toolbar';
  panel.setAttribute('role', 'toolbar');
  panel.setAttribute('aria-label', '도로 차단 도구');
  panel.hidden = true;
  panel.innerHTML = '<div class="road-brush-toolbar-handle" title="드래그하여 이동"><span aria-hidden="true">⠿</span><strong>도로 차단</strong><span>드래그하여 이동</span></div><div class="road-brush-toolbar-actions"><button type="button" data-road-tool="paint" aria-pressed="false">그리기</button><button type="button" data-road-tool="erase" aria-pressed="false">지우기</button><button type="button" data-road-tool="pan" aria-pressed="false">이동</button><button type="button" data-road-tool="exit">종료</button></div><div class="road-brush-toolbar-history"><button type="button" data-road-history="undo" disabled>↶ 실행 취소</button><button type="button" data-road-history="redo" disabled>↷ 다시 실행</button></div>';
  container.append(panel);
  const buttons = [...panel.querySelectorAll('[data-road-tool]')];
  const historyButtons = [...panel.querySelectorAll('[data-road-history]')];
  let busy = false, canUndo = false, canRedo = false;
  const updateHistory = () => { for (const button of historyButtons) button.disabled = busy || !(button.dataset.roadHistory === 'undo' ? canUndo : canRedo); };
  const drag = installPanelDrag({ panel, handle: panel.querySelector('.road-brush-toolbar-handle'), container, enabled: () => !panel.hidden });
  // Toolbar gestures must never start a brush stroke or pan the map.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'dblclick', 'contextmenu']) {
    panel.addEventListener(type, event => event.stopPropagation());
  }
  panel.addEventListener('click', event => {
    event.stopPropagation();
    const button = event.target.closest('[data-road-tool]');
    if (button && !button.disabled) onSelect(button.dataset.roadTool === 'exit' ? null : button.dataset.roadTool);
    const historyButton = event.target.closest('[data-road-history]');
    if (historyButton && !historyButton.disabled) {
      if (historyButton.dataset.roadHistory === 'undo') onUndo?.(); else onRedo?.();
    }
  });
  return {
    setTool(tool) {
      panel.hidden = !tool;
      for (const button of buttons) if (button.dataset.roadTool !== 'exit') button.setAttribute('aria-pressed', String(button.dataset.roadTool === tool));
      if (tool) drag.apply();
    },
    setBusy(nextBusy) {
      busy = nextBusy;
      for (const button of buttons) if (button.dataset.roadTool !== 'exit') button.disabled = busy;
      updateHistory();
    },
    setHistory(state) { ({ canUndo, canRedo } = state); updateHistory(); },
  };
}
