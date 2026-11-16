"""Writes expected.json: what the Autonomous Job Kit's find_jobs.py, find_internships.py and job_digest.py give for
inputs.json and the canned source responses in responses/ (routes.json maps each address to its response).

    python gen_parity.py <path to the kit checkout>

tests/unit/discover.test.js checks packages/core/discover.js against it. The kit's network and file access is replaced
the way discover.js replaces it: find_jobs.get() answers from routes.json (anything else is HTTP 404), the SimplifyJobs
temp-file cache points at an empty folder, tracker.xlsx is the tracker rows in inputs.json (keys built as
tracker_index() builds them), jobs.txt holds inputs.json "queued", and the description fetch in enrich() answers from
inputs.json "enrich". jobkit.redflags stays in (discover.js passes redflags.js to fit.js by default).
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import urllib.error

KIT = os.path.abspath(sys.argv[1])
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(KIT, 'internship-application', 'scripts')
sys.path[:0] = [os.path.join(KIT, 'lib'), SCRIPTS]


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(SCRIPTS, name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


rj = load('rank_jobs')
fj = load('find_jobs')
jd = load('job_digest')
fi = load('find_internships')
from jobkit import postings as jpostings  # noqa: E402
from jobkit.queue import posting_keys, role_key, clean_url  # noqa: E402
from jobkit.text import name_key, norm  # noqa: E402

inp = json.load(open(os.path.join(HERE, 'inputs.json'), encoding='utf-8'))
routes = json.load(open(os.path.join(HERE, 'routes.json'), encoding='utf-8'))
TODAY = dt.date.fromisoformat(inp['today'])
BASE_VOCAB = list(rj.VOCAB)
REQUESTS = []


def fake_get(url, data=None, headers=None, raw=False, timeout=30):
    REQUESTS.append(url)
    r = routes.get(url)
    if r and 'post' in r:
        r = {'file': r['post'].get((data or {}).get('searchText'))} if data is not None else None
    if not r or (not r.get('file') and not r.get('status')):
        raise urllib.error.HTTPError(url, 404, 'Not Found', {}, None)
    if r.get('status'):
        raise urllib.error.HTTPError(url, r['status'], 'Server Error', {}, None)
    text = open(os.path.join(HERE, 'responses', r['file']), encoding='utf-8').read()
    return text if raw else json.loads(text)


fj.get = fake_get
TMP = tempfile.mkdtemp(prefix='discover-parity-')
CACHE = os.path.join(TMP, 'cache')
fj.tempfile.gettempdir = lambda: CACHE  # the SimplifyJobs 3-hour cache, emptied before each search


def empty_cache():
    shutil.rmtree(CACHE, ignore_errors=True)
    os.makedirs(CACHE)


def tracked_keys(rows):  # find_jobs.tracker_index() for tracker rows
    keys = set()
    for row in rows:
        keys |= posting_keys(row.get('url') or row.get('posting_url'))
        k = role_key(row.get('company'), row.get('role'))
        if k:
            keys.add(k)
    return keys


def fake_fetch(url, f=None):
    e = inp['enrich'].get(url)
    return dict(e) if e else {'error': 'not in the enrich table'}


jpostings.fetch = fake_fetch
jpostings.Fetcher = lambda *a, **k: None


def with_search(search):
    rj.VOCAB[:] = BASE_VOCAB
    for t in search.get('extra_skills') or []:
        t = str(t).strip().lower()
        if t and t not in rj.VOCAB:
            rj.VOCAB.append(t)


def fit_of(j):
    f = j['fit']
    return {'score': f['score'], 'track': f['track'], 'place': f['place'], 'why': f['why'], 'gaps': f['gaps'],
            'flags': f['flags'], 'matchedSkills': f['matched_skills'], 'yearsRequired': f['years_required'], 'parts': f['parts']}


out = {'collect': {}, 'rank': {}, 'functions': {}}

# ---- collect, then the whole run (filter, score, order, enrich) ----
for key in ('ca', 'us'):
    search = inp['searches'][key]
    with_search(search)
    REQUESTS.clear()
    empty_cache()
    errors = {}
    found, counts = fj.collect(search, fj.ALL_SOURCES, errors)
    out['collect'][key] = {'requests': list(REQUESTS), 'jobs': found, 'counts': counts, 'errors': errors}

    folder = os.path.join(TMP, key)
    os.makedirs(os.path.join(folder, 'resume'))
    json.dump(search, open(os.path.join(folder, 'search.json'), 'w', encoding='utf-8'))
    open(os.path.join(folder, 'resume', 'master.tex'), 'w', encoding='utf-8').write(inp['master'])
    open(os.path.join(folder, 'jobs.txt'), 'w', encoding='utf-8').write('\n'.join(inp['queued']) + '\n\n# done\n')
    json.dump(inp['profile'], open(os.path.join(folder, 'profile.json'), 'w', encoding='utf-8'))
    fj.tracker_index = lambda folder: tracked_keys(inp['tracker'])
    empty_cache()
    ranked, report = fj.run(folder, fj.ALL_SOURCES, inp['days'], TODAY)
    out['rank'][key] = {
        'jobs': [{**{k: j[k] for k in ('source', 'company', 'title', 'location', 'url', 'posted', 'description', 'kind')}, **fit_of(j),
                  'queueable': fj.queueable(j, inp['profile'])} for j in ranked],
        'skipped': report['skipped'], 'found': report['found'], 'kept': report['kept'], 'fetched': report['descriptions_fetched'],
        'picked': [j['url'] for j in fj.pick_for_queue(ranked, folder, search, search.get('min_score_to_queue', 55))],
        'notes': [fj.note(j).split('  # ', 1)[1] for j in ranked],
    }

    # ---- the digest: what's new since the seen keys, and the markdown ----
    if key == 'ca':
        seen = {k: '2026-11-01' for k in inp['seen']}
        new = [j for j in ranked if jd.key(j) not in seen]
        older = len(ranked) - len(new)
        min_score = search.get('min_score_to_queue', 55)
        queued = fj.pick_for_queue(new, folder, search, min_score)

        class Day(dt.date):  # %-d is not supported by strftime on Windows
            def __format__(self, spec):
                return self.strftime(spec.replace('%-d', str(self.day)))

        path = jd.write_digest(folder, Day(TODAY.year, TODAY.month, TODAY.day), new, older, report, queued, min_score, 15)
        for j in ranked:
            seen.setdefault(jd.key(j), TODAY.isoformat())
        out['digest'] = {
            'keys': [jd.key(j) for j in ranked], 'fresh': [j['url'] for j in new], 'older': older,
            'queued': [j['url'] for j in queued], 'markdown': open(path, encoding='utf-8').read(),
            'errors': [{'source': k, 'message': v} for k, v in report['errors'].items()],
            'counts': report['per_source'], 'found': report['found'], 'seenAfter': seen,
        }

# ---- helpers ----
f = inp['functions']
out['functions']['postingKeys'] = [sorted(posting_keys(u)) for u in f['postingKeys']]
out['functions']['cleanUrl'] = [clean_url(u) for u in f['postingKeys']]
out['functions']['jobKey'] = [jd.key({'url': u}) for u in f['postingKeys']]
out['functions']['roleKey'] = [role_key(c, r) for c, r in f['roles']]
out['functions']['nameKey'] = [name_key(c) for c, _ in f['roles']]
out['functions']['norm'] = [norm(r) for _, r in f['roles']]
out['functions']['day'] = [fj.day(v) for v in f['day']]
out['functions']['title'] = [t.title() for t in f['title']]

# ---- add_employer's link parsing (the board probe answers with no postings) ----
for name in ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday'):
    setattr(fj, name, lambda entry, search: [])
emp = []
for url in inp['employers']:
    folder = tempfile.mkdtemp(dir=TMP)
    json.dump({'employers': {}}, open(os.path.join(folder, 'search.json'), 'w', encoding='utf-8'))
    try:
        r = fj.add_employer(folder, url)
        emp.append({'system': r['kind'], 'entry': r['entry']} if r['ok'] else None)
    except Exception as e:  # the kit stops with a traceback (myworkdaysite.com link without tenant and site)
        emp.append(None)
out['employers'] = emp

# ---- find_internships.search ----
I = inp['internships']
itoday = dt.date.fromisoformat(I['today'])
icases = []
for c in I['cases']:
    flt, ctx = c['filters'], c.get('context', {})
    a = argparse.Namespace(term=flt.get('term'), category=flt.get('category'), location=flt.get('location'),
                           keyword=flt.get('keyword'), exclude_keyword=flt.get('excludeKeyword'), degree=flt.get('degree'),
                           needs_sponsorship=flt.get('needsSponsorship'), no_citizenship=flt.get('noCitizenship', False),
                           days=flt.get('days'), include_abroad=flt.get('includeAbroad', False))
    tracked, roles = {}, {}
    for row in ctx.get('tracked', []):
        for k in posting_keys(row.get('url')):
            tracked[k] = 'A'
        rk = role_key(row.get('company'), row.get('role'))
        if rk:
            roles[rk] = 'A'
    qkeys = set()
    for u in ctx.get('queued', []):
        qkeys |= posting_keys(u)
    qroles = {role_key(cc, rr) for cc, rr in ctx.get('queuedRoles', [])} - {None}
    kept, skipped = fi.search(I['listings'], a, c['profile'], tracked, roles, qkeys, itoday, qroles)
    term = a.term or (c['profile'].get('internshipTerm') or '').strip() or fi.DEFAULT_TERM
    icases.append({'name': c['name'], 'results': kept, 'skipped': skipped, 'term': term})
out['internships'] = {
    'cases': icases,
    'usLocations': [fi.is_us_location(l) for l in I['usLocations']],
    'degrees': [fi.degree_level(d) for d in I['degrees']],
    'locationMatches': [fi._location_match(l, w) for l, w in I['locationMatches']],
}

with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False)
    fh.write('\n')
shutil.rmtree(TMP, ignore_errors=True)
print('wrote expected.json')
