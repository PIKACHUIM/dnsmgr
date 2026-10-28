// 仅解析契约所需的 PHP 子集；不加载或执行旧 PHP。
export function tokenize(source, file = '<PHP>') {
  const tokens = [];
  let offset = 0;
  let line = 1;
  const fail = (message) => { throw new Error(`${file}:${line}: ${message}`); };
  while (offset < source.length) {
    const rest = source.slice(offset);
    const ignored = /^(?:\s+|<\?php\b|\?>)/.exec(rest);
    if (ignored) {
      line += (ignored[0].match(/\n/g) || []).length;
      offset += ignored[0].length;
      continue;
    }
    if (rest.startsWith('//') || rest.startsWith('#')) {
      const end = source.indexOf('\n', offset);
      offset = end === -1 ? source.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', offset + 2);
      if (end === -1) fail('未闭合的块注释');
      line += (source.slice(offset, end + 2).match(/\n/g) || []).length;
      offset = end + 2;
      continue;
    }
    if (rest.startsWith('<<<') || rest[0] === '`') fail('尚不支持 heredoc/nowdoc 或 PHP 反引号执行字串，需人工扩展解析器');
    const start = offset;
    const startLine = line;
    let kind = 'symbol';
    let value;
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      offset++;
      let closed = false;
      while (offset < source.length) {
        if (source[offset] === '\\') { offset += 2; continue; }
        if (source[offset++] === quote) { closed = true; break; }
      }
      if (!closed) fail('未闭合的 PHP 字符串');
      const raw = source.slice(start + 1, offset - 1);
      value = raw.replace(/\\(['"\\])/g, '$1');
      line += (raw.match(/\n/g) || []).length;
      kind = quote === '"' && /\$/.test(raw) ? 'interpolated' : 'string';
    } else {
      const word = /^(?:\$[A-Za-z_][\w]*|[A-Za-z_][\w]*|\d+(?:\.\d+)?)/.exec(rest);
      const operator = /^(?:===|!==|=>|==|!=|<=|>=|::|->|\?\?|&&|\|\||\+\+|--|\.\.\.)/.exec(rest);
      const raw = word?.[0] || operator?.[0] || rest[0];
      offset += raw.length;
      value = raw;
      if (word) kind = raw[0] === '$' ? 'variable' : /^\d/.test(raw) ? 'number' : 'word';
    }
    tokens.push({ value, kind, start, end: offset, line: startLine });
  }
  return tokens;
}

export function matching(tokens, start, file = '<PHP>') {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'symbol') continue;
    if (pairs[token.value]) stack.push(pairs[token.value]);
    else if ([')', ']', '}'].includes(token.value)) {
      if (stack.pop() !== token.value) throw new Error(`${file}:${token.line}: 括号不匹配`);
      if (stack.length === 0) return i;
    }
  }
  throw new Error(`${file}:${tokens[start]?.line}: 未闭合的括号`);
}

export function argumentsOf(tokens, start, end, file) {
  const args = [];
  let previous = start;
  for (let i = start; i < end; i++) {
    if (tokens[i].kind === 'symbol' && ['(', '[', '{'].includes(tokens[i].value)) i = matching(tokens, i, file);
    else if (tokens[i].value === ',' && tokens[i].kind === 'symbol') {
      args.push(tokens.slice(previous, i));
      previous = i + 1;
    }
  }
  if (previous < end) args.push(tokens.slice(previous, end));
  return args;
}

export function literal(tokens, file, purpose) {
  if (tokens.length !== 1 || tokens[0].kind !== 'string') {
    throw new Error(`${file}:${tokens[0]?.line}: ${purpose}必须为静态字符串`);
  }
  return tokens[0].value;
}

function middlewareChain(tokens, start, file) {
  const middleware = [];
  let i = start;
  while (tokens[i]?.value === '->') {
    if (tokens[i + 1]?.value !== 'middleware' || tokens[i + 2]?.value !== '(') {
      throw new Error(`${file}:${tokens[i].line}: 未识别的 Route 链式语法`);
    }
    const end = matching(tokens, i + 2, file);
    const args = tokens.slice(i + 3, end);
    if (args.length !== 3 || args[0].kind !== 'word' || args[1].value !== '::' || args[2].value !== 'class') {
      throw new Error(`${file}:${tokens[i].line}: 未识别的 Route middleware 参数`);
    }
    middleware.push(args[0].value);
    i = end + 1;
  }
  if (tokens[i]?.value !== ';') throw new Error(`${file}:${tokens[i]?.line}: Route 声明缺少分号或含未识别语法`);
  return middleware;
}

