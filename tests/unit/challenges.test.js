// Verifies the Coding Lab challenge library: every test case must pass with a
// known-correct reference solution in every language the challenge offers,
// using the same judges the app uses (packages/core/judge.js, pyharness.js).
// A wrong expected value in challenges.json fails here, not in front of a user.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const CHALLENGES = require('../../packages/core/challenges.json');
const J = require('../../packages/core/judge');
const { HARNESS } = require('../../packages/core/pyharness');

const JS = {
  twoSum: (nums, target) => {
    const seen = new Map();
    for (let i = 0; i < nums.length; i++) {
      if (seen.has(target - nums[i])) return [seen.get(target - nums[i]), i];
      seen.set(nums[i], i);
    }
  },
  isValid: (s) => {
    const st = [];
    const pair = { ')': '(', ']': '[', '}': '{' };
    for (const c of s) {
      if ('([{'.includes(c)) st.push(c);
      else if (st.pop() !== pair[c]) return false;
    }
    return st.length === 0;
  },
  search: (nums, t) => {
    let lo = 0;
    let hi = nums.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nums[mid] === t) return mid;
      if (nums[mid] < t) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  },
  climbStairs: (n) => {
    let a = 1;
    let b = 1;
    for (let i = 1; i < n; i++) [a, b] = [b, a + b];
    return b;
  },
  lengthOfLongestSubstring: (s) => {
    const last = new Map();
    let start = 0;
    let best = 0;
    for (let i = 0; i < s.length; i++) {
      if (last.has(s[i]) && last.get(s[i]) >= start) start = last.get(s[i]) + 1;
      last.set(s[i], i);
      best = Math.max(best, i - start + 1);
    }
    return best;
  },
  merge: (iv) => {
    const out = [];
    for (const [a, b] of [...iv].sort((x, y) => x[0] - y[0])) {
      if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
      else out.push([a, b]);
    }
    return out;
  },
  groupAnagrams: (strs) => {
    const m = new Map();
    for (const s of strs) {
      const k = [...s].sort().join('');
      m.set(k, [...(m.get(k) || []), s]);
    }
    return [...m.values()];
  },
  topKFrequent: (nums, k) => {
    const c = new Map();
    for (const n of nums) c.set(n, (c.get(n) || 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([n]) => n);
  },
  productExceptSelf: (nums) => {
    const out = Array(nums.length).fill(1);
    let p = 1;
    for (let i = 0; i < nums.length; i++) {
      out[i] = p;
      p *= nums[i];
    }
    p = 1;
    for (let i = nums.length - 1; i >= 0; i--) {
      out[i] *= p;
      p *= nums[i];
    }
    return out;
  },
  maxSubArray: (nums) => {
    let best = nums[0];
    let cur = 0;
    for (const n of nums) {
      cur = Math.max(n, cur + n);
      best = Math.max(best, cur);
    }
    return best;
  },
};

const PY = `
from collections import Counter, defaultdict
def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen: return [seen[target - n], i]
        seen[n] = i
def is_valid(s):
    st, pair = [], {')': '(', ']': '[', '}': '{'}
    for c in s:
        if c in '([{': st.append(c)
        elif not st or st.pop() != pair[c]: return False
    return not st
def search(nums, t):
    lo, hi = 0, len(nums) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if nums[mid] == t: return mid
        if nums[mid] < t: lo = mid + 1
        else: hi = mid - 1
    return -1
def climb_stairs(n):
    a, b = 1, 1
    for _ in range(n - 1): a, b = b, a + b
    return b
def length_of_longest_substring(s):
    last, start, best = {}, 0, 0
    for i, c in enumerate(s):
        if c in last and last[c] >= start: start = last[c] + 1
        last[c] = i
        best = max(best, i - start + 1)
    return best
def merge(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]: out[-1][1] = max(out[-1][1], b)
        else: out.append([a, b])
    return out
def group_anagrams(strs):
    g = defaultdict(list)
    for s in strs: g[''.join(sorted(s))].append(s)
    return list(g.values())
def top_k_frequent(nums, k):
    return [n for n, _ in Counter(nums).most_common(k)]
def product_except_self(nums):
    out, p = [1] * len(nums), 1
    for i in range(len(nums)):
        out[i] = p; p *= nums[i]
    p = 1
    for i in range(len(nums) - 1, -1, -1):
        out[i] *= p; p *= nums[i]
    return out
def max_sub_array(nums):
    best, cur = nums[0], 0
    for n in nums:
        cur = max(n, cur + n); best = max(best, cur)
    return best
`;

