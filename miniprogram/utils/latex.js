// 轻量 LaTeX → rich-text HTML：只覆盖中学数学里真正常见的写法。
//
// 为什么不用 towxml / KaTeX：小程序 rich-text 不加载外部 CSS，KaTeX 的排版全靠类名定位，
// 拿不到样式就是一堆错位字符；引第三方组件又会把包体撑大几 MB。这里改为“把公式变成
// 可读的 Unicode + <sup>/<sub>”，分式写成 (分子)/(分母)，根号写成 √(…)，
// 希腊字母和运算符直接换成对应字符。显示效果不如专业排版，但不再是满屏 \frac。
//
// 支持：$...$、$$...$$、\(...\)、\[...\]（代码块/行内代码里的 $ 不动）。

const TOKEN = '\u0001';

const SYMBOLS = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡',
  sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫',
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆', circ: '∘',
  to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐',
  leftrightarrow: '↔', mapsto: '↦', implies: '⟹', iff: '⟺',
  infty: '∞', partial: '∂', nabla: '∇', angle: '∠', triangle: '△', perp: '⊥',
  parallel: '∥', forall: '∀', exists: '∃', nexists: '∄', therefore: '∴', because: '∵',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇',
  cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅', setminus: '∖',
  sum: '∑', prod: '∏', int: '∫', iint: '∬', oint: '∮', bigcup: '⋃', bigcap: '⋂',
  ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮', ddots: '⋱',
  prime: '′', degree: '°', hbar: 'ℏ', ell: 'ℓ', neg: '¬', land: '∧', lor: '∨',
  lbrace: '{', rbrace: '}', langle: '⟨', rangle: '⟩', lvert: '|', rvert: '|',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', backslash: '\\', '%': '%', '$': '$',
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  log: 'log', ln: 'ln', lg: 'lg', exp: 'exp', lim: 'lim', max: 'max', min: 'min',
  sup: 'sup', inf: 'inf', det: 'det', gcd: 'gcd', mod: 'mod',
  quad: ' ', qquad: ' ', ' ': ' ', ',': ' ', ';': ' ', ':': ' ', '!': '', '\\': ''
};

// 数学字母：\mathbb{R} 之类，直接给字符
const BLACKBOARD = { R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ' };

const SUPERSCRIPTS = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ', y: 'ʸ'
};

const SUBSCRIPTS = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ',
  j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ',
  u: 'ᵤ', v: 'ᵥ', x: 'ₓ'
};

const COMBINING = { hat: '\u0302', bar: '\u0304', overline: '\u0304', vec: '\u20D7', dot: '\u0307' };

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function group(source, start) {
  // 从 start（指向 '{'）读出成对花括号内的内容，返回 {body, next}
  if (source[start] !== '{') {
    return null;
  }
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (!depth) {
        return { body: source.slice(start + 1, index), next: index + 1 };
      }
    }
  }
  return { body: source.slice(start + 1), next: source.length };
}

function nextUnit(source, start) {
  // ^x、^{2}、^\\alpha 这类“一个单元”
  if (start >= source.length) {
    return { body: '', next: start };
  }
  if (source[start] === '{') {
    return group(source, start);
  }
  if (source[start] === '\\') {
    const match = /^\\([A-Za-z]+|.)/.exec(source.slice(start));
    const body = match ? match[0] : source[start];
    return { body, next: start + body.length };
  }
  return { body: source[start], next: start + 1 };
}

function wrapSup(body, html) {
  if (!body) {
    return '';
  }
  const plain = body.length <= 2 && [...body].every((char) => SUPERSCRIPTS[char]);
  if (plain) {
    return [...body].map((char) => SUPERSCRIPTS[char]).join('');
  }
  return '<sup>' + html + '</sup>';
}

function wrapSub(body, html) {
  if (!body) {
    return '';
  }
  const plain = body.length <= 2 && [...body].every((char) => SUBSCRIPTS[char]);
  if (plain) {
    return [...body].map((char) => SUBSCRIPTS[char]).join('');
  }
  return '<sub>' + html + '</sub>';
}

