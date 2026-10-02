import { describe, expect, it } from 'vitest';
// @ts-expect-error The operator frontend remains plain browser JavaScript.
import { inlineTokens, parseMarkdown, sourceLabel } from '../../operator-web/assistant-panel.js';

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