export function scanRoutes(source, file = 'route/app.php') {
  const tokens = tokenize(source, file);
  const groups = [{ id: 'public', prefix: '', middleware: [], line: null }];
  const ranges = [];
  const routes = [];
  const patterns = [];
  let fallback = null;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].value !== 'Route' || tokens[i].kind !== 'word' || tokens[i + 1]?.value !== '::') continue;
    const call = tokens[i + 2]?.value;
    if (tokens[i + 3]?.value !== '(') throw new Error(`${file}:${tokens[i].line}: 未识别的 Route 语法`);
    const end = matching(tokens, i + 3, file);
    const args = argumentsOf(tokens, i + 4, end, file);
    const middleware = middlewareChain(tokens, end + 1, file);
    if (call === 'group') {
      if (args.length !== 1 && args.length !== 2) throw new Error(`${file}:${tokens[i].line}: 未识别的 Route group 参数`);
      const prefix = args.length === 2 ? literal(args[0], file, 'group 前缀') : '';
      const callback = args.at(-1);
      if (callback[0]?.value !== 'function' || callback[1]?.value !== '(' || callback[2]?.value !== ')' || callback[3]?.value !== '{' || callback.at(-1)?.value !== '}') {
        throw new Error(`${file}:${tokens[i].line}: 未识别的 Route group 回调`);
      }
      if (ranges.some((range) => tokens[i].start > range.start && tokens[i].end < range.end)) throw new Error(`${file}:${tokens[i].line}: 暂不支持嵌套 Route group`);
      const id = prefix || (middleware.includes('CheckLogin') ? 'authenticated' : `group-${groups.length}`);
      if (groups.some((group) => group.id === id)) throw new Error(`${file}:${tokens[i].line}: 重复的 Route group 标识`);
      const group = { id, prefix, middleware, line: tokens[i].line };
      groups.push(group);
      ranges.push({ group, start: callback[3].end, end: callback.at(-1).start });
    } else if (['get', 'post', 'any', 'put', 'patch', 'delete', 'options', 'head'].includes(call)) {
      if (args.length !== 2) throw new Error(`${file}:${tokens[i].line}: 未识别的 Route ${call} 参数`);
      const declaredPath = literal(args[0], file, '路由路径');
      const target = literal(args[1], file, '路由目标');
      if (!/^\w+\/\w+$/.test(target)) throw new Error(`${file}:${tokens[i].line}: 不支持的控制器目标格式`);
      const group = ranges.find((range) => tokens[i].start > range.start && tokens[i].end < range.end)?.group || groups[0];
      const path = `/${[group.prefix, declaredPath].filter(Boolean).join('/').split('/').filter(Boolean).join('/')}`;
      routes.push({ group: group.id, method: call.toUpperCase(), path, declaredPath, target, middleware: [...group.middleware, ...middleware], line: tokens[i].line });
    } else if (call === 'pattern') {
      if (args.length !== 1 || args[0][0]?.value !== '[' || middleware.length) throw new Error(`${file}:${tokens[i].line}: 未识别的 Route pattern`);
      for (const entry of argumentsOf(args[0], 1, args[0].length - 1, file)) {
        if (entry.length !== 3 || entry[1].value !== '=>') throw new Error(`${file}:${tokens[i].line}: 未识别的 Route pattern 条目`);
        patterns.push({ parameter: literal(entry.slice(0, 1), file, 'pattern 参数'), expression: literal(entry.slice(2), file, 'pattern 表达式') });
      }
    } else if (call === 'miss') {
      if (args.length !== 1 || args[0][0]?.value !== 'function' || middleware.length || fallback) throw new Error(`${file}:${tokens[i].line}: 未识别的 Route miss`);
      fallback = { line: tokens[i].line, kind: 'PHP callback', migrated: false };
    } else throw new Error(`${file}:${tokens[i].line}: 未识别的 Route::${call}，禁止静默遗漏`);
  }
  if (routes.length === 0) throw new Error(`${file}: 未发现 Route 声明`);
  return { groups: groups.map((group) => ({ ...group, routeCount: routes.filter((route) => route.group === group.id).length })), patterns, fallback, routes };
}