function render(source) {
  let out = '';
  let index = 0;
  const text = String(source || '').replace(/\r\n?/g, '\n');

  while (index < text.length) {
    const char = text[index];

    if (char === '\\') {
      const match = /^\\([A-Za-z]+|.)/.exec(text.slice(index));
      const name = match ? match[1] : '';
      const consumed = match ? match[0].length : 1;

      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        let cursor = index + consumed;
        const first = group(text, cursor);
        if (first) {
          cursor = first.next;
          const second = group(text, cursor);
          if (second) {
            index = second.next;
            out += '(' + render(first.body).trim() + ')/(' + render(second.body).trim() + ')';
            continue;
          }
        }
        index += consumed;
        continue;
      }

      if (name === 'sqrt') {
        let cursor = index + consumed;
        let degree = '';
        if (text[cursor] === '[') {
          const close = text.indexOf(']', cursor);
          if (close !== -1) {
            degree = render(text.slice(cursor + 1, close)).trim();
            cursor = close + 1;
          }
        }
        const body = group(text, cursor);
        if (body) {
          index = body.next;
          const inner = render(body.body).trim();
          out += (degree ? degree + '√' : '√') + '(' + inner + ')';
          continue;
        }
        index += consumed;
        continue;
      }

      if (name === 'text' || name === 'mathrm' || name === 'operatorname' || name === 'mbox') {
        const body = group(text, index + consumed);
        if (body) {
          index = body.next;
          out += escapeHtml(body.body.replace(/\\ /g, ' '));
          continue;
        }
        index += consumed;
        continue;
      }

      if (name === 'mathbb') {
        const body = group(text, index + consumed);
        if (body) {
          index = body.next;
          const letter = body.body.trim();
          out += BLACKBOARD[letter] || escapeHtml(letter);
          continue;
        }
        index += consumed;
        continue;
      }

      if (name === 'mathbf' || name === 'mathcal' || name === 'boldsymbol' || name === 'mathit') {
        const body = group(text, index + consumed);
        if (body) {
          index = body.next;
          out += '<b>' + render(body.body) + '</b>';
          continue;
        }
        index += consumed;
        continue;
      }

      if (COMBINING[name]) {
        const unit = nextUnit(text, index + consumed);
        index = unit.next;
        out += render(unit.body).replace(/<\/?[^>]+>/g, '') + COMBINING[name];
        continue;
      }

      if (name === 'begin' || name === 'end') {
        const body = group(text, index + consumed);
        index = body ? body.next : index + consumed;
        continue;
      }

      if (name === 'left' || name === 'right') {
        // \left( / \right) 只保留括号本身，丢掉定界符控制词
        index += consumed;
        continue;
      }

      if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
        index += consumed;
        out += SYMBOLS[name];
        continue;
      }

      // 不认识的命令：去掉反斜杠，避免正文里出现 \foo
      index += consumed;
      out += escapeHtml(name);
      continue;
    }

    if (char === '^' || char === '_') {
      const unit = nextUnit(text, index + 1);
      index = unit.next;
      const html = render(unit.body);
      out += char === '^' ? wrapSup(unit.body, html) : wrapSub(unit.body, html);
      continue;
    }

    if (char === '{' || char === '}') {
      index += 1; // 纯分组花括号不显示
      continue;
    }

    if (char === '&') {
      index += 1;
      out += ' , ';
      continue;
    }

    if (char === '~') {
      index += 1;
      out += '&nbsp;';
      continue;
    }

    if (char === '$') {
      index += 1;
      continue;
    }

    out += escapeHtml(char);
    index += 1;
  }

  return out.replace(/\s+\n/g, '\n').trim();
}

function renderMath(tex, display) {
  const body = render(tex);
  if (!body) {
    return '';
  }
  const style = display
    ? 'display:inline-block;width:100%;text-align:center;margin:14rpx 0;font-family:Georgia,serif;font-size:32rpx;color:#1f3d33;'
    : 'font-family:Georgia,serif;font-size:30rpx;color:#1f3d33;white-space:nowrap;';
  return '<span style="' + style + '">' + body + '</span>';
}

function tokenFor(rendered, html) {
  rendered.push(html);
  return TOKEN + (rendered.length - 1) + TOKEN;
}

// 行内 $ 太容易被当成货币（“价格 $5”）：只有内容真的像公式才当公式。
function looksLikeMath(inner) {
  if (!inner || inner.includes('\n') || inner.includes('$')) {
    return false;
  }
  if (/^\s/.test(inner) || /\s$/.test(inner)) {
    return false;
  }
  if (/[\\^_{}=+\-*/><|~()\[\]'′°]/.test(inner)) {
    return true;
  }
  return /^[A-Za-z0-9]$/.test(inner);
}

// 把 markdown 里的公式抽成占位符，交给 markdown 渲染器原样穿过，最后再换回 HTML。
function extract(markdown) {
  const source = String(markdown || '');
  const rendered = [];
  let text = '';
  let index = 0;

  while (index < source.length) {
    if (source.startsWith('```', index)) {
      const end = source.indexOf('```', index + 3);
      const stop = end === -1 ? source.length : end + 3;
      text += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      const stop = end === -1 ? source.length : end + 1;
      text += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (source.startsWith('$$', index)) {
      const end = source.indexOf('$$', index + 2);
      if (end !== -1) {
        text += tokenFor(rendered, renderMath(source.slice(index + 2, end), true));
        index = end + 2;
        continue;
      }
    }
    if (source.startsWith('\\[', index)) {
      const end = source.indexOf('\\]', index + 2);
      if (end !== -1) {
        text += tokenFor(rendered, renderMath(source.slice(index + 2, end), true));
        index = end + 2;
        continue;
      }
    }
    if (source.startsWith('\\(', index)) {
      const end = source.indexOf('\\)', index + 2);
      if (end !== -1) {
        text += tokenFor(rendered, renderMath(source.slice(index + 2, end), false));
        index = end + 2;
        continue;
      }
    }
    if (source[index] === '$') {
      const end = source.indexOf('$', index + 1);
      const inner = end === -1 ? '' : source.slice(index + 1, end);
      if (end !== -1 && looksLikeMath(inner)) {
        text += tokenFor(rendered, renderMath(inner, false));
        index = end + 1;
        continue;
      }
    }
    text += source[index];
    index += 1;
  }

  return { text, rendered };
}

function restore(html, rendered) {
  const pattern = new RegExp(TOKEN + '(\\d+)' + TOKEN, 'g');
  return String(html || '').replace(pattern, (whole, index) => rendered[Number(index)] || '');
}

module.exports = { extract, restore, renderMath, render };
