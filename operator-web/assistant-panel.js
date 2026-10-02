// AI 관제 도우미: questions and an on-demand fleet report, answered from the
// current fleet snapshot and KOSHA transport safety guides, streamed over
// the assistant WebSocket (/api/v1/assistant/ws). Answers are Markdown from
// an LLM, so they are parsed into blocks and rendered by building DOM nodes
// from text, never through innerHTML.

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

// Close code the panel uses for an explicit abort (중지).
export const ABORT_CLOSE_CODE = 4000;

function assistantSocketUrl() {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/assistant/ws`;
}

function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// One WebSocket per page. It is opened on the first question and kept open
// while the panel is hidden, so answers keep arriving in the background.
// abort() closes it, which makes the server cancel generation.
function createAssistantConnection({ getToken, onEvent, onLost }) {
  let socket = null;
  let ready = null;
  let abortedSocket = null;

  function open() {
    const token = getToken();
    if (!token) return Promise.reject(new Error('로그인 후 사용할 수 있습니다.'));
    const ws = new WebSocket(assistantSocketUrl());
    socket = ws;
    ready = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
      ws.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'ready') { resolve(ws); return; }
        onEvent(message);
      });
      ws.addEventListener('close', (event) => {
        if (socket === ws) { socket = null; ready = null; }
        const reason = event.code === 4401 || event.code === 4403 ? '인증이 만료되었거나 권한이 없습니다.' : '도우미 연결이 끊어졌습니다.';
        reject(new Error(reason));
        if (ws !== abortedSocket) onLost(reason);
      });
    });
    ready.catch(() => {});
    return ready;
  }

  return {
    async send(message) {
      const ws = await (socket && ready ? ready : open());
      ws.send(JSON.stringify(message));
    },
    abort() {
      if (!socket) return;
      abortedSocket = socket;
      socket.close(ABORT_CLOSE_CODE, 'aborted by operator');
      socket = null;
      ready = null;
    },
  };
}

// getScope() returns { scope, label }: the operator's current selection,
// sent with each question so the answer is about what is on screen.
export function initializeAssistantPanel({ getToken, getScope = () => ({ scope: undefined, label: '전체 현황' }) }) {
  const drawer = document.querySelector('#assistant-drawer');
  const messages = document.querySelector('#assistant-messages');
  const form = document.querySelector('#assistant-form');
  const question = document.querySelector('#assistant-question');
  const reportButton = document.querySelector('#assistant-report');
  const stopButton = document.querySelector('#assistant-stop');
  const submitButton = form.querySelector('button[type="submit"]');
  const railButton = document.querySelector('[data-rail=assistant]');
  const scopeLabel = document.querySelector('#assistant-scope');
  // requestId -> { element, content, text, sources, model, retrievalError, snapshotAt, renderQueued }
  const answers = new Map();
  let current = null;

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

  function setBusy(busy) {
    submitButton.disabled = busy;
    reportButton.disabled = busy;
    stopButton.hidden = !busy;
  }

  function markUnread() {
    if (drawer.hidden && railButton) railButton.classList.add('has-unread');
  }

  function currentScope() {
    try {
      return getScope() ?? { scope: undefined, label: '전체 현황' };
    } catch {
      return { scope: undefined, label: '전체 현황' };
    }
  }

  function showScope() {
    if (scopeLabel) scopeLabel.textContent = `질문 대상: ${currentScope().label}`;
  }

  // Reopening the panel shows what arrived in the background.
  new MutationObserver(() => {
    if (!drawer.hidden) {
      showScope();
      if (railButton) railButton.classList.remove('has-unread');
      messages.scrollTop = messages.scrollHeight;
    }
  }).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
  // Selection changes while the panel is open (map clicks, mode switch).
  setInterval(() => { if (!drawer.hidden) showScope(); }, 1000);

  function renderFooter(answer, note) {
    if (answer.sources?.length) {
      const sources = document.createElement('details');
      sources.className = 'assistant-sources';
      const summary = document.createElement('summary');
      summary.textContent = `근거 KOSHA 지침 ${answer.sources.length}건`;
      const list = document.createElement('ul');
      for (const source of answer.sources) {
        const li = document.createElement('li');
        li.textContent = sourceLabel(source);
        if (source.source_relpath) li.title = source.source_relpath;
        list.append(li);
      }
      sources.append(summary, list);
      answer.element.append(sources);
    }
    const meta = document.createElement('p');
    meta.className = 'assistant-meta';
    const at = new Date(answer.snapshotAt);
    const parts = [];
    if (answer.subject) parts.push(answer.subject);
    parts.push(`현황 기준 ${Number.isNaN(at.getTime()) ? '-' : at.toLocaleTimeString('ko-KR', { hour12: false })}`);
    if (answer.model) parts.push(answer.model);
    if (answer.retrievalError) parts.push('지침 검색 실패: 현황만으로 답변');
    if (note) parts.push(note);
    meta.textContent = parts.join(' · ');
    answer.element.append(meta);
  }

  function renderText(answer) {
    answer.renderQueued = false;
    answer.content.replaceChildren(renderMarkdown(answer.text));
    if (!drawer.hidden) messages.scrollTop = messages.scrollHeight;
  }

  function queueRender(answer) {
    if (answer.renderQueued) return;
    answer.renderQueued = true;
    requestAnimationFrame(() => renderText(answer));
  }

  function finish(answer, { error = null, note = null } = {}) {
    answer.element.classList.remove('assistant-message--pending', 'assistant-message--streaming');
    if (error && !answer.text) {
      answer.element.classList.add('assistant-message--error');
      answer.content.textContent = `답변을 받지 못했습니다: ${error}`;
    } else {
      renderText(answer);
      renderFooter(answer, error ? `중단됨: ${error}` : note);
    }
    answers.delete(answer.requestId);
    if (current === answer) { current = null; setBusy(false); }
    markUnread();
  }

  const connection = createAssistantConnection({
    getToken,
    onEvent(message) {
      const answer = answers.get(message.requestId);
      if (!answer) return;
      if (message.type === 'start') {
        answer.snapshotAt = message.snapshotAt;
        answer.subject = message.subject || answer.subject;
        answer.element.classList.remove('assistant-message--pending');
        answer.element.classList.add('assistant-message--streaming');
        answer.content.textContent = '';
      } else if (message.type === 'meta') {
        Object.assign(answer, { sources: message.sources, model: message.model, retrievalError: message.retrievalError });
      } else if (message.type === 'delta') {
        answer.text += message.text;
        queueRender(answer);
      } else if (message.type === 'done') {
        answer.model = message.model || answer.model;
        finish(answer);
      } else if (message.type === 'error') {
        finish(answer, { error: message.message });
      }
    },
    onLost(reason) {
      for (const answer of [...answers.values()]) finish(answer, { error: reason });
    },
  });

  async function ask(body, label) {
    if (current) return;
    bubble('user', label);
    const element = bubble('assistant', '');
    element.classList.add('assistant-message--pending');
    const content = document.createElement('div');
    content.textContent = '현황을 확인하고 답변을 준비하는 중…';
    element.append(content);
    const requestId = newRequestId();
    const { scope, label: subject } = currentScope();
    showScope();
    const answer = { requestId, element, content, text: '', sources: [], model: '', retrievalError: null, snapshotAt: null, subject, renderQueued: false };
    answers.set(requestId, answer);
    current = answer;
    setBusy(true);
    try {
      await connection.send({ type: 'ask', requestId, ...body, ...(scope ? { scope } : {}) });
    } catch (error) {
      if (answers.has(requestId)) finish(answer, { error: error.message });
    }
  }

  stopButton.addEventListener('click', () => {
    const answer = current;
    connection.abort();
    if (answer) finish(answer, { note: '중지됨' });
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = question.value.trim();
    if (!text || current) return;
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