function inputSelector(tokens, i, file) {
  if (tokens[i]?.value !== 'input' || tokens[i + 1]?.value !== '(') return null;
  const end = matching(tokens, i + 1, file);
  const first = argumentsOf(tokens, i + 2, end, file)[0];
  if (first?.length !== 1 || first[0].kind !== 'string') return null;
  const match = /^(?:(param|post|get)\.)?(act|action)(?:\/([a-z]+))?$/.exec(first[0].value);
  return match ? { parameter: match[2], source: match[1] || 'param', filter: match[3] || null, end } : null;
}

function scanOperations(tokens, file) {
  const selectors = new Map();
  const bindings = new Map();
  const operations = [];
  const diagnostics = [];
  for (let i = 0; i < tokens.length; i++) {
    const input = inputSelector(tokens, i, file);
    if (input) {
      const { end, ...selector } = input;
      selectors.set(i, { ...selector, end });
      i = end;
      continue;
    }
    if (tokens[i].kind === 'variable' && tokens[i + 1]?.value === '=') {
      const assigned = inputSelector(tokens, i + 2, file);
      if (assigned) {
        const { end, ...selector } = assigned;
        bindings.set(tokens[i].value, selector);
      } else bindings.delete(tokens[i].value);
    }
    if (tokens[i].kind === 'variable' && bindings.has(tokens[i].value)) selectors.set(i, { ...bindings.get(tokens[i].value), end: i });
  }
  const contexts = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!['if', 'elseif', 'switch', 'match'].includes(tokens[i].value) || tokens[i].kind !== 'word' || tokens[i + 1]?.value !== '(') continue;
    const end = matching(tokens, i + 1, file);
    for (let index = i + 2; index < end; index++) {
      if (tokens[index].kind === 'variable' && ['$act', '$action'].includes(tokens[index].value) && !selectors.has(index)) {
        throw new Error(`${file}:${tokens[index].line}: act/action 条件的变量绑定不明确，禁止静默遗漏`);
      }
      if (['$_GET', '$_POST', '$_REQUEST'].includes(tokens[index].value) && tokens[index + 1]?.value === '[' && ['act', 'action'].includes(tokens[index + 2]?.value)) {
        throw new Error(`${file}:${tokens[index].line}: act/action 原始请求数组分支尚未支持，禁止静默遗漏`);
      }
    }
    if (['switch', 'match'].includes(tokens[i].value) && [...selectors.keys()].some((index) => index > i && index < end)) {
      throw new Error(`${file}:${tokens[i].line}: act/action 的 ${tokens[i].value} 分支尚未支持，禁止静默遗漏`);
    }
    const body = end + 1;
    let bodyEnd = body;
    if (tokens[body]?.value === '{') bodyEnd = matching(tokens, body, file);
    else {
      while (bodyEnd < tokens.length && tokens[bodyEnd].value !== ';') {
        if (tokens[bodyEnd].kind === 'symbol' && ['(', '[', '{'].includes(tokens[bodyEnd].value)) bodyEnd = matching(tokens, bodyEnd, file);
        bodyEnd++;
      }
    }
    contexts.push({ conditionStart: i + 2, conditionEnd: end, bodyStart: body, bodyEnd, line: tokens[i].line });
  }
  const eq = ['==', '===', '!=', '!==', '<', '>', '<=', '>='];
  for (const [start, selector] of selectors) {
    const operator = tokens[selector.end + 1];
    const right = tokens[selector.end + 2];
    const leftOperator = tokens[start - 1];
    const left = tokens[start - 2];
    const reversed = !eq.includes(operator?.value) && eq.includes(leftOperator?.value);
    const comparison = reversed ? leftOperator : operator;
    const operand = reversed ? left : right;
    if (!eq.includes(comparison?.value)) continue;
    if (operand?.kind !== 'string' && operand?.kind !== 'number') throw new Error(`${file}:${tokens[start].line}: act/action 比较的值不是静态字面量`);
    const afterOperand = reversed ? tokens[selector.end + 1] : tokens[selector.end + 3];
    if (afterOperand && ![';', ')', '?', ':', '&&', '||', ']', ',', '}', '{'].includes(afterOperand.value)) {
      throw new Error(`${file}:${tokens[start].line}: act/action 比较含复合表达式，禁止截断操作值`);
    }
    const { end, ...parameter } = selector;
    const current = contexts.find((context) => start >= context.conditionStart && start < context.conditionEnd);
    const parents = contexts.filter((context) => start > context.bodyStart && start < context.bodyEnd).map((context) => ({ line: context.line, conditionStart: context.conditionStart, conditionEnd: context.conditionEnd }));
    const operation = { ...parameter, operator: comparison.value, value: operand.value, line: tokens[start].line, kind: current ? 'branch' : 'comparison', parents };
    if (operand.kind === 'number' || !['==', '==='].includes(comparison.value)) diagnostics.push({ code: 'NON_DISPATCH_COMPARISON', line: tokens[start].line, parameter: parameter.parameter, operator: comparison.value, value: operand.value });
    operations.push({ start, operation });
  }
  for (const context of contexts) {
    const referenced = [...selectors.keys()].filter((index) => index >= context.conditionStart && index < context.conditionEnd);
    for (const index of referenced) {
      if (operations.some((operation) => operation.start === index)) continue;
      const previous = tokens[index - 2]?.value;
      if (['empty', 'isset'].includes(previous)) continue;
      throw new Error(`${file}:${tokens[index].line}: 无法识别 act/action 条件分支，需扩展解析器`);
    }
  }
  return {
    operations: operations.map(({ operation }) => ({ ...operation, parents: operation.parents.map((parent) => ({ line: parent.line, selectors: operations.filter(({ start }) => start >= parent.conditionStart && start < parent.conditionEnd).map(({ operation: outer }) => ({ parameter: outer.parameter, source: outer.source, operator: outer.operator, value: outer.value })) })) })),
    diagnostics,
  };
}

