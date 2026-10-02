// AI 관제 도우미: questions and an on-demand fleet report, answered from the
// current fleet snapshot and KOSHA transport safety guides
// (POST /api/v1/assistant/chat). Answers are Markdown from an LLM, so they
// are parsed into blocks and rendered by building DOM nodes from text,
// never through innerHTML.

const MAX_MESSAGES = 30;

// **bold** and [S1] citation markers; everything else stays plain text.
export function inlineTokens(text) {
  const tokens = [];
  for (const part of String(text).split(/(\*\*[^*]+\*\*|\[S\d+\])/g)) {
    if (!part) continue;
    if (/^\*\*[^*]+\*\*$/.test(part)) tokens.push({ type: 'bold', text: part.slice(2, -2) });
    else if (/^\[S\d+\]$/.test(part)) tokens.push({ type: 'cite', text: part });
    else tokens.push({ type: 'text', text: part });
  }
  return tokens;
}

function tableRow(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

// Minimal Markdown blocks: headings, tables, bullet/numbered lists, paragraphs.
export function parseMarkdown(markdown) {
  const blocks = [];
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let list = null;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) { list = null; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      list = null;
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      continue;
    }
    if (trimmed.startsWith('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      list = null;
      const table = { type: 'table', head: tableRow(trimmed), rows: [] };
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        table.rows.push(tableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(table);
      continue;
    }
    const item = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (item) {
      const ordered = /^\d/.test(trimmed);
      if (!list || list.ordered !== ordered) {
        list = { type: 'list', ordered, items: [] };
        blocks.push(list);
      }
      list.items.push(item[1]);
      continue;
    }
    list = null;
    blocks.push({ type: 'paragraph', text: trimmed });
  }
  return blocks;
}

function appendInline(parent, text) {
  for (const token of inlineTokens(text)) {
    if (token.type === 'text') { parent.append(document.createTextNode(token.text)); continue; }
    const element = document.createElement(token.type === 'bold' ? 'strong' : 'span');
    if (token.type === 'cite') element.className = 'assistant-cite';
    element.textContent = token.text;
    parent.append(element);
  }
}

export function renderMarkdown(markdown) {
  const root = document.createElement('div');
  root.className = 'assistant-markdown';
  for (const block of parseMarkdown(markdown)) {
    if (block.type === 'heading') {
      const element = document.createElement(`h${Math.min(6, block.level + 2)}`);
      appendInline(element, block.text);
      root.append(element);
    } else if (block.type === 'table') {
      const table = document.createElement('table');
      const head = table.createTHead().insertRow();
      for (const cell of block.head) { const th = document.createElement('th'); appendInline(th, cell); head.append(th); }
      const body = table.createTBody();
      for (const cells of block.rows) {
        const row = body.insertRow();
        for (const cell of cells) appendInline(row.insertCell(), cell);
      }
      root.append(table);
    } else if (block.type === 'list') {
      const list = document.createElement(block.ordered ? 'ol' : 'ul');
      for (const item of block.items) { const li = document.createElement('li'); appendInline(li, item); list.append(li); }
      root.append(list);
    } else {
      const paragraph = document.createElement('p');
      appendInline(paragraph, block.text);
      root.append(paragraph);
    }
  }
  return root;
}

export function sourceLabel(source) {
  const page = source.page_start ? ` p.${source.page_start}` : '';
  return `[S${source.rank}] ${source.doc_id || ''} ${source.heading_path || ''}${page}`.replace(/\s+/g, ' ').trim();
}

export function initializeAssistantPanel({ api }) {
  const messages = document.querySelector('#assistant-messages');
  const form = document.querySelector('#assistant-form');
  const question = document.querySelector('#assistant-question');
  const reportButton = document.querySelector('#assistant-report');
  const submitButton = form.querySelector('button[type="submit"]');
  let busy = false;

  function append(element) {
    messages.append(element);
    while (messages.children.length > MAX_MESSAGES) messages.firstElementChild.remove();
    messages.scrollTop = messages.scrollHeight;
  }

  function bubble(role, text) {
    const element = document.createElement('div');
    element.className = `assistant-message assistant-message--${role}`;
    element.textContent = text;
    append(element);
    return element;
  }

  function renderAnswer(target, data) {
    target.replaceChildren(renderMarkdown(data.answer));
    if (data.sources?.length) {
      const sources = document.createElement('details');
      sources.className = 'assistant-sources';
      const summary = document.createElement('summary');
      summary.textContent = `근거 KOSHA 지침 ${data.sources.length}건`;
      const list = document.createElement('ul');
      for (const source of data.sources) {
        const li = document.createElement('li');
        li.textContent = sourceLabel(source);
        if (source.source_relpath) li.title = source.source_relpath;
        list.append(li);
      }
      sources.append(summary, list);
      target.append(sources);
    }
    const meta = document.createElement('p');
    meta.className = 'assistant-meta';
    const at = new Date(data.snapshotAt);
    const parts = [`현황 기준 ${Number.isNaN(at.getTime()) ? '-' : at.toLocaleTimeString('ko-KR', { hour12: false })}`];
    if (data.model) parts.push(data.model);
    if (data.retrievalError) parts.push('지침 검색 실패: 현황만으로 답변');
    meta.textContent = parts.join(' · ');
    target.append(meta);
  }

  async function ask(body, label) {
    if (busy) return;
    busy = true;
    submitButton.disabled = true;
    reportButton.disabled = true;
    bubble('user', label);
    const pending = bubble('assistant', '현황을 확인하고 답변을 작성하는 중…');
    pending.classList.add('assistant-message--pending');
    try {
      const data = await api('/api/v1/assistant/chat', { method: 'POST', body: JSON.stringify(body) }, true);
      pending.classList.remove('assistant-message--pending');
      renderAnswer(pending, data);
    } catch (error) {
      pending.classList.remove('assistant-message--pending');
      pending.classList.add('assistant-message--error');
      pending.textContent = `답변을 받지 못했습니다: ${error.message}`;
    } finally {
      busy = false;
      submitButton.disabled = false;
      reportButton.disabled = false;
      messages.scrollTop = messages.scrollHeight;
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = question.value.trim();
    if (!text) return;
    question.value = '';
    ask({ mode: 'qa', question: text }, text);
  });
  question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  reportButton.addEventListener('click', () => ask({ mode: 'report' }, '현황 보고서를 작성해 주세요.'));
  document.querySelector('#close-assistant').addEventListener('click', () => document.querySelector('[data-rail=map]').click());
}
