// 轻量 Markdown → rich-text HTML。
// 只处理笔记/回答里最适合手机阅读的结构；公式保持原样（要渲染 LaTeX 请换 towxml 等组件）。

const STYLES = {
  p: 'margin:0 0 18rpx;line-height:1.75;font-size:30rpx;color:#2b2b26;',
  h1: 'margin:8rpx 0 16rpx;font-size:36rpx;font-weight:600;color:#1f3d33;',
  h2: 'margin:24rpx 0 14rpx;font-size:33rpx;font-weight:600;color:#1f3d33;',
  h3: 'margin:22rpx 0 12rpx;font-size:31rpx;font-weight:600;color:#1f3d33;',
  li: 'margin:0 0 10rpx;line-height:1.7;font-size:30rpx;color:#2b2b26;',
  ul: 'margin:0 0 18rpx;padding-left:36rpx;',
  ol: 'margin:0 0 18rpx;padding-left:42rpx;',
  code: 'font-family:monospace;background:#e9e3d4;padding:2rpx 8rpx;border-radius:6rpx;font-size:28rpx;',
  pre: 'margin:0 0 18rpx;background:#efeade;padding:20rpx;border-radius:12rpx;font-family:monospace;font-size:26rpx;color:#2b2b26;',
  quote: 'margin:0 0 18rpx;padding:6rpx 0 6rpx 18rpx;border-left:6rpx solid #cfc6b0;color:#655f51;'
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<span style="' + STYLES.code + '">$1</span>')
    .replace(/\*\*([^*]+)\*\*/g, '<span style="font-weight:600">$1</span>')
    .replace(/__([^_]+)__/g, '<span style="font-weight:600">$1</span>');
}

function toHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let listType = '';
  let codeLines = [];
  let inCode = false;

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    out.push('<p style="' + STYLES.p + '">' + inline(paragraph.join(' ')) + '</p>');
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) {
      return;
    }
    out.push('</' + listType + '>');
    listType = '';
  };

  const closeCode = () => {
    if (!inCode) {
      return;
    }
    out.push('<pre style="' + STYLES.pre + '">' + escapeHtml(codeLines.join('\n')) + '</pre>');
    codeLines = [];
    inCode = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (/^\s*```/.test(line)) {
      if (inCode) {
        closeCode();
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const tag = 'h' + heading[1].length;
      out.push('<' + tag + ' style="' + STYLES[tag] + '">' + inline(heading[2]) + '</' + tag + '>');
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      flushParagraph();
      closeList();
      out.push('<div style="height:1px;background:#ded6c4;margin:20rpx 0"></div>');
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      out.push('<div style="' + STYLES.quote + '">' + inline(quote[1]) + '</div>');
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.、)]\s+(.*)$/);
    if (unordered || ordered) {
      flushParagraph();
      const wanted = unordered ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        listType = wanted;
        out.push('<' + listType + ' style="' + STYLES[listType] + '">');
      }
      out.push('<li style="' + STYLES.li + '">' + inline((unordered || ordered)[1]) + '</li>');
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  closeCode();
  flushParagraph();
  closeList();
  return out.join('') || '<p style="' + STYLES.p + '">（空）</p>';
}

module.exports = { toHtml: toHtml };
