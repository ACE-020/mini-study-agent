/**
 * @fileoverview latex 插件
 * katex.min.js来源 https://github.com/rojer95/katex-mini
 *
 * 公式在 markdown 解析前先抽成占位符：这样 `$...$` 里的 * _ \\ & 不会被
 * markdown 当成强调/换行/表格语法改坏，代码块和行内代码也不会被公式化。
 * 真正的 KaTeX 节点在 parser 的文本节点阶段换回；非法公式由 katex-mini
 * 返回红色错误节点，保持可见，不会让整条消息渲染失败。
 */
const parse = require('./katex.min')

const MATH_TOKEN = '\u0001'
const LITERAL_TOKEN = '\u0002'
const MATH_PATTERN = /\u0001(\d+)\u0001|\u0002(\d+)\u0002/g

function findClose (text, start, closer, limit) {
  const stop = limit === undefined ? text.length : Math.min(text.length, limit)
  for (let i = start; i < stop; i += 1) {
    if (text.startsWith(closer, i)) return i
    if (text[i] === '\\') i += 1
  }
  return -1
}

function looksLikeMath (inner, next) {
  if (!inner || inner.includes('\n')) return false
  if (/^\s|\s$/.test(inner)) return false
  if (next && /[0-9]/.test(next)) return false
  return true
}

function isEnvironment (name) {
  return /^(?:aligned|align\*?|equation\*?|cases|pmatrix|bmatrix|vmatrix|array|matrix|gathered)$/.test(name)
}

function stripQuote (source, text, start) {
  return /(?:^|\n)[ \t]*>[ \t]*$/.test(text.slice(0, start)) ? source.replace(/\n[ \t]*>[ \t]?/g, '\n') : source
}