const SQL = {
  'second-highest-salary': 'SELECT (SELECT DISTINCT salary FROM employees ORDER BY salary DESC LIMIT 1 OFFSET 1) AS second_highest;',
  'customers-without-orders': 'SELECT name FROM customers c WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);',
  'top-earner-per-department':
    'SELECT department, employee, salary FROM (SELECT d.name AS department, e.name AS employee, e.salary, RANK() OVER (PARTITION BY d.id ORDER BY e.salary DESC) AS r FROM employees e JOIN departments d ON d.id = e.department_id) WHERE r = 1;',
  'running-total': 'SELECT day, SUM(amount) OVER (ORDER BY day) AS running_total FROM sales ORDER BY day;',
};

test('challenge library is well-formed', () => {
  const ids = new Set();
  for (const c of CHALLENGES) {
    assert.ok(!ids.has(c.id), `duplicate id ${c.id}`);
    ids.add(c.id);
    assert.ok(['easy', 'medium', 'hard'].includes(c.difficulty), c.id);
    assert.ok(c.tests.some((t) => !t.hidden) && c.tests.some((t) => t.hidden), `${c.id} needs visible and hidden tests`);
    for (const lang of c.languages) assert.ok(c.starter[lang], `${c.id} starter ${lang}`);
    if (c.fn) for (const lang of c.languages) assert.ok(J.validIdentifier(c.fn[lang]), `${c.id} fn ${lang}`);
  }
});

test('JavaScript reference solutions pass every test', () => {
  for (const c of CHALLENGES.filter((x) => x.languages.includes('javascript'))) {
    const fn = JS[c.fn.javascript];
    for (const t of c.tests) assert.ok(J.equal(fn(...structuredClone(t.args)), t.expected, c.compare), `${c.id} ${JSON.stringify(t.args)}`);
  }
});

test('SQL reference queries pass every test (sql.js)', async () => {
  const initSqlJs = require('sql.js');
  const SQLjs = await initSqlJs();
  for (const c of CHALLENGES.filter((x) => x.languages.includes('sql'))) {
    for (const t of c.tests) {
      const db = new SQLjs.Database();
      db.exec(t.schema);
      const res = db.exec(SQL[c.id]);
      const rows = res.length ? res[res.length - 1].values : [];
      db.close();
      assert.ok(J.rowsEqual(rows, t.expected, c.ordered), `${c.id}: got ${JSON.stringify(rows)}`);
    }
  }
});

test('Python reference solutions pass every test (real Pyodide)', { timeout: 120000 }, async () => {
  const { loadPyodide } = require('pyodide');
  const py = await loadPyodide({ indexURL: path.join(__dirname, '..', '..', 'node_modules', 'pyodide') + path.sep });
  for (const c of CHALLENGES.filter((x) => x.languages.includes('python'))) {
    const ns = py.globals.get('dict')();
    py.runPython(PY, { globals: ns });
    ns.set('_FN', c.fn.python);
    ns.set('_TESTS', JSON.stringify(c.tests));
    ns.set('_MODE', c.compare);
    const results = JSON.parse(py.runPython(HARNESS, { globals: ns }));
    results.forEach((r, i) => assert.ok(r.ok, `${c.id} test ${i}: ${JSON.stringify(r)}`));
    ns.destroy();
  }
});

test('the Python harness reports wrong answers, exceptions and a missing function', async () => {
  const { loadPyodide } = require('pyodide');
  const py = await loadPyodide({ indexURL: path.join(__dirname, '..', '..', 'node_modules', 'pyodide') + path.sep });
  const run = (code, fn, tests, mode = 'exact') => {
    const ns = py.globals.get('dict')();
    py.runPython(code, { globals: ns });
    ns.set('_FN', fn);
    ns.set('_TESTS', JSON.stringify(tests));
    ns.set('_MODE', mode);
    return JSON.parse(py.runPython(HARNESS, { globals: ns }));
  };
  const r = run('def f(x):\n    if x == 2: raise ValueError("boom")\n    return x + 1\n', 'f', [{ args: [1], expected: 2 }, { args: [3], expected: 5 }, { args: [2], expected: 3 }]);
  assert.equal(r[0].ok, true);
  assert.equal(r[1].ok, false);
  assert.equal(r[1].got, 4);
  assert.match(r[2].error, /ValueError: boom/);
  assert.throws(() => run('x = 1', 'f', [{ args: [1], expected: 1 }]), /Function f\(\) is not defined/);
  assert.equal(run('def f():\n    return (1, 2.0)', 'f', [{ args: [], expected: [1, 2] }])[0].ok, true);
});
