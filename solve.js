// makefun-site compatible static site builder (clean-room implementation from the
// vendor README spec). run(input) returns the output tree: path -> file text.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function escapeHtml(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  ESC_RE.lastIndex = 0;
  return s.replace(ESC_RE, (c) => ESCAPE_MAP[c]);
}

// Trim spaces and tabs at both ends (faster than regexes on short lines).
function trimST(s) {
  let a = 0;
  let b = s.length;
  while (a < b && (s.charCodeAt(a) === 32 || s.charCodeAt(a) === 9)) a++;
  while (b > a && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === s.length ? s : s.slice(a, b);
}
function rstripST(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return b === s.length ? s : s.slice(0, b);
}

const MARK_RE = /\p{M}/gu;
const slugCache = new Map();
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let s = text.normalize('NFKD').replace(MARK_RE, '');
  s = s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  s = s.replace(/[^a-z0-9]+/g, '-');
  s = s.replace(/^-+/, '').replace(/-+$/, '');
  if (s.length > 64) {
    s = s.slice(0, 64);
    if (s.endsWith('-')) s = s.slice(0, -1);
  }
  const out = s === '' ? 'untitled' : s;
  slugCache.set(text, out);
  return out;
}

function dateLong(dateStr) {
  const y = +dateStr.slice(0, 4);
  const m = +dateStr.slice(5, 7);
  const d = +dateStr.slice(8, 10);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

const WORD_RE = /\S+/g;

// ---------------------------------------------------------------- front matter

const KNOWN_KEYS = { title: 1, summary: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1 };

function parseQuoted(v) {
  // v starts with '"'. Returns the string or null when not closed / malformed.
  let out = '';
  let i = 1;
  while (i < v.length) {
    const ch = v[i];
    if (ch === '\\' && (v[i + 1] === '"' || v[i + 1] === '\\')) {
      out += v[i + 1];
      i += 2;
    } else if (ch === '"') {
      if (i !== v.length - 1) return null;
      return out;
    } else {
      out += ch;
      i++;
    }
  }
  return null;
}

function parseStringValue(v) {
  // Returns {value} or {error}.
  if (v[0] === '"') {
    const r = parseQuoted(v);
    if (r === null) return { error: 'a quoted string is not closed' };
    return { value: r };
  }
  if (v[0] === '[') return { error: 'a bare string opens on [' };
  return { value: v };
}

function isRealDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = +v.slice(0, 4);
  const m = +v.slice(5, 7);
  const d = +v.slice(8, 10);
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return false;
  return v >= '1970-01-01' && v <= '2099-12-31';
}

function parseTagsValue(v) {
  if (!v.startsWith('[') || !v.endsWith(']')) return { error: 'not a list [a, b]' };
  const inner = v.slice(1, -1);
  if (inner === '') return { value: [] };
  const parts = inner.split(',');
  const tags = [];
  for (let p of parts) {
    p = p.trim();
    if (p === '' || p.indexOf('"') !== -1 || p.indexOf('[') !== -1 || p.indexOf(']') !== -1) {
      return { error: 'an empty tag, or one holding " [ or ]' };
    }
    tags.push(p);
  }
  return { value: tags };
}