export function scanController(source, file) {
  const tokens = tokenize(source, file);
  const classIndex = tokens.findIndex((token) => token.kind === 'word' && token.value === 'class');
  if (classIndex < 0) throw new Error(`${file}: 未发现控制器 class`);
  const name = tokens[classIndex + 1].value;
  let body = classIndex + 2;
  while (body < tokens.length && tokens[body].value !== '{') body++;
  const end = matching(tokens, body, file);
  const methods = [];
  for (let i = body + 1; i < end; i++) {
    if (tokens[i].value !== 'function' || tokens[i].kind !== 'word') {
      if (tokens[i].value === '{' && tokens[i].kind === 'symbol') i = matching(tokens, i, file);
      continue;
    }
    const methodName = tokens[i + 1];
    if (methodName?.kind !== 'word' || tokens[i + 2]?.value !== '(') throw new Error(`${file}:${tokens[i].line}: 未识别的控制器方法声明`);
    let methodBody = matching(tokens, i + 2, file) + 1;
    while (methodBody < end && !['{', ';'].includes(tokens[methodBody].value)) methodBody++;
    const methodEnd = tokens[methodBody].value === '{' ? matching(tokens, methodBody, file) : methodBody;
    const modifiers = [];
    for (let previous = i - 1; previous > body && ['public', 'private', 'protected', 'static', 'final', 'abstract'].includes(tokens[previous].value); previous--) modifiers.push(tokens[previous].value);
    if (!modifiers.includes('private') && !modifiers.includes('protected')) {
      const scanned = scanOperations(tokens.slice(methodBody + 1, methodEnd), file);
      methods.push({ name: methodName.value, line: tokens[i].line, endLine: tokens[methodEnd].line, static: modifiers.includes('static'), ...scanned });
    }
    i = methodEnd;
  }
  return { file, name, publicMethods: methods };
}

export function scanRegistry(source, variable, file) {
  const tokens = tokenize(source, file);
  const start = tokens.findIndex((token, i) => token.value === `$${variable}` && tokens[i + 1]?.value === '=' && tokens[i + 2]?.value === '[');
  if (start === -1) throw new Error(`${file}: 未发现静态 registry ${variable}`);
  const open = start + 2;
  const end = matching(tokens, open, file);
  const entries = argumentsOf(tokens, open + 1, end, file).map((entry) => {
    if (entry[1]?.value !== '=>' || entry[2]?.value !== '[' || entry.at(-1)?.value !== ']') throw new Error(`${file}:${entry[0]?.line}: 未识别的 provider registry 条目`);
    const id = literal(entry.slice(0, 1), file, 'provider id');
    const fields = argumentsOf(entry, 3, entry.length - 1, file);
    const name = fields.find((field) => field[0]?.value === 'name');
    if (!name || name[1]?.value !== '=>') throw new Error(`${file}:${entry[0].line}: provider 缺少 name`);
    return { id, name: literal(name.slice(2), file, 'provider name'), line: entry[0].line };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error(`${file}: 重复的 provider 注册标识`);
  return entries;
}
