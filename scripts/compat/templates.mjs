function javascriptTokens(source, file, lineOffset) {
  const tokens = [];
  let i = 0;
  let line = lineOffset;
  while (i < source.length) {
    const start = i;
    const startLine = line;
    const char = source[i];
    if (/\s/.test(char)) { if (char === '\n') line++; i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`${file}:${line}: JS 块注释未闭合`);
      line += (source.slice(i, end + 2).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    let kind = 'symbol';
    let value = char;
    if (["'", '"', '`'].includes(char)) {
      i++;
      let closed = false;
      let interpolationDepth = 0;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (char === '`') {
          if (source.startsWith('${', i)) { interpolationDepth++; i += 2; continue; }
          if (interpolationDepth && source[i] === '{') interpolationDepth++;
          if (interpolationDepth && source[i] === '}') interpolationDepth--;
          if (source[i] === '`' && interpolationDepth) throw new Error(`${file}:${line}: 尚不支持嵌套 JS 模板字串，禁止截断 URL 表达式`);
        }
        if (source[i++] === char) { closed = true; break; }
      }
      if (!closed) throw new Error(`${file}:${line}: JS 字符串未闭合`);
      const raw = source.slice(start + 1, i - 1);
      value = raw.replace(/\\(['"`\\])/g, '$1');
      line += (raw.match(/\n/g) || []).length;
      kind = char === '`' && raw.includes('${') ? 'template' : 'string';
    } else if (char === '/' && (!tokens.length || ['=', '(', ',', ':', 'return', '!', '[', '&&', '||'].includes(tokens.at(-1).value))) {
      i++;
      let inClass = false;
      let closed = false;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        if (source[i] === ']') inClass = false;
        if (source[i++] === '/' && !inClass) { closed = true; break; }
      }
      if (!closed) throw new Error(`${file}:${line}: 无法识别 JS 正则表达式`);
      while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
      kind = 'regex';
      value = source.slice(start, i);
    } else {
      const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
      if (word) { value = word[0]; kind = 'word'; i += value.length; }
      else i++;
    }
    tokens.push({ value, kind, start, end: i, line: startLine });
  }
  return tokens;
}

function expressionEnd(tokens, start) {
  const stack = [];
  const pairs = { '(': ')', '[': ']', '{': '}' };
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'symbol') continue;
    if (stack.length === 0 && [',', ';', ')', '}', ']'].includes(token.value)) return i;
    if (pairs[token.value]) stack.push(pairs[token.value]);
    else if (stack.at(-1) === token.value) stack.pop();
  }
  return tokens.length;
}

export function scanTemplate(source, file) {
  const calls = [];
  const diagnostics = [];
  for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    const script = match[1];
    const bodyOffset = match.index + match[0].indexOf('>') + 1;
    const lineOffset = 1 + (source.slice(0, bodyOffset).match(/\n/g) || []).length;
    const tokens = javascriptTokens(script, file, lineOffset);
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      let kind;
      let start;
      if (token.value === 'url' && ['word', 'string'].includes(token.kind) && tokens[i + 1]?.value === ':') { kind = 'url-property'; start = i + 2; }
      else if (['$', 'jQuery'].includes(token.value) && tokens[i + 1]?.value === '.' && ['post', 'get', 'getJSON'].includes(tokens[i + 2]?.value) && tokens[i + 3]?.value === '(') { kind = `jquery-${tokens[i + 2].value}`; start = i + 4; }
      else if (token.value === 'fetch' && token.kind === 'word' && tokens[i + 1]?.value === '(') { kind = 'fetch'; start = i + 2; }
      else if (token.value === 'window' && tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'open' && tokens[i + 3]?.value === '(') { kind = 'window-open'; start = i + 4; }
      else if (token.value === 'location' && token.kind === 'word') {
        if (tokens[i + 1]?.value === '=') { kind = 'navigation'; start = i + 2; }
        else if (tokens[i + 1]?.value === '.' && tokens[i + 2]?.value === 'href' && tokens[i + 3]?.value === '=') { kind = 'navigation'; start = i + 4; }
      }
      if (!kind) continue;
      const end = expressionEnd(tokens, start);
      if (end === start) throw new Error(`${file}:${token.line}: 模板调用 URL 表达式为空`);
      const first = tokens[start];
      const expression = script.slice(first.start, tokens[end - 1].end).trim();
      const staticValue = end === start + 1 && first.kind === 'string';
      const resolution = staticValue && first.value === '' ? 'current-page' : staticValue && !/\{\$/.test(first.value) ? 'literal' : 'dynamic';
      calls.push({ kind, line: token.line, expression, url: staticValue ? first.value : null, literalPrefix: ['string', 'template'].includes(first.kind) ? first.value : null, resolution });
      if (resolution === 'dynamic') diagnostics.push({ code: 'DYNAMIC_TEMPLATE_URL', line: token.line, kind });
    }
  }
  return { file, calls, diagnostics };
}