function parseFrontMatter(content) {
  // Returns {fm} or {error}.
  const lines = content.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const fm = { title: undefined, summary: undefined, date: undefined, tags: undefined, draft: undefined, layout: undefined, slug: undefined };
  const seen = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const n = i + 1;
    if (/^[ \t]*$/.test(line)) continue;
    if (line[0] === '#') continue;
    const m = line.match(/^([a-z_]+):( (.*))?$/);
    if (!m) return { error: 'line ' + n + ' is not "key: value"' };
    const key = m[1];
    let value = m[3] === undefined ? '' : rstripST(m[3]);
    if (!KNOWN_KEYS[key]) return { error: 'unknown key "' + key + '"' };
    if (seen[key]) return { error: 'key "' + key + '" is given twice' };
    seen[key] = true;
    if (value === '') return { error: 'key "' + key + '" has no value' };
    if (key === 'title' || key === 'summary') {
      const r = parseStringValue(value);
      if (r.error) return { error: 'key "' + key + '": ' + r.error };
      fm[key] = r.value;
    } else if (key === 'date') {
      if (!isRealDate(value)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      fm.date = value;
    } else if (key === 'tags') {
      const r = parseTagsValue(value);
      if (r.error) return { error: 'key "tags": ' + r.error };
      fm.tags = r.value;
    } else if (key === 'draft') {
      if (value !== 'true' && value !== 'false') return { error: 'key "draft": true or false' };
      fm.draft = value === 'true';
    } else if (key === 'layout') {
      if (!/^[a-z0-9-]+$/.test(value)) return { error: 'key "layout": not a template name' };
      fm.layout = value;
    } else if (key === 'slug') {
      if (value.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value)) return { error: 'key "slug": not a slug' };
      fm.slug = value;
    }
  }
  if (fm.title === undefined || fm.title === '') return { error: 'no title' };
  return { fm, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- templates

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function parseTag(content) {
  // content is the inside of {% %} trimmed. Returns a node descriptor or {error}.
  const c = content.trim();
  if (c === 'endfor') return { kind: 'endfor' };
  if (c === 'endif') return { kind: 'endif' };
  if (c === 'else') return { kind: 'else' };
  let m = c.match(/^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(\S+)$/);
  if (m) {
    if (!PATH_RE.test(m[2])) return { error: 'not a path' };
    return { kind: 'for', var: m[1], path: m[2].split('.') };
  }
  if (c.startsWith('for ')) return { error: 'not a tag' };
  m = c.match(/^if\s+(not\s+)?(\S+)$/);
  if (m) {
    if (!PATH_RE.test(m[2])) return { error: 'not a path' };
    return { kind: 'if', neg: !!m[1], path: m[2].split('.') };
  }
  if (c.startsWith('if ')) return { error: 'not a tag' };
  m = c.match(/^include\s+"([^"]*)"$/);
  if (m) return { kind: 'include', name: m[1] };
  if (c.startsWith('include')) return { error: 'not a tag' };
  return { error: 'not a tag' };
}

function parseTemplate(src) {
  // Returns {nodes} or {error}.
  const tokens = [];
  const n = src.length;
  let i = 0;
  let textBuf = '';
  function flushText() {
    if (textBuf !== '') {
      tokens.push({ t: 'text', s: textBuf });
      textBuf = '';
    }
  }
  while (i < n) {
    if (src.startsWith('{{{', i)) {
      const end = src.indexOf('}}}', i + 3);
      if (end === -1) return { error: '{{{ is not closed' };
      const inner = src.slice(i + 3, end).trim();
      if (!PATH_RE.test(inner)) return { error: 'not a path' };
      flushText();
      tokens.push({ t: 'var', path: inner.split('.'), raw: true });
      i = end + 3;
    } else if (src.startsWith('{{', i)) {
      const end = src.indexOf('}}', i + 2);
      if (end === -1) return { error: '{{ is not closed' };
      const inner = src.slice(i + 2, end).trim();
      if (!PATH_RE.test(inner)) return { error: 'not a path' };
      flushText();
      tokens.push({ t: 'var', path: inner.split('.'), raw: false });
      i = end + 2;
    } else if (src.startsWith('{%', i)) {
      const end = src.indexOf('%}', i + 2);
      if (end === -1) return { error: '{% is not closed' };
      const inner = src.slice(i + 2, end);
      // Alone on its line? Only spaces/tabs before it on this line and after it up to \n.
      let alone = true;
      let k = i - 1;
      while (k >= 0 && src[k] !== '\n') {
        if (src[k] !== ' ' && src[k] !== '\t') { alone = false; break; }
        k--;
      }
      let after = end + 2;
      if (alone) {
        while (after < n && src[after] !== '\n') {
          if (src[after] !== ' ' && src[after] !== '\t') { alone = false; break; }
          after++;
        }
      }
      if (alone) {
        // Drop the spaces/tabs before the tag on this line from the text buffer.
        textBuf = textBuf.replace(/[ \t]+$/, '');
        flushText();
        tokens.push({ t: 'tag', content: inner });
        i = after < n && src[after] === '\n' ? after + 1 : after;
      } else {
        flushText();
        tokens.push({ t: 'tag', content: inner });
        i = end + 2;
      }
    } else {
      textBuf += src[i];
      i++;
    }
  }
  flushText();

  // Build the tree.
  const root = { t: 'root', children: [] };
  const stack = [{ node: root, list: root.children, kind: 'root' }];
  let cur = root.children;
  for (const tok of tokens) {
    if (tok.t === 'text' || tok.t === 'var') {
      cur.push(tok);
    } else {
      const tag = parseTag(tok.content);
      if (tag.error) return { error: tag.error };
      if (tag.kind === 'for' || tag.kind === 'if') {
        const node = { t: tag.kind, children: [], elseChildren: null, var: tag.var, path: tag.path, neg: tag.neg };
        cur.push(node);
        stack.push({ node, list: node.children, kind: tag.kind });
        cur = node.children;
      } else if (tag.kind === 'else') {
        const top = stack[stack.length - 1];
        if (top.kind !== 'if' || top.node.elseChildren !== null) return { error: '{% else %} without {% if %}' };
        top.node.elseChildren = [];
        top.list = top.node.elseChildren;
        cur = top.node.elseChildren;
      } else if (tag.kind === 'endfor') {
        const top = stack[stack.length - 1];
        if (top.kind !== 'for') return { error: '{% endfor %} without {% for %}' };
        stack.pop();
        cur = stack[stack.length - 1].list;
      } else if (tag.kind === 'endif') {
        const top = stack[stack.length - 1];
        if (top.kind !== 'if') return { error: '{% endif %} without {% if %}' };
        stack.pop();
        cur = stack[stack.length - 1].list;
      } else if (tag.kind === 'include') {
        cur.push({ t: 'include', name: tag.name });
      }
    }
  }
  if (stack.length !== 1) {
    const top = stack[stack.length - 1];
    return { error: top.kind === 'for' ? '{% for %} is not closed' : '{% if %} is not closed' };
  }
  return { nodes: root.children };
}

function writeValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += writeValue(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

function resolvePath(segs, top, frames) {
  const first = segs[0];
  let cur;
  let found = false;
  for (let i = frames.length - 1; i >= 0; i--) {
    const fr = frames[i];
    if (first === 'loop') { cur = fr.loop; found = true; break; }
    if (fr.var === first) { cur = fr.val; found = true; break; }
  }
  if (!found) {
    if (!Object.prototype.hasOwnProperty.call(top, first)) return undefined;
    cur = top[first];
  }
  for (let i = 1; i < segs.length; i++) {
    if (cur === null || cur === undefined) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, segs[i])) return undefined;
    cur = cur[segs[i]];
  }
  return cur;
}

// Static dependency analysis for template memoization: the set of first path
// segments a template can read, with loop variables resolved to the root of
// the array they iterate and `loop` resolved to its enclosing for's source
// root. Returns null when a template cannot be analysed safely (an include
// cycle, or `loop` used with no enclosing for): such a template is never
// memoized. Includes share the caller's scope, so the bound map is passed
// down through them.
function templateRoots(nodes, parsed, visiting, bound, loopRoot) {
  const roots = new Set();
  for (const nd of nodes) {
    if (nd.t === 'var') {
      const r = resolveRoot(nd.path[0], bound, loopRoot);
      if (r === null) return null;
      roots.add(r);
    } else if (nd.t === 'if') {
      const r = resolveRoot(nd.path[0], bound, loopRoot);
      if (r === null) return null;
      roots.add(r);
      const sub = templateRoots(nd.children, parsed, visiting, bound, loopRoot);
      if (sub === null) return null;
      for (const x of sub) roots.add(x);
      if (nd.elseChildren) {
        const sub2 = templateRoots(nd.elseChildren, parsed, visiting, bound, loopRoot);
        if (sub2 === null) return null;
        for (const x of sub2) roots.add(x);
      }
    } else if (nd.t === 'for') {
      const r = resolveRoot(nd.path[0], bound, loopRoot);
      if (r === null) return null;
      roots.add(r);
      const bound2 = new Map(bound);
      bound2.set(nd.var, r);
      const sub = templateRoots(nd.children, parsed, visiting, bound2, r);
      if (sub === null) return null;
      for (const x of sub) roots.add(x);
    } else if (nd.t === 'include') {
      const tpl = parsed[nd.name];
      if (!tpl) continue;
      if (visiting.has(nd.name)) return null;
      visiting.add(nd.name);
      const sub = templateRoots(tpl, parsed, visiting, bound, loopRoot);
      visiting.delete(nd.name);
      if (sub === null) return null;
      for (const x of sub) roots.add(x);
    }
  }
  return roots;
}

function resolveRoot(first, bound, loopRoot) {
  if (first === 'loop') return loopRoot; // null when no enclosing for
  const b = bound.get(first);
  return b === undefined ? first : b;
}

