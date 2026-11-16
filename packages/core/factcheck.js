// Résumé fact-checker: finds numbers, tools and names in a tailored résumé,
// cover letter or live answer that the user's master résumé and Interview
// Brain facts never mention, plus left-over placeholders and (for résumés)
// contact details that went missing. Also classifies tailored bullets against
// the master (unchanged / reworded / merged / no_source).
//
// A port of the Autonomous Job Kit's lib/jobkit/bullets.py (MIT, same author)
// with the same regexes and thresholds. The Python functions take file paths;
// these take TEXT (the app extracts text from PDF/DOCX first). LaTeX source is
// detected and read the way the kit reads a .tex file.
//
// Differences from the Python, all deliberate:
// - Markdown in the candidate (bullets, **bold**, headings, `code`, links) is
//   stripped before checking unless { markdown: false }. The Python reads a
//   "- Partnered with..." line as mid-sentence and flags "Partnered"; numbered
//   list markers ("1.") would be flagged as new numbers.
// - \d means ASCII 0-9 (Python also accepts other scripts' digits).
// - Results use camelCase keys and carry no file paths or exit code.
//
// Pure; loads as CommonJS or as a browser global (CoreFactCheck).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreFactCheck = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- Python regex compatibility ----------
  // Python 3 str patterns are Unicode-aware: \w, \s and \b cover non-ASCII
  // letters and whitespace. py() rewrites those escapes for JS (u flag).
  const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const PY_W = '\\p{L}\\p{N}_';
  const PY_D = '0-9';
  const WORDC = '[' + PY_W + ']';
  const PY_B = '(?:(?<=' + WORDC + ')(?!' + WORDC + ')|(?<!' + WORDC + ')(?=' + WORDC + '))';

  function py(src, flags) {
    flags = flags || '';
    let out = '';
    let inClass = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') {
        const n = src[++i];
        const cls = n === 'w' || n === 'W' ? PY_W : n === 's' || n === 'S' ? PY_WS : n === 'd' || n === 'D' ? PY_D : null;
        if (cls) {
          const neg = n === n.toUpperCase();
          if (inClass) {
            if (neg) throw new Error('negated escape inside a class: ' + src);
            out += cls;
          } else out += (neg ? '[^' : '[') + cls + ']';
        } else if (n === 'b' && !inClass) out += PY_B;
        else out += '\\' + n;
        continue;
      }
      if (c === '[' && !inClass) {
        inClass = true;
        out += c;
        if (src[i + 1] === '^') { out += '^'; i++; }
        continue;
      }
      if (c === ']' && inClass) inClass = false;
      out += c;
    }
    return new RegExp(out, flags.includes('u') ? flags : flags + 'u');
  }

  const RE_WS = py('\\s+', 'g');
  const RE_WORDCHAR = new RegExp(WORDC, 'gu');
  const RE_LSTRIP = py('^\\s+');
  const RE_RSTRIP = py('\\s+$');

  const pyStrip = (s) => String(s).replace(RE_LSTRIP, '').replace(RE_RSTRIP, '');
  const pyRstrip = (s) => String(s).replace(RE_RSTRIP, '');
  const stripChars = (s, chars) => {
    let a = 0;
    let b = s.length;
    while (a < b && chars.includes(s[a])) a++;
    while (b > a && chars.includes(s[b - 1])) b--;
    return s.slice(a, b);
  };
  const rstripChars = (s, chars) => stripChars('\u0000' + s, chars).slice(1);
  const cpLen = (s) => Array.from(s).length;
  const wordCount = (s) => (String(s).match(RE_WORDCHAR) || []).length;   // len(re.sub(r'\W', '', s))
  const isUpperStr = (s) => /\p{Uppercase}/u.test(s) && !/[\p{Lowercase}\p{Lt}]/u.test(s);   // str.isupper()
  const isLowerChar = (c) => /^\p{Lowercase}/u.test(c);                                   // str.islower() of one char
  const LINEBREAK = '\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]';
  const RE_LINEBREAK_G = new RegExp(LINEBREAK);
  const RE_LINEBREAK_END = new RegExp('(?:' + LINEBREAK + ')$');
  const splitLines = (text) => {                                                           // str.splitlines()
    const s = String(text || '');
    if (!s) return [];
    const parts = s.split(RE_LINEBREAK_G);
    if (RE_LINEBREAK_END.test(s)) parts.pop();
    return parts;
  };
  const universalNewlines = (s) => String(s || '').replace(/\r\n?/g, '\n');   // Python's text-mode file reading

  // Index n code points before / after idx (Python slices count code points).
  function backCp(s, idx, n) {
    let i = idx;
    while (n > 0 && i > 0) {
      i--;
      const c = s.charCodeAt(i);
      if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
        const p = s.charCodeAt(i - 1);
        if (p >= 0xd800 && p <= 0xdbff) i--;
      }
      n--;
    }
    return i;
  }
  function fwdCp(s, idx, n) {
    let i = idx;
    while (n > 0 && i < s.length) {
      const c = s.charCodeAt(i);
      i++;
      if (c >= 0xd800 && c <= 0xdbff && i < s.length) {
        const nx = s.charCodeAt(i);
        if (nx >= 0xdc00 && nx <= 0xdfff) i++;
      }
      n--;
    }
    return i;
  }

  // '%.{d}f' % x and round(x, d): correctly rounded, ties to even (toFixed rounds ties up).
  function pyFixed(x, d) {
    if (!isFinite(x)) return String(x);
    if (Math.abs(x) >= 1e21) return BigInt(x).toString() + (d ? '.' + '0'.repeat(d) : '');
    const s = x.toFixed(d);
    const long = x.toFixed(Math.min(100, d + 30));
    const dot = long.indexOf('.');
    if (/^50*$/.test(long.slice(dot + 1 + d))) {
      const down = d ? long.slice(0, dot + 1 + d) : long.slice(0, dot);
      if (Number(down[down.length - 1]) % 2 === 0) return down;
    }
    return s;
  }
  const pyRound = (x, d) => Number(pyFixed(x, d));

  // ---------- text helpers (jobkit/text.py) ----------

  function norm(text) {
    return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(RE_WS, ' ').trim();
  }
  function collapse(text) {
    return String(text == null ? '' : text).replace(RE_WS, ' ').replace(/^ +| +$/g, '');
  }

  const RE_TEX_COMMENT = py('(?<!\\\\)%[^\\n]*', 'g');
  function stripTexComments(src) {
    return String(src).replace(RE_TEX_COMMENT, '');
  }

  const RE_TEX_SETUP = py('\\\\(documentclass|usepackage|newcommand|renewcommand|setlength|titleformat|titlespacing|setlist|' +
    'geometry|pagestyle|hypersetup|definecolor|input|include)\\b(\\[[^\\]]*\\])?(\\{[^{}]*\\})*', 'g');
  const RE_HREF = py('\\\\(href)\\{[^{}]*\\}', 'g');
  const RE_TEXTBAR = py('\\\\textbar\\{\\}|\\\\textbar\\b', 'g');
  const RE_CMD = py('\\\\[a-zA-Z@]+\\*?(\\[[^\\]]*\\])?', 'g');

  function texToText(src) {
    let s = stripTexComments(src);
    s = s.replace(RE_TEX_SETUP, ' ');
    s = s.replace(RE_HREF, ' ');
    s = s.split('\\&').join('&').split('\\%').join('%').split('\\$').join('$').split('\\#').join('#').split('\\_').join('_');
    s = s.split('--').join('-').split('~').join(' ').split('\\\\').join('\n');
    s = s.replace(RE_TEXTBAR, '|');
    s = s.replace(RE_CMD, ' ');
    s = s.replace(/[{}]/g, ' ');
    return s.replace(/[ \t]+/g, ' ');
  }

  // jobkit/latex.py visible_source_text
  const RE_BEGIN_DOC = /\\begin\{document\}/;
  function visibleSourceText(src) {
    let s = stripTexComments(src || '');
    const m = RE_BEGIN_DOC.exec(s);
    if (m) s = s.slice(m.index + m[0].length);
    s = s.split('\\end{document}').join(' ');
    s = s.replace(py('\\\\\\\\\\s*\\[[^\\]]*\\]', 'g'), '\\\\');
    s = s.replace(py('\\\\(vspace|hspace|vskip|hskip|rule|setlength|addtolength|kern|raisebox)\\*?(\\{[^{}]*\\})+', 'g'), ' ');
    s = s.replace(py('\\{-?[\\d.]+\\s*(pt|em|ex|in|cm|mm|bp)\\}', 'g'), ' ');
    s = s.replace(py('\\\\[a-zA-Z@]+\\*?\\[[^\\]]*\\]', 'g'), ' ');
    s = s.replace(py('\\\\begin\\{[^}]*\\}(\\{[^}]*\\})?|\\\\end\\{[^}]*\\}', 'g'), ' ');
    return texToText(s);
  }

  // ---------- bullet extraction ----------

  function braced(s, i) {
    let depth = 0;
    let j = i;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return [s.slice(i + 1, j), j + 1];
      }
      j++;
    }
    return [s.slice(i + 1), s.length];
  }

  const RE_DEF = py('\\\\(?:re)?newcommand\\*?|\\\\providecommand\\*?|\\\\def\\s*\\\\[A-Za-z@]+[^{]*', 'g');
  const RE_MACRO_NAME = /^\\[A-Za-z@]+/;
  function dropDefinitions(s) {
    const out = [];
    let i = 0;
    for (;;) {
      RE_DEF.lastIndex = i;
      const m = RE_DEF.exec(s);
      if (!m) { out.push(s.slice(i)); break; }
      out.push(s.slice(i, m.index));
      let j = m.index + m[0].length;
      let braces = 0;
      const need = m[0].startsWith('\\def') ? 1 : 2;
      while (j < s.length && braces < need) {
        while (j < s.length && ' \t\n'.includes(s[j])) j++;
        if (j < s.length && s[j] === '[') {
          const k = s.indexOf(']', j);
          j = k > 0 ? k + 1 : j + 1;
          continue;
        }
        if (j < s.length && s[j] === '{') {
          j = braced(s, j)[1];
          braces++;
        } else if (j < s.length && s[j] === '\\' && braces === 0) {   // \newcommand\name{...}
          const k = RE_MACRO_NAME.exec(s.slice(j));
          j += k ? k[0].length : 1;
          braces++;
        } else break;
      }
      i = j;
    }
    return out.join('');
  }

  const cleanTex = (fragment) => stripChars(collapse(texToText(fragment)), ' ,;');

  const RE_ITEM_STOP = py('\\\\item\\b|\\\\end\\{|\\\\begin\\{|\\n\\s*\\n|\\\\[A-Za-z]*[Ii]tem[A-Za-z]*\\b|\\\\section|\\\\entry\\b', 'g');
  const RE_ITEM = py('\\\\item\\b(\\s*\\[[^\\]]*\\])?', 'g');
  const RE_ITEM_MACRO = py('\\\\([A-Za-z]*[Ii]tem[A-Za-z]*)\\*?\\s*(?=\\{)', 'g');

  function texBullets(src) {
    let s = dropDefinitions(stripTexComments(universalNewlines(src)));
    const m = RE_BEGIN_DOC.exec(s);
    if (m) s = s.slice(m.index + m[0].length);
    const found = [];
    for (const it of s.matchAll(RE_ITEM)) {
      const end = it.index + it[0].length;
      RE_ITEM_STOP.lastIndex = end;
      const nxt = RE_ITEM_STOP.exec(s);
      found.push([it.index, s.slice(end, nxt ? nxt.index : s.length)]);
    }
    for (const it of s.matchAll(RE_ITEM_MACRO)) {
      const name = it[1];
      if (name === 'item' || /(Start|End|List)$/.test(name)) continue;
      let j = it.index + it[0].length;
      const args = [];
      while (j < s.length && s[j] === '{' && args.length < 3) {
        const [arg, next] = braced(s, j);
        args.push(arg);
        j = next;
        while (j < s.length && ' \t'.includes(s[j])) j++;
      }
      found.push([it.index, args.join(' ')]);
    }
    found.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    const out = [];
    for (const [, frag] of found) {
      const t = cleanTex(frag);
      if (wordCount(t) >= 3) out.push(t);
    }
    return out;
  }

  const RE_MARK = py('^\\s*(?:[•\\-–—▪●◦*·]|\\u2022)\\s+');

  function plainBullets(text) {
    const out = [];
    let cur = null;
    for (const line of splitLines(universalNewlines(text))) {
      const st = pyStrip(line);
      if (RE_MARK.test(line)) {
        if (cur) out.push(cur);
        cur = pyStrip(line.replace(RE_MARK, ''));
      } else if (cur !== null && st && !isUpperStr(st) &&
        (isLowerChar(Array.from(st)[0]) || !pyRstrip(cur).endsWith('.')) && cpLen(st) > 2) {
        cur += ' ' + st;
      } else {
        if (cur) out.push(cur);
        cur = null;
      }
    }
    if (cur) out.push(cur);
    return out.filter((t) => wordCount(t) >= 3).map(collapse);
  }

  // Not in the Python (it picks by file extension): LaTeX source or plain text.
  function looksLikeTex(text) {
    const s = String(text || '');
    if (/\\documentclass|\\begin\{document\}/.test(s)) return true;
    return (s.match(/\\(?:item|section\*?|resumeItem|entry|textbf|begin)\b/g) || []).length >= 3;
  }

  function extractBullets(text) {
    return looksLikeTex(text) ? texBullets(text) : plainBullets(text);
  }

  // ---------- similarity and classification ----------

  const STOP = new Set(`a an the and or of to in on for with by at from as into via per over under using use used is are was were be
been being this that these those it its their our my your we i our than then so such across within each every all any
more most less new up out about after before while during through who which what when where how`.split(/\s+/));

  function tokens(text) {
    const out = [];
    for (let w of norm(text).split(' ')) {
      if (!w || STOP.has(w)) continue;
      if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
      else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
      else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
      out.push(w);
    }
    return out;
  }

  // difflib.SequenceMatcher(None, a, b).ratio(), autojunk included.
  function seqRatio(a, b) {
    const la = a.length;
    const lb = b.length;
    if (la + lb === 0) return 1;
    const b2j = new Map();
    for (let i = 0; i < lb; i++) {
      const list = b2j.get(b[i]);
      if (list) list.push(i);
      else b2j.set(b[i], [i]);
    }
    if (lb >= 200) {
      const ntest = Math.floor(lb / 100) + 1;
      for (const [elt, idxs] of [...b2j]) if (idxs.length > ntest) b2j.delete(elt);
    }
    const nothing = [];
    function longest(alo, ahi, blo, bhi) {
      let besti = alo;
      let bestj = blo;
      let bestsize = 0;
      let j2len = new Map();
      for (let i = alo; i < ahi; i++) {
        const newj2len = new Map();
        for (const j of b2j.get(a[i]) || nothing) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) || 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
        j2len = newj2len;
      }
      while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) { besti--; bestj--; bestsize++; }
      while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
      return [besti, bestj, bestsize];
    }
    const queue = [[0, la, 0, lb]];
    let matches = 0;
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      const [i, j, k] = longest(alo, ahi, blo, bhi);
      if (k) {
        matches += k;
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    return (2 * matches) / (la + lb);
  }

  function intersectSize(a, b) {
    let n = 0;
    for (const x of a) if (b.has(x)) n++;
    return n;
  }

  function similarity(a, b) {
    const na = norm(a);
    const nb = norm(b);
    if (!na || !nb) return 0;
    const ratio = seqRatio(na, nb);   // norm() leaves ASCII only, so UTF-16 indexing matches Python
    const ta = new Set(tokens(a));
    const tb = new Set(tokens(b));
    const dice = ta.size && tb.size ? (2 * intersectSize(ta, tb)) / (ta.size + tb.size) : 0;
    return pyRound(Math.max(ratio, dice), 3);
  }

  const coverage = (t, m) => (t.size ? intersectSize(t, m) / t.size : 0);
  const union = (a, b) => new Set([...a, ...b]);
  const digitRuns = (s) => String(s).match(/[0-9]+/g) || [];
  const sameList = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);

  const RE_SKILLS = py("^[A-Z][\\w &/'-]{0,30}:\\s");
  function isSkillsLine(text) {
    const s = text || '';
    return RE_SKILLS.test(s) && s.split(',').length - 1 >= 1;
  }

  function classify(master, tailored) {
    master = master || [];
    const mtok = master.map((m) => new Set(tokens(m)));
    const out = [];
    for (const t of tailored || []) {
      const tt = new Set(tokens(t));
      if (!master.length) {
        out.push({ text: t, kind: 'no_source', source: [], score: 0 });
        continue;
      }
      // sorted(((score, i)), reverse=True): best score, ties to the later bullet
      const scored = master.map((m, i) => [similarity(t, m), i]).sort((x, y) => y[0] - x[0] || y[1] - x[1]);
      const [bestS, bestI] = scored[0];
      const sameDigits = sameList(digitRuns(t), digitRuns(master[bestI]));
      if (norm(t) === norm(master[bestI]) || (bestS >= 0.96 && sameDigits)) {
        out.push({ text: t, kind: 'unchanged', source: [master[bestI]], score: bestS });
        continue;
      }
      const bestCov = coverage(tt, mtok[bestI]);
      // merged: two master bullets together explain the tailored one much better than either alone
      const cands = master.map((_, i) => i).sort((x, y) => -coverage(tt, mtok[x]) - -coverage(tt, mtok[y])).slice(0, 6);
      let merged = null;
      for (let x = 0; x < cands.length; x++) {
        for (let y = x + 1; y < cands.length; y++) {
          const i = cands[x];
          const j = cands[y];
          const un = coverage(tt, union(mtok[i], mtok[j]));
          let onlyI = 0;
          let onlyJ = 0;
          for (const w of tt) {
            if (mtok[i].has(w) && !mtok[j].has(w)) onlyI++;
            if (mtok[j].has(w) && !mtok[i].has(w)) onlyJ++;
          }
          const single = Math.max(coverage(tt, mtok[i]), coverage(tt, mtok[j]));
          if (un >= 0.6 && un - single >= 0.2 && onlyI >= 2 && onlyJ >= 2) {
            if (!merged || un > merged[0]) merged = [un, i, j];
          }
        }
      }
      if (merged && merged[0] > bestCov + 0.15) {
        const i = Math.min(merged[1], merged[2]);
        const j = Math.max(merged[1], merged[2]);
        out.push({ text: t, kind: 'merged', source: [master[i], master[j]], score: pyRound(merged[0], 3) });
      } else if (bestS >= 0.45 || bestCov >= 0.5) {
        out.push({ text: t, kind: 'reworded', source: [master[bestI]], score: pyRound(Math.max(bestS, bestCov), 3) });
      } else {
        out.push({ text: t, kind: 'no_source', source: bestS >= 0.25 ? [master[bestI]] : [], score: bestS });
      }
    }
    return out;
  }

  // ---------- facts ----------

  const RE_EMAIL = py('[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+', 'g');
  const RE_URLISH = py('(?:https?://|www\\.)\\S+|\\b[\\w-]+(?:\\.[\\w-]+)*\\.(?:com|ca|org|net|io|dev|co|uk|edu|app)(?:/\\S*)?', 'gi');
  const RE_PHONE = py('(?<!\\w)\\+?\\d[\\d\\s().-]{7,}\\d(?!\\w)', 'g');
  const NUM_SRC = '(?<![A-Za-z\\d.,/])([$£€]\\s?)?(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d+)?(\\s?%|[kKM](?![A-Za-z])|\\+)?(?![A-Za-z\\d]|\\.\\d)';
  const RE_NUM = py(NUM_SRC, 'g');
  const RE_NUM_ONE = py(NUM_SRC);
  const digitsOnly = (s) => s.replace(/[^0-9]/g, '');

  function stripContacts(text) {
    let t = String(text || '').replace(RE_EMAIL, ' ');
    t = t.replace(RE_URLISH, ' ');
    return t.replace(RE_PHONE, (m) => (digitsOnly(m).length >= 10 ? ' ' : m));
  }

  function context(text, start, end, width) {
    width = width || 45;
    return collapse(text.slice(backCp(text, start, width), fwdCp(text, end, width)));
  }

  function numValue(m) {
    let v = parseFloat(m[2].split(',').join('') + (m[3] || ''));
    const suf = pyStrip(m[4] || '');
    if (suf === 'k' || suf === 'K') v *= 1000;
    else if (suf === 'M') v *= 1000000;
    return rstripChars(rstripChars(pyFixed(v, 6), '0'), '.');
  }

  function numbersIn(text) {
    const t = stripContacts(text);
    const out = [];
    for (const m of t.matchAll(RE_NUM)) {
      out.push({ value: numValue(m), raw: pyStrip(m[0]), context: context(t, m.index, m.index + m[0].length) });
    }
    return out;
  }

  const COMMON = new Set(`about above academic account accounting achieved across action active activities added addition
additional administration advanced agile all also analysis analyst analytics analysed analyzed and annual applied april
assistant associate august automated automation award awards bachelor based best board budget built business by
campus candidate career centre center certificate certification certifications certified city client clients club
college commerce committee communication community company computer conference core course courses coursework created
customer customers daily data database day december degree delivered department design designed developed developer
development diploma director division during east education engineer engineering english experience february french
friday full fund general global graduate group head high honours honors hours ideas improved inc including industry
information intern internship interests january july june junior key lab languages lead leadership learning led level
limited ltd made management manager march master may member minor monday month monthly national new north november
october office officer online operations part personal present president professional profile program programme project
projects public qualifications reduced regional relevant report reporting reports research school science selected
senior september service services skills society software south spring staff student students summary summer support
system systems team teams technical technologies technology the thursday time tools training tuesday university
volunteer wednesday week weekly west winter work worked working year years jan feb mar apr jun jul aug sep sept
oct nov dec`.split(/\s+/));

  const RE_TERM = /[A-Za-z][A-Za-z0-9]*(?:[+#]+|(?:[./-][A-Za-z0-9]+)+)?[+#]*/g;
  const RE_TOOLISH = /[a-z][A-Z]|[A-Z]{2,}|[0-9]|[+#]|\.[A-Za-z]/;
  const RE_ACRONYM = /^(?:[A-Z]{2,}[a-z]?s?)$/;
  const RE_AFTER_STOP = py('[.!?:;|•(\\n\\[]\\s*$|^\\s*$');
  const RE_LINE_START = py('(^|\\n)\\s*$');

  function toolLike(tok) {
    const core = rstripChars(tok, '.');
    return RE_TOOLISH.test(core.length > 1 ? core.slice(1) : '') || RE_ACRONYM.test(core);
  }

  function termsInText(text) {
    const t = stripContacts(text);
    const out = [];
    const seen = new Set();
    for (const m of t.matchAll(RE_TERM)) {
      const tok = rstripChars(m[0], '.-/');
      if (tok.length < 2) continue;
      const start = m.index;
      const before = t.slice(backCp(t, start, 3), start);
      const sentenceStart = start === 0 || RE_AFTER_STOP.test(before) ||
        RE_LINE_START.test(t.slice(backCp(t, start, 40), start));
      const tool = toolLike(tok);
      const low = tok.toLowerCase();
      const proper = /[A-Z]/.test(tok[0]) && !sentenceStart && !COMMON.has(low) && !STOP.has(low);
      if (!(tool || proper)) continue;
      if (!tool && COMMON.has(low)) continue;
      if (!seen.has(low)) {
        seen.add(low);
        out.push({ term: tok, context: context(t, start, start + m[0].length) });
      }
    }
    return out;
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function isKnown(term, hayLower, hayNorm) {
    const low = term.toLowerCase();
    if (new RegExp('(?<![a-z0-9])' + escapeRe(low) + '(?![a-z0-9])').test(hayLower)) return true;
    const n = norm(term);
    const variants = new Set([n, n.replace(/s+$/, ''), n + 's']);
    for (const v of variants) if (v && hayNorm.includes(' ' + v + ' ')) return true;
    return false;
  }

  const RE_LINKS = py('(?:linkedin\\.com/in/[\\w%-]+|github\\.com/[\\w.-]+)', 'gi');
  const sortedUnique = (arr) => [...new Set(arr)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  function contactsIn(text) {
    const s = String(text || '');
    const emails = sortedUnique((s.match(RE_EMAIL) || []).map((e) => rstripChars(e.toLowerCase(), '.')));
    const phones = sortedUnique((s.match(RE_PHONE) || []).filter((p) => digitsOnly(p).length >= 10).map((p) => digitsOnly(p).slice(-10)));
    const links = sortedUnique((s.match(RE_LINKS) || []).map((l) => rstripChars(l.toLowerCase(), '/.')));
    return { emails, phones, links };
  }

  const PLACEHOLDERS = [
    py('\\[(?:company(?: name)?|role|position|job title|title|your name|name|hiring manager|manager|team|city|' +
      'date|location|x+|insert[^\\]]*)\\]', 'gi'),
    py('\\[[A-Z][A-Za-z ]{2,30}\\]', 'g'),
    py('\\b(?:TODO|TBD|FIXME)\\b', 'g'),
    py('\\bX{3,}\\b|\\bx{3,}\\b', 'g'),
    py('lorem ipsum', 'gi'),
    py('<(?![a-z]+://)[A-Za-z][^<>@\\n]{1,60}>', 'g'),
  ];

  function placeholdersIn(text) {
    const out = [];
    for (const pat of PLACEHOLDERS) {
      for (const m of String(text || '').matchAll(pat)) if (!out.includes(m[0])) out.push(m[0]);
    }
    return out;
  }

  // ---------- Markdown (not in the Python; see the header) ----------

  function stripMarkdown(text) {
    const lines = String(text || '').split('\n').map((line) => {
      let l = line;
      while (/^ {0,3}>/.test(l)) l = l.replace(/^ {0,3}> ?/, '');
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '';                    // horizontal rule
      l = l.replace(/^ {0,3}#{1,6}\s+/, '');                                  // heading
      l = l.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?/, '');      // list marker, task box
      return l;
    });
    let s = lines.join('\n');
    s = s.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1');                      // [text](url)
    s = s.replace(/`+([^`\n]*)`+/g, '$1');                                   // `code`
    s = s.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, '$2');                    // **bold**
    s = s.replace(/(?<![\p{L}\p{N}*_])([*_])(?=\S)([^\n*_]*?\S)\1(?![\p{L}\p{N}*_])/gu, '$2');   // *em*
    return s.replace(/\*\*/g, '');
  }

  // ---------- fact check ----------

  const ADVICE_OK = 'Nothing new found.';
  const ADVICE_FLAGGED = 'Every number and tool must come from the master or the profile: remove or correct new_numbers, ' +
    'check each new_terms item is a real fact from the master (never add posting keywords the user ' +
    'lacks), restore missing contact details and fill placeholders.';

  function yearOf(today) {
    if (today instanceof Date && !isNaN(today.getTime())) return today.getFullYear();
    if (typeof today === 'string') {
      const m = /^\s*(\d{4})/.exec(today);
      if (m) return Number(m[1]);
    }
    return new Date().getFullYear();
  }

  // { text, raw } as the Python's _text(path) and _raw(path) give for a .tex or a plain-text file.
  function readInput(src, format) {
    const s = universalNewlines(src);
    const tex = format === 'tex' || (format !== 'text' && looksLikeTex(s));
    if (tex) return { text: visibleSourceText(dropDefinitions(stripTexComments(s))), raw: s, tex: true };
    return { text: s, raw: s, tex: false };
  }

  const RE_ALLOW_SPLIT = py('[\\s,/|]+');
  const RE_ALLOW_NUM = py('^(?:[\\d.,]+%?)$');

  function factCheck(masterText, candidateText, opts) {
    const o = opts || {};
    const format = o.format || 'auto';
    const year = String(yearOf(o.today));
    const master = readInput(masterText, format);
    let knownText = '';
    for (const k of o.known || []) {
      if (!k) continue;
      const kin = readInput(typeof k === 'string' ? k : JSON.stringify(k), format);
      knownText += '\n' + kin.text + '\n' + kin.raw + '\n';
    }
    const cand = readInput(candidateText, format);
    const candText = !cand.tex && o.markdown !== false ? stripMarkdown(cand.text) : cand.text;
    if (!norm(candText)) {
      return {
        ok: false, error: 'No text to check.',
        newNumbers: [], newTerms: [], missingContact: [], placeholders: [],
        counts: { newNumbers: 0, newTerms: 0, missingContact: 0, placeholders: 0 }, advice: '',
      };
    }

    const allowWords = new Set();
    const allowValues = new Set();
    for (const a0 of o.allow || []) {
      const a = a0 == null ? '' : String(a0);
      for (const w of a.split(RE_ALLOW_SPLIT)) {
        if (!w) continue;
        allowWords.add(w.toLowerCase());
        if (RE_ALLOW_NUM.test(w)) {
          const m = RE_NUM_ONE.exec(w);
          allowValues.add(m ? numValue(m) : w);
        }
      }
      allowWords.add(a.toLowerCase());
    }

    const reference = master.text + '\n' + master.raw + '\n' + knownText;
    const refValues = new Set(numbersIn(reference).map((n) => n.value));
    const newNumbers = [];
    const seen = new Set();
    for (const n of numbersIn(candText)) {
      const v = n.value;
      if (refValues.has(v) || allowValues.has(v) || seen.has(v) || allowWords.has(n.raw.toLowerCase())) continue;
      if (v === year) continue;
      seen.add(v);
      newNumbers.push(n);
    }

    const refLower = reference.toLowerCase();
    const refNorm = ' ' + norm(reference) + ' ';
    const allowParts = [];
    for (const a of allowWords) for (const w of a.split(RE_WS)) if (w) allowParts.push(w);
    const newTerms = [];
    for (const t of termsInText(candText)) {
      const low = t.term.toLowerCase();
      if (allowWords.has(low) || allowParts.includes(low)) continue;
      if (isKnown(t.term, refLower, refNorm)) continue;
      newTerms.push(t);
    }

    const missing = [];
    if (o.resume) {
      const mc = contactsIn(master.text + '\n' + master.raw);
      const cc = contactsIn(candText + '\n' + cand.raw);
      for (const kind of ['emails', 'phones', 'links']) {
        for (const item of mc[kind]) if (!cc[kind].includes(item)) missing.push(item);
      }
    }

    const placeholders = placeholdersIn(candText);
    const flagged = !!(newNumbers.length || newTerms.length || missing.length || placeholders.length);
    return {
      ok: !flagged,
      newNumbers, newTerms, missingContact: missing, placeholders,
      counts: { newNumbers: newNumbers.length, newTerms: newTerms.length, missingContact: missing.length, placeholders: placeholders.length },
      advice: flagged ? ADVICE_FLAGGED : ADVICE_OK,
    };
  }

  // One list for the UI: everything the check could not find in the résumé or facts.
  function summarize(result) {
    const r = result || {};
    const unsupported = [];
    for (const n of r.newNumbers || []) unsupported.push({ kind: 'number', text: n.raw, context: n.context });
    const placeholders = (r.placeholders || []).slice();
    for (const t of r.newTerms || []) {
      if (!placeholders.includes(t.term)) unsupported.push({ kind: 'term', text: t.term, context: t.context });   // TODO, XXX: shown once, as placeholders
    }
    for (const c of r.missingContact || []) unsupported.push({ kind: 'contact', text: c, context: 'In your résumé but missing here' });
    return { ok: !!r.ok, unsupported, placeholders };
  }

  return {
    factCheck, summarize, classify, plainBullets, texBullets, extractBullets, similarity, isSkillsLine,
    numbersIn, termsInText, contactsIn, placeholdersIn,
    // helpers, exported for tests and other modules
    stripMarkdown, looksLikeTex, visibleSourceText, texToText, norm, collapse,
  };
});
