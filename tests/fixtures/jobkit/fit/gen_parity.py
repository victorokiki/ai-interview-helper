"""Writes expected.json: what the Autonomous Job Kit's rank_jobs.py gives for inputs.json.

    python gen_parity.py <path to the kit checkout>

tests/unit/fit.test.js checks packages/core/fit.js against it. The kit's network and file access is replaced the same
way fit.js replaces it: the UK sponsor register comes from inputs.json (or is "not loaded"), the master resume is
text_of() of the text (as master_text() does for resume files), search.json "extra_skills" are added to VOCAB as
load_search() does, and jobkit.redflags is left out (fit.js takes the scam checks as an option).
"""
import datetime as dt
import importlib.util
import json
import os
import sys

KIT = os.path.abspath(sys.argv[1])
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(KIT, 'internship-application', 'scripts')
sys.path[:0] = [os.path.join(KIT, 'lib'), SCRIPTS]
sys.modules['jobkit.redflags'] = None  # ImportError inside score(): no scam warnings, like fit.js without options.redFlags

spec = importlib.util.spec_from_file_location('rank_jobs', os.path.join(SCRIPTS, 'rank_jobs.py'))
rj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rj)
import sponsor_check  # noqa: E402

NO_REGISTER = 'no sponsor register loaded'
BASE_VOCAB = list(rj.VOCAB)


def with_search(search):
    rj.VOCAB[:] = BASE_VOCAB
    for t in search.get('extra_skills') or []:  # load_search()
        t = str(t).strip().lower()
        if t and t not in rj.VOCAB:
            rj.VOCAB.append(t)


def register(rows):
    out = {}
    for r in rows:
        out.setdefault(sponsor_check.norm(r['name']), []).append(r)
    return out


def camel(r):
    keys = {'years_required': 'yearsRequired', 'matched_skills': 'matchedSkills'}
    return {keys.get(k, k): v for k, v in r.items()}


inp = json.load(open(os.path.join(HERE, 'inputs.json'), encoding='utf-8'))
today = dt.date.fromisoformat(inp['today'])
out = {'cases': [], 'functions': {}}
for c in inp['cases']:
    search = inp['searches'][c['search']]
    with_search(search)
    reg = register(inp['registers'][c['sponsors']]) if c.get('sponsors') else NO_REGISTER
    rj.sponsor_register = lambda reg=reg: reg
    r = rj.score(c['posting'], rj.text_of(inp['masters'][c['master']]), search, today)
    out['cases'].append({'name': c['name'], 'result': camel(r)})

rj.VOCAB[:] = BASE_VOCAB
f, S = inp['functions'], inp['searches']
epoch = dt.date(1970, 1, 1)


def iso_day(s):
    try:
        return (dt.date.fromisoformat(s[:10]) - epoch).days
    except ValueError:
        return None


out['functions'] = {
    'placeFit': [rj.place_fit(loc, S[k]) for k, loc in f['placeFit']],
    'yearsRequired': [rj.years_required(s) for s in f['yearsRequired']],
    'salaryMax': [rj.salary_max(s) for s in f['salaryMax']],
    'termsIn': [sorted(rj.terms_in(s.lower())) for s in f['termsIn']],
    'textOf': [rj.text_of(s) for s in f['textOf']],
    'bestTrack': [list(rj.best_track(t, S[k])) for k, t in f['bestTrack']],
    'excluded': [rj.excluded(t, S[k]) for k, t in f['excluded']],
    'dates': [iso_day(s) for s in f['dates']],
    'sponsorNorm': [sponsor_check.norm(s) for s in f['sponsorNorm']],
}
with open(os.path.join(HERE, 'expected.json'), 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
    fh.write('\n')
print(f"wrote {len(out['cases'])} cases")
