// Copyright 2026 Coresource AI, Inc. SPDX-License-Identifier: Apache-2.0
// Small, dependency-free Markdown renderer. Escapes first, then formats; links keep only http(s) targets.
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeHref = (raw) => { try { const url = new URL(raw); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; } catch { return null; } };
const HOLD = /@@code(\d+)@@/g;

export function renderInline(text) {
  let out = escape(text);
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => { codes.push(`<code>${code}</code>`); return `@@code${codes.length - 1}@@`; });
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, target) => {
    const href = safeHref(target.replace(/&amp;/g, '&'));
    return href ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : match;
  });
  out = out.replace(/(^|[^\w"=])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (match, lead, target) => {
    const href = safeHref(target.replace(/&amp;/g, '&'));
    return href ? `${lead}<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${target}</a>` : match;
  });
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(HOLD, (_, index) => codes[Number(index)]);
}

function tableRow(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim()); }
const isTableDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (line) => line.match(/^\s*/)[0].length;

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let index = 0;
  const paragraph = [];
  const flush = () => { if (paragraph.length) { html.push(`<p>${renderInline(paragraph.join(' '))}</p>`); paragraph.length = 0; } };
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      flush(); const code = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index++; html.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); continue;
    }
    if (!line.trim()) { flush(); index++; continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flush(); const level = Math.min(heading[1].length, 4); html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`); index++; continue; }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html.push('<hr>'); index++; continue; }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flush(); const head = tableRow(line); index += 2; const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(tableRow(lines[index++]));
      html.push(`<table><thead><tr>${head.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${head.map((_, column) => `<td>${renderInline(row[column] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush(); const quote = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      html.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`); continue;
    }
    const item = line.match(LIST_ITEM);
    if (item) {
      flush(); const ordered = /\d/.test(item[2]); const indent = item[1].length; const items = [];
      while (index < lines.length) {
        const current = lines[index]; const match = current.match(LIST_ITEM);
        if (match && match[1].length === indent && /\d/.test(match[2]) === ordered) { items.push({ text: match[3], nested: [] }); index++; continue; }
        if (items.length && current.trim() && indentOf(current) > indent) { items[items.length - 1].nested.push(current.slice(Math.min(current.length, indent + 2))); index++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map(({ text, nested }) => `<li>${renderInline(text)}${nested.length ? renderMarkdown(nested.join('\n')) : ''}</li>`).join('')}</${tag}>`); continue;
    }
    paragraph.push(line.trim()); index++;
  }
  flush();
  return html.join('\n');
}