function normalizeTex (source, display) {
  let tex = source
  if (display && /^\\begin\{/.test(tex)) {
    tex = tex.replace(/\\(begin|end)\{align\*?\}/g, '\\$1{aligned}')
      .replace(/\\(?:begin|end)\{equation\*?\}/g, '')
  }
  return tex
}

function extract (text, parts) {
  let out = ''
  let index = 0
  const literal = (value) => {
    parts.push({ literal: true, text: value || '$' })
    return LITERAL_TOKEN + (parts.length - 1) + LITERAL_TOKEN
  }
  const math = (source, display, raw, start) => {
    source = stripQuote(source, text, start)
    parts.push({ literal: false, tex: normalizeTex(source, display), raw: raw || source, display: display })
    return MATH_TOKEN + (parts.length - 1) + MATH_TOKEN
  }

  while (index < text.length) {
    if (text.startsWith('~~~', index) && (index === 0 || text[index - 1] === '\n')) {
      const end = text.indexOf('~~~', index + 3)
      const stop = end < 0 ? text.length : end + 3
      out += text.slice(index, stop)
      index = stop
      continue
    }
    if (text.startsWith('```', index)) {
      const end = text.indexOf('```', index + 3)
      const stop = end < 0 ? text.length : end + 3
      out += text.slice(index, stop)
      index = stop
      continue
    }
    if (text[index] === '`') {
      let run = 1
      while (text[index + run] === '`') run += 1
      const fence = '`'.repeat(run)
      const end = text.indexOf(fence, index + run)
      const stop = end < 0 ? text.length : end + run
      out += text.slice(index, stop)
      index = stop
      continue
    }
    if ((index === 0 || text[index - 1] === '\n') && ((text[index] === ' ' && text[index + 1] === ' ' && text[index + 2] === ' ' && text[index + 3] === ' ') || text[index] === '\t')) {
      const end = text.indexOf('\n', index)
      const stop = end < 0 ? text.length : end
      out += text.slice(index, stop)
      index = stop
      continue
    }
    if (text[index] === '<' && /^<(pre|code)\b/i.test(text.slice(index, index + 8))) {
      const tag = /^<(pre|code)\b/i.exec(text.slice(index, index + 8))[1].toLowerCase()
      const end = text.toLowerCase().indexOf('</' + tag + '>', index)
      const stop = end < 0 ? text.length : end + tag.length + 3
      out += text.slice(index, stop)
      index = stop
      continue
    }
    if (text[index] === '<') {
      const close = text.indexOf('>', index + 1)
      if (close >= 0) {
        const candidate = text.slice(index, close + 1)
        if (/^<\/?[A-Za-z][^>\n]*>$/.test(candidate)) {
          out += candidate
          index = close + 1
          continue
        }
      }
    }
    if (text.startsWith('\\$', index)) {
      out += literal('$')
      index += 2
      continue
    }
    if (text.startsWith('\\[', index)) {
      const end = findClose(text, index + 2, '\\]')
      if (end >= 0) {
        out += math(text.slice(index + 2, end), true, text.slice(index, end + 2), index)
        index = end + 2
        continue
      }
    }
    if (text.startsWith('\\(', index)) {
      const end = findClose(text, index + 2, '\\)')
      if (end >= 0) {
        out += math(text.slice(index + 2, end), false, text.slice(index, end + 2), index)
        index = end + 2
        continue
      }
    }
    if (text.startsWith('$$', index)) {
      const end = findClose(text, index + 2, '$$')
      if (end >= 0) {
        out += math(text.slice(index + 2, end), true, text.slice(index, end + 2), index)
        index = end + 2
        continue
      }
    }
    if (text[index] === '$') {
      const lineEnd = text.indexOf('\n', index + 1)
      const end = findClose(text, index + 1, '$', lineEnd < 0 ? undefined : lineEnd)
      if (end >= 0 && looksLikeMath(text.slice(index + 1, end), text[end + 1])) {
        out += math(text.slice(index + 1, end), false, text.slice(index, end + 1), index)
        index = end + 1
        continue
      }
      out += text[index]
      index += 1
      continue
    }
    if (text.startsWith('\\begin{', index)) {
      const env = /^\\begin\{([A-Za-z*]+)\}/.exec(text.slice(index))
      if (env && isEnvironment(env[1])) {
        const close = '\\end{' + env[1] + '}'
        const end = text.indexOf(close, index)
        if (end >= 0) {
          const stop = end + close.length
          out += math(text.slice(index, stop), true, text.slice(index, stop), index)
          index = stop
          continue
        }
      }
    }
    out += text[index]
    index += 1
  }
  return out
}

function inCode (vm) {
  if (!vm) return false
  if (vm.pre) return true
  for (let i = vm.stack.length; i--;) {
    const name = vm.stack[i] && vm.stack[i].name
    if (name === 'code' || name === 'pre') return true
  }
  return false
}

function mathChildren (part) {
  let nodes
  try {
    nodes = parse.default(part.tex, {
      displayMode: part.display,
      throwOnError: false,
      trust: false,
      strict: 'ignore'
    })
  } catch (error) {
    nodes = null
  }
  if (!nodes || !nodes.length) return [{ type: 'text', text: part.raw }]
  const style = part.display
    ? 'text-align:center;max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch'
    : 'display:inline-block;max-width:100%;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch;vertical-align:middle'
  if (part.display) {
    return [{
      name: 'div',
      attrs: { style: style },
      f: style,
      children: nodes
    }]
  }
  return [{
    name: 'span',
    attrs: { style: style },
    f: style,
    children: nodes
  }]
}

function cleanAttributes (node, parts) {
  if (!node.attrs) return
  for (const name of ['title', 'alt']) {
    if (typeof node.attrs[name] !== 'string') continue
    node.attrs[name] = node.attrs[name].replace(MATH_PATTERN, (token, mathIndex, literalIndex) => {
      const part = parts[Number(mathIndex !== undefined ? mathIndex : literalIndex)]
      return part ? part.raw || part.text : token
    })
  }
}

function Latex (vm) {
  this.vm = vm
  this.parts = []
}

Latex.prototype.onUpdate = function (content) {
  const options = (this.vm && this.vm.data) || {}
  this.parts = []
  if (options.editable) return content
  return extract(String(content || ''), this.parts)
}

Latex.prototype.onParse = function (node, vm) {
  if (!node) return
  if (node.attrs) cleanAttributes(node, this.parts)
  if (node.type !== 'text' || !node.text) return
  if (vm.options.editable) return
  if (node.text.indexOf(MATH_TOKEN) < 0 && node.text.indexOf(LITERAL_TOKEN) < 0) return
  if (inCode(vm)) {
    node.text = node.text.replace(MATH_PATTERN, (token, mathIndex, literalIndex) => {
      const part = this.parts[Number(mathIndex !== undefined ? mathIndex : literalIndex)]
      return part ? part.raw || part.text : token
    })
    return
  }

  const children = []
  MATH_PATTERN.lastIndex = 0
  let last = 0
  let match
  while ((match = MATH_PATTERN.exec(node.text))) {
    if (match.index > last) children.push({ type: 'text', text: node.text.slice(last, match.index) })
    const part = this.parts[Number(match[1] !== undefined ? match[1] : match[2])]
    if (!part) {
      children.push({ type: 'text', text: match[0] })
    } else if (part.literal) {
      children.push({ type: 'text', text: part.text })
    } else {
      for (const child of mathChildren(part)) children.push(child)
    }
    last = MATH_PATTERN.lastIndex
  }
  if (last < node.text.length) children.push({ type: 'text', text: node.text.slice(last) })

  if (!children.some((child) => child.name)) {
    node.text = children.map((child) => child.text || '').join('')
    return
  }
  delete node.type
  delete node.text
  node.name = 'span'
  node.attrs = {}
  node.children = children
}

module.exports = Latex
