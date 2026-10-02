import { describe, expect, it } from 'vitest';
// @ts-expect-error The operator frontend remains plain browser JavaScript.
import { AUTO_TARGET, FLEET_TARGET, inlineTokens, parseMarkdown, resolveTarget, sourceLabel } from '../../operator-web/assistant-panel.js';

describe('assistant panel markdown', () => {
  it('parses a report: headings, tables and lists', () => {
    const blocks = parseMarkdown([
      '## 차량 현황 보고서',
      '기준 시각: 2026. 10. 02. 10:00 (KST)',
      '',
      '| 항목 | 값 |',
      '|---|---|',
      '| 활성 차량 | 4대 |',
      '| 미확인 경보 | 1건 |',
      '',
      '주의 차량:',
      '- TRUCK-2 (DRIVING) 마지막 위치 10분 전',
      '- TRUCK-3 위치 기록 없음',
      '1. 통로를 분리합니다 [S1].',
    ].join('\n'));
    expect(blocks).toEqual([
      { type: 'heading', level: 2, text: '차량 현황 보고서' },
      { type: 'paragraph', text: '기준 시각: 2026. 10. 02. 10:00 (KST)' },
      { type: 'table', head: ['항목', '값'], rows: [['활성 차량', '4대'], ['미확인 경보', '1건']] },
      { type: 'paragraph', text: '주의 차량:' },
      { type: 'list', ordered: false, items: ['TRUCK-2 (DRIVING) 마지막 위치 10분 전', 'TRUCK-3 위치 기록 없음'] },
      { type: 'list', ordered: true, items: ['통로를 분리합니다 [S1].'] },
    ]);
  });

  it('keeps markup in model output as plain text tokens', () => {
    expect(inlineTokens('**주의** <img src=x onerror=alert(1)> 근거 [S2]')).toEqual([
      { type: 'bold', text: '주의' },
      { type: 'text', text: ' <img src=x onerror=alert(1)> 근거 ' },
      { type: 'cite', text: '[S2]' },
    ]);
  });

  it('labels a KOSHA source', () => {
    expect(sourceLabel({ rank: 1, doc_id: 'G-10-2023', heading_path: '7 위험요소의 예방대책', page_start: 9 }))
      .toBe('[S1] G-10-2023 7 위험요소의 예방대책 p.9');
  });
});

describe('assistant target choice', () => {
  const auto = { scope: { view: 'monitoring', vehicleId: '2' }, label: '실차량 TRUCK-2' };
  const groups = [
    { label: '실차량', options: [{ value: 'real:5', text: 'BUS-5', label: '실차량 BUS-5', scope: { view: 'monitoring', vehicleId: '5' } }] },
    { label: '가상 시나리오', options: [{ value: 'virtual:7', text: '도심 통제', label: '시나리오 도심 통제', scope: { view: 'virtual', scenarioId: '7' } }] },
  ];

  it('follows the screen selection by default', () => {
    expect(resolveTarget(AUTO_TARGET, auto, groups)).toEqual({ ...auto, value: AUTO_TARGET });
  });

  it('asks about the whole fleet or any listed vehicle or scenario', () => {
    expect(resolveTarget(FLEET_TARGET, auto, groups)).toEqual({ scope: undefined, label: '전체 현황', value: FLEET_TARGET });
    expect(resolveTarget('real:5', auto, groups)).toEqual({ scope: { view: 'monitoring', vehicleId: '5' }, label: '실차량 BUS-5', value: 'real:5' });
    expect(resolveTarget('virtual:7', auto, groups).scope).toEqual({ view: 'virtual', scenarioId: '7' });
  });

  it('falls back to the screen selection when the chosen target is gone', () => {
    expect(resolveTarget('real:404', auto, groups)).toEqual({ ...auto, value: AUTO_TARGET });
  });
});