// Memo key for an include: the template's roots must all be either the
// case-constant top values (site, tags, recent) or loop variables bound in
// the current frames. Returns null when the include cannot be memoized.
function memoKeyFor(roots, frames) {
  const vals = [];
  for (const r of roots) {
    if (r === 'site' || r === 'tags' || r === 'recent') continue;
    let found = false;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].var === r) {
        const v = frames[i].val;
        if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return null;
        vals.push(v);
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return vals.length === 0 ? { const: true, vals: null } : { const: false, vals };
}

function memoLookup(memoMap, name, depth, vals) {
  const byName = memoMap.get(name);
  if (!byName) return undefined;
  let node = byName.get(depth);
  if (!node) return undefined;
  for (const v of vals) {
    node = node.get(v);
    if (!node) return undefined;
  }
  return node.s;
}

function memoStore(memoMap, name, depth, vals, s) {
  let byName = memoMap.get(name);
  if (!byName) { byName = new Map(); memoMap.set(name, byName); }
  let node = byName.get(depth);
  if (!node) { node = new Map(); byName.set(depth, node); }
  for (const v of vals) {
    let next = node.get(v);
    if (!next) { next = new Map(); node.set(v, next); }
    node = next;
  }
  node.s = s;
}

function renderNodes(nodes, top, frames, templates, depth, memo) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text') {
      out += nd.s;
    } else if (nd.t === 'var') {
      const v = resolvePath(nd.path, top, frames);
      const w = writeValue(v);
      out += nd.raw ? w : escapeHtml(w);
    } else if (nd.t === 'for') {
      const arr = resolvePath(nd.path, top, frames);
      if (Array.isArray(arr)) {
        for (let k = 0; k < arr.length; k++) {
          frames.push({ var: nd.var, val: arr[k], loop: { index: k + 1, first: k === 0, last: k === arr.length - 1, length: arr.length } });
          out += renderNodes(nd.children, top, frames, templates, depth, memo);
          frames.pop();
        }
      }
    } else if (nd.t === 'if') {
      const v = resolvePath(nd.path, top, frames);
      const cond = nd.neg ? !truthy(v) : truthy(v);
      out += renderNodes(cond ? nd.children : (nd.elseChildren || []), top, frames, templates, depth, memo);
    } else if (nd.t === 'include') {
      const tpl = templates[nd.name];
      if (tpl && depth < 8) {
        let rendered;
        if (memo) {
          const roots = memo.roots[nd.name];
          const mk = roots ? memoKeyFor(roots, frames) : null;
          if (mk && mk.const) {
            const key = nd.name + '\n' + depth;
            const hit = memo.constMemo.get(key);
            if (hit !== undefined) {
              out += hit;
            } else {
              rendered = renderNodes(tpl, top, frames, templates, depth + 1, memo);
              memo.constMemo.set(key, rendered);
              out += rendered;
            }
          } else if (mk) {
            const hit = memoLookup(memo.frameMemo, nd.name, depth, mk.vals);
            if (hit !== undefined) {
              out += hit;
            } else {
              rendered = renderNodes(tpl, top, frames, templates, depth + 1, memo);
              memoStore(memo.frameMemo, nd.name, depth, mk.vals, rendered);
              out += rendered;
            }
          } else {
            out += renderNodes(tpl, top, frames, templates, depth + 1, memo);
          }
        } else {
          out += renderNodes(tpl, top, frames, templates, depth + 1, memo);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function resolveLink(target, srcDir, urlBySource, staticSet, base, srcPath, brokenSet, report) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target[0] === '/' || target[0] === '#') return target;
  const hashIdx = target.indexOf('#');
  const pathPart = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
  const frag = hashIdx >= 0 ? target.slice(hashIdx) : '';
  const parts = srcDir === '' ? [] : srcDir.split('/');
  for (const seg of pathPart.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = parts.join('/');
  if (urlBySource.has(resolved)) return urlBySource.get(resolved) + frag;
  if (staticSet.has(resolved)) return base + '/' + resolved + frag;
  const key = srcPath + '\n' + target;
  if (!brokenSet.has(key)) {
    brokenSet.add(key);
    report.push('broken-link ' + srcPath + ' -> ' + target);
  }
  return target;
}

const SPECIAL_RE = /[\\`*\[]/g;

function inlineParse(s, ctx) {
  let out = '';
  let i = 0;
  const n = s.length;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += escapeHtml(s.slice(i, j));
    const ch = s[j];
    if (ch === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      out += escapeHtml(s[j + 1]);
      i = j + 2;
    } else if (ch === '`') {
      let k = j + 1;
      let found = -1;
      while (k < n) {
        if (s[k] === '\\' && k + 1 < n && ESCAPABLE.has(s[k + 1])) { k += 2; continue; }
        if (s[k] === '`') { found = k; break; }
        k++;
      }
      if (found > j + 1) {
        out += '<code>' + escapeHtml(s.slice(j + 1, found)) + '</code>';
        i = found + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (ch === '*' && s[j + 1] === '*') {
      let k = j + 2;
      let found = -1;
      while (k + 1 < n) {
        if (s[k] === '\\' && k + 1 < n && ESCAPABLE.has(s[k + 1])) { k += 2; continue; }
        if (s[k] === '*' && s[k + 1] === '*') { found = k; break; }
        k++;
      }
      if (found > j + 2) {
        out += '<strong>' + inlineParse(s.slice(j + 2, found), ctx) + '</strong>';
        i = found + 2;
      } else {
        out += '**';
        i = j + 2;
      }
    } else if (ch === '*') {
      // Emphasis: the closer is the next lone '*' (a '**' pair is skipped as a
      // unit, as are escaped characters); with no closer the '*' is itself.
      let k = j + 1;
      let found = -1;
      while (k < n) {
        if (s[k] === '\\' && k + 1 < n && ESCAPABLE.has(s[k + 1])) { k += 2; continue; }
        if (s[k] === '*' && s[k + 1] === '*') { k += 2; continue; }
        if (s[k] === '*') { found = k; break; }
        k++;
      }
      if (found > j + 1) {
        out += '<em>' + inlineParse(s.slice(j + 1, found), ctx) + '</em>';
        i = found + 1;
      } else {
        out += '*';
        i = j + 1;
      }
    } else if (ch === '[') {
      let k = j + 1;
      let close = -1;
      while (k < n) {
        if (s[k] === '\\' && k + 1 < n && ESCAPABLE.has(s[k + 1])) { k += 2; continue; }
        if (s[k] === ']') { close = k; break; }
        k++;
      }
      let done = false;
      if (close >= j + 1 && s[close + 1] === '(') {
        let e = close + 2;
        let end = -1;
        while (e < n) {
          if (s[e] === ')') { end = e; break; }
          e++;
        }
        if (end > close + 2) {
          const target = s.slice(close + 2, end);
          if (!/\s/.test(target)) {
            const href = resolveLink(target, ctx.srcDir, ctx.urlBySource, ctx.staticSet, ctx.base, ctx.srcPath, ctx.brokenSet, ctx.report);
            out += '<a href="' + escapeHtml(href) + '">' + inlineParse(s.slice(j + 1, close), ctx) + '</a>';
            i = end + 1;
            done = true;
          }
        }
      }
      if (!done) {
        out += '[';
        i = j + 1;
      }
    } else {
      // A backslash before a character that is not escapable: itself.
      out += '\\';
      i = j + 1;
    }
    SPECIAL_RE.lastIndex = i;
  }
  if (i < n) out += escapeHtml(s.slice(i));
  return out;
}

function isBlank(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  return /^[ \t]+$/.test(line);
}

// Block-start dispatch by first character: most lines are plain text, so the
// paragraph path must not pay for fence/heading/break/list regexes.
function blockKind(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return 1; // ` fence?
  if (c === 35) return 2; // # heading?
  if (c === 45 || c === 42) return 3; // - or * break or list?
  if (c === 62) return 4; // > blockquote
  if (c >= 48 && c <= 57) return 5; // digit: ordered list?
  return 0; // paragraph
}

function fenceOpen(line) {
  const m = line.match(/^```([A-Za-z0-9_+\-]*)/);
  if (!m) return null;
  const rest = line.slice(3 + m[1].length);
  if (/^[ \t]*$/.test(rest)) return m[1];
  return null;
}

function fenceClose(line) {
  return /^```[ \t]*$/.test(line);
}

function headingInfo(line) {
  const m = line.match(/^(#{1,6})[ \t]+(.*)$/);
  if (!m) return null;
  const text = m[2].replace(/[ \t]+$/, '');
  if (text === '') return null;
  return { level: m[1].length, text };
}

function isBreak(line) {
  return /^---[ \t]*$/.test(line) || /^\*\*\*[ \t]*$/.test(line);
}

function listItem(line) {
  if (line[0] === '-' && line[1] === ' ') return { kind: 'ul', text: line.slice(2), num: 0 };
  if (line[0] === '*' && line[1] === ' ') return { kind: 'ul', text: line.slice(2), num: 0 };
  const m = line.match(/^(\d+)\. (.*)$/);
  if (m) return { kind: 'ol', text: m[2], num: parseInt(m[1], 10) };
  return null;
}

function renderMarkdown(body, ctx) {
  const lines = body.split('\n');
  const blocks = [];
  const toc = [];
  const headingIds = new Set();
  let firstPara = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '' || isBlank(line)) { i++; continue; }
    const kind = blockKind(line);
    if (kind === 1) {
      const lang = fenceOpen(line);
      if (lang !== null) {
        let j = i + 1;
        const bodyLines = [];
        while (j < n && !fenceClose(lines[j])) {
          bodyLines.push(lines[j]);
          j++;
        }
        let inner = '';
        for (const bl of bodyLines) inner += escapeHtml(bl) + '\n';
        blocks.push('<pre><code' + (lang !== '' ? ' class="language-' + lang + '"' : '') + '>' + inner + '</code></pre>');
        i = j + 1;
        continue;
      }
    } else if (kind === 2) {
      const h = headingInfo(line);
      if (h) {
        let idBase = slugify(h.text);
        let id = idBase;
        let k = 2;
        while (headingIds.has(id)) {
          id = idBase + '-' + k;
          k++;
        }
        headingIds.add(id);
        const html = inlineParse(h.text, ctx);
        blocks.push('<h' + h.level + ' id="' + id + '">' + html + '</h' + h.level + '>');
        if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html });
        i++;
        continue;
      }
    } else if (kind === 3) {
      if (isBreak(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
      const item0 = listItem(line);
      if (item0) {
        const kind2 = item0.kind;
        const firstNum = item0.num;
        const items = [item0.text];
        i++;
        while (i < n) {
          const l = lines[i];
          const it = listItem(l);
          if (it && it.kind === kind2) {
            items.push(it.text);
            i++;
          } else if (/^ {2,}\S/.test(l)) {
            items[items.length - 1] += '\n' + trimST(l);
            i++;
          } else {
            break;
          }
        }
        let html = kind2 === 'ul' ? '<ul>\n' : (firstNum !== 1 ? '<ol start="' + firstNum + '">\n' : '<ol>\n');
        for (const it of items) html += '<li>' + inlineParse(it, ctx) + '</li>\n';
        html += kind2 === 'ul' ? '</ul>' : '</ol>';
        blocks.push(html);
        continue;
      }
    } else if (kind === 4) {
      const qlines = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        l = trimST(l);
        if (l !== '') qlines.push(l);
        i++;
      }
      if (qlines.length > 0) blocks.push('<blockquote>\n<p>' + inlineParse(qlines.join('\n'), ctx) + '</p>\n</blockquote>');
      else blocks.push('<blockquote>\n</blockquote>');
      continue;
    } else if (kind === 5) {
      const item0 = listItem(line);
      if (item0) {
        const firstNum = item0.num;
        const items = [item0.text];
        i++;
        while (i < n) {
          const l = lines[i];
          const it = listItem(l);
          if (it && it.kind === 'ol') {
            items.push(it.text);
            i++;
          } else if (/^ {2,}\S/.test(l)) {
            items[items.length - 1] += '\n' + trimST(l);
            i++;
          } else {
            break;
          }
        }
        let html = firstNum !== 1 ? '<ol start="' + firstNum + '">\n' : '<ol>\n';
        for (const it of items) html += '<li>' + inlineParse(it, ctx) + '</li>\n';
        html += '</ol>';
        blocks.push(html);
        continue;
      }
    }
    // paragraph
    const plines = [trimST(line)];
    i++;
    while (i < n) {
      const l = lines[i];
      if (l === '' || isBlank(l)) break;
      const k2 = blockKind(l);
      if (k2 === 1 && fenceOpen(l) !== null) break;
      if (k2 === 2 && headingInfo(l)) break;
      if (k2 === 3 && isBreak(l)) break;
      plines.push(trimST(l));
      i++;
    }
    const inner = inlineParse(plines.join('\n'), ctx);
    if (firstPara === null) firstPara = inner;
    blocks.push('<p>' + inner + '</p>');
  }
  return { html: blocks.map((b) => b + '\n').join(''), excerpt: firstPara === null ? '' : firstPara, toc };
}

// ---------------------------------------------------------------- build

export function run(input) {
  const site = input.site;
  const templates = input.templates;
  const files = input.files;
  const base = site.base_url.replace(/\/+$/, '');
  const report = [];
  const brokenSet = new Set();

  // 1. Sort files by path in code-unit order.
  const sorted = files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 2. Parse templates in code-unit order of name.
  const parsed = {};
  for (const name of Object.keys(templates).sort()) {
    const r = parseTemplate(templates[name]);
    if (r.error) report.push('template "' + name + '": ' + r.error);
    else parsed[name] = r.nodes;
  }

  // Static dependency roots per template, for include memoization.
  const tplRoots = {};
  for (const name of Object.keys(parsed)) {
    tplRoots[name] = templateRoots(parsed[name], parsed, new Set([name]), new Map(), null);
  }
  const memo = { roots: tplRoots, constMemo: new Map(), frameMemo: new Map() };

  // 3. Sources.
  const pages = [];
  const statics = [];
  for (const f of sorted) {
    if (!f.path.endsWith('.md')) {
      statics.push(f);
      continue;
    }
    const content = f.content.replace(/\r\n?/g, '\n');
    const pr = parseFrontMatter(content);
    if (pr.error) {
      report.push('refused ' + f.path + ': ' + pr.error);
      continue;
    }
    const fm = pr.fm;
    const firstSeg = f.path.split('/')[0];
    if (firstSeg === 'tags' || firstSeg === 'page') {
      report.push('refused ' + f.path + ': ' + firstSeg + '/ is the generator\'s own');
      continue;
    }
    const isPost = f.path.startsWith('posts/');
    if (isPost && fm.date === undefined) {
      report.push('refused ' + f.path + ': a post needs a date');
      continue;
    }
    const layout = fm.layout !== undefined ? fm.layout : (isPost ? 'post' : 'page');
    if (!(layout in parsed)) {
      report.push('refused ' + f.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    if (fm.draft === true) {
      report.push('draft ' + f.path);
      continue;
    }
    const dir = isPost ? 'posts' : (f.path.indexOf('/') === -1 ? '' : f.path.slice(0, f.path.lastIndexOf('/')));
    // Dedupe tags by slug, first spelling kept.
    const tags = [];
    const tagSlugs = new Set();
    if (fm.tags) {
      for (const t of fm.tags) {
        const s = slugify(t);
        if (!tagSlugs.has(s)) {
          tagSlugs.add(s);
          tags.push({ name: t, slug: s });
        }
      }
    }
    pages.push({
      srcPath: f.path,
      dir,
      isPost,
      title: fm.title,
      summary: fm.summary !== undefined ? fm.summary : '',
      date: fm.date !== undefined ? fm.date : '',
      tags,
      layout,
      body: pr.body,
      slugKey: fm.slug,
    });
  }

  // 4. Permalinks, in source order.
  const taken = new Map();
  taken.set('', new Set(['posts', 'tags', 'page']));
  for (const p of pages) {
    const baseSlug = p.slugKey !== undefined ? p.slugKey : slugify(p.title);
    let set = taken.get(p.dir);
    if (!set) {
      set = new Set();
      taken.set(p.dir, set);
    }
    let s = baseSlug;
    let k = 2;
    while (set.has(s)) {
      s = baseSlug + '-' + k;
      k++;
    }
    set.add(s);
    p.slug = s;
    p.url = base + '/' + (p.dir === '' ? '' : p.dir + '/') + s + '/';
    p.outPath = (p.dir === '' ? '' : p.dir + '/') + s + '/index.html';
  }

  // 5. Markdown.
  const urlBySource = new Map();
  for (const p of pages) urlBySource.set(p.srcPath, p.url);
  const staticSet = new Set(statics.map((f) => f.path));
  for (const p of pages) {
    const ctx = { srcDir: p.srcPath.indexOf('/') === -1 ? '' : p.srcPath.slice(0, p.srcPath.lastIndexOf('/')), urlBySource, staticSet, base, srcPath: p.srcPath, brokenSet, report };
    const r = renderMarkdown(p.body, ctx);
    p.content = r.html;
    p.excerpt = r.excerpt;
    p.toc = r.toc;
    let wordCount = 0;
    WORD_RE.lastIndex = 0;
    while (WORD_RE.exec(p.body) !== null) wordCount++;
    p.readingMinutes = Math.max(1, Math.ceil(wordCount / 200));
  }

  // 6. Collections.
  const posts = pages.filter((p) => p.isPost).sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  for (let i = 0; i < posts.length; i++) {
    posts[i].newer = i > 0 ? posts[i - 1] : null;
    posts[i].older = i < posts.length - 1 ? posts[i + 1] : null;
  }

  // 7. Tags.
  const tagMap = new Map();
  for (const p of posts) {
    for (const t of p.tags) {
      let tag = tagMap.get(t.slug);
      if (!tag) {
        tag = { name: t.name, slug: t.slug, url: base + '/tags/' + t.slug + '/', count: 0, posts: [] };
        tagMap.set(t.slug, tag);
      }
      tag.count++;
      tag.posts.push(p);
    }
  }
  const tags = [...tagMap.values()].sort((a, b) => (b.count - a.count) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const globalTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const tagBySlug = new Map(tags.map((t) => [t.slug, t]));

  const siteObj = { title: site.title, base_url: base };
  const recentN = typeof site.recent === 'number' ? site.recent : posts.length;
  const recentCards = posts.slice(0, recentN).map(cardOf);

  function cardOf(p) {
    if (p.card) return p.card;
    const card = {
      title: p.title,
      url: p.url,
      date: p.date,
      date_long: p.date === '' ? '' : dateLong(p.date),
      summary: p.summary,
      excerpt: p.excerpt,
      reading_minutes: p.readingMinutes,
      tags: p.tags.map((t) => {
        const g = tagBySlug.get(t.slug);
        return { name: g ? g.name : t.name, slug: t.slug, url: g ? g.url : '' };
      }),
    };
    p.card = card;
    return card;
  }

  function pageObjOf(p) {
    const card = cardOf(p);
    const obj = Object.assign({}, card, {
      slug: p.slug,
      content: p.content,
      toc: p.toc,
      newer: null,
      older: null,
      is_post: p.isPost,
    });
    if (p.isPost) {
      obj.newer = p.newer ? { title: p.newer.title, url: p.newer.url, date: p.newer.date, date_long: dateLong(p.newer.date) } : null;
      obj.older = p.older ? { title: p.older.title, url: p.older.url, date: p.older.date, date_long: dateLong(p.older.date) } : null;
    }
    return obj;
  }

  // 8. Layouts.
  const out = {};
  for (const p of pages) {
    const top = { site: siteObj, tags: globalTags, recent: recentCards, page: pageObjOf(p) };
    out[p.outPath] = renderNodes(parsed[p.layout], top, [], parsed, 0, memo); // memo carries the include caches
  }
  const perPage = site.per_page;
  const totalPages = Math.max(1, Math.ceil(posts.length / perPage));
  if (parsed['index']) {
    for (let n = 1; n <= totalPages; n++) {
      const slice = posts.slice((n - 1) * perPage, n * perPage);
      const pager = {
        number: n,
        total: totalPages,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n === 1 ? '' : (n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/'),
        older_url: n === totalPages ? '' : base + '/page/' + (n + 1) + '/',
      };
      const top = { site: siteObj, tags: globalTags, recent: recentCards, posts: slice.map(cardOf), pager };
      out[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = renderNodes(parsed['index'], top, [], parsed, 0, memo); // memo carries the include caches
    }
  }
  if (parsed['tag']) {
    for (const tag of tags) {
      const top = { site: siteObj, tags: globalTags, recent: recentCards, tag: { name: tag.name, slug: tag.slug, url: tag.url, count: tag.count, posts: tag.posts.map(cardOf) } };
      out['tags/' + tag.slug + '/index.html'] = renderNodes(parsed['tag'], top, [], parsed, 0, memo); // memo carries the include caches
    }
  }
  if (parsed['tags']) {
    const top = { site: siteObj, tags: globalTags, recent: recentCards };
    out['tags/index.html'] = renderNodes(parsed['tags'], top, [], parsed, 0, memo); // memo carries the include caches
  }

  let staticWritten = 0;
  for (const f of statics) {
    if (f.path in out) {
      report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      out[f.path] = f.content;
      staticWritten++;
    }
  }

  // 9. Report.
  const lines = report.slice().sort();
  const pageCount = pages.length - posts.length;
  out['build-report.txt'] = lines.join('\n') + (lines.length > 0 ? '\n' : '') + 'built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + staticWritten + ' static files\n';

  return out;
}
