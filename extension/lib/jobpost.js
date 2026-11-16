// Job postings from the browser extension: turns what the extension read from
// the page the user is viewing into { company, role, description, url }, and
// validates an import before it is written or saved. Used by the extension
// popup (copied to extension/lib/), the native messaging host and the app.
// Pure; loads as CommonJS or as a browser global (CoreJobPost).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreJobPost = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const LIMITS = { company: 200, role: 200, description: 60000, url: 2000 };

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…' };
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  }

  // HTML (often entity-encoded, as in JSON-LD descriptions) to readable text
  // with line breaks and "- " bullets. No DOM needed.
  function htmlToText(html) {
    let s = String(html || '');
    if (/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z]/i.test(s)) s = decodeEntities(s);
    s = s
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section)>/gi, '\n')
      .replace(/<(p|div|ul|ol|h[1-6]|tr|section)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    // Keep list items together.
    return clean(decodeEntities(s)).replace(/\n{2,}- /g, '\n- ');
  }

  function clean(s) {
    return String(s || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function oneLine(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  // Every schema.org JobPosting in the page's JSON-LD blocks (top level,
  // arrays and @graph).
  function findJobPostings(blocks) {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      const type = node['@type'];
      if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(node);
      if (node['@graph']) visit(node['@graph']);
    };
    for (const b of blocks || []) {
      try {
        visit(JSON.parse(b));
      } catch {
        // Not valid JSON: skip it.
      }
    }
    return out;
  }

  const BOARDS = /\s*[|\-–—·]\s*(LinkedIn|Indeed(\.com)?|Glassdoor|Greenhouse|Lever|Workday|Ashby|Wellfound|AngelList|Monster|ZipRecruiter|Dice|Otta|Welcome to the Jungle|SimplyHired|Careers?|Jobs?)\s*$/i;

  function titleCase(slug) {
    return String(slug || '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  // Company name from the URL of the common applicant tracking systems.
  function companyFromUrl(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return '';
    }
    const seg = u.pathname.split('/').filter(Boolean);
    const host = u.hostname.toLowerCase();
    if (/(^|\.)greenhouse\.io$/.test(host) || /(^|\.)lever\.co$/.test(host) || /(^|\.)ashbyhq\.com$/.test(host) || /(^|\.)workable\.com$/.test(host)) {
      const slug = seg[0] === 'embed' ? u.searchParams.get('for') : seg[0];
      return slug ? titleCase(slug) : '';
    }
    const wd = /^([a-z0-9-]+)\.wd\d+\.myworkdayjobs\.com$/.exec(host);
    if (wd) return titleCase(wd[1]);
    return '';
  }

  // Role and company from a page title such as "Senior SRE at Contoso",
  // "Job Application for SRE at Contoso", "Contoso hiring SRE in Seattle |
  // LinkedIn" or "Contoso - SRE" (when the company is known).
  function splitTitle(title, knownCompany) {
    let t = oneLine(title);
    for (let i = 0; i < 2; i++) t = t.replace(BOARDS, '');
    let m = /^job application for (.+?) at (.+)$/i.exec(t);
    if (m) return { role: m[1], company: m[2] };
    m = /^(.+?) hiring (.+?)(?: in .+)?$/i.exec(t);
    if (m) return { role: m[2], company: m[1] };
    m = /^(.+?) at (.+)$/i.exec(t);
    if (m) return { role: m[1], company: m[2].replace(/\s*[|\-–—].*$/, '') };
    const parts = t.split(/\s+[|\-–—]\s+/).filter(Boolean);
    if (parts.length >= 2 && knownCompany) {
      const k = knownCompany.toLowerCase();
      const ci = parts.findIndex((p) => p.toLowerCase() === k);
      if (ci >= 0) return { role: parts.find((_, i) => i !== ci), company: parts[ci] };
    }
    return { role: parts[0] || t, company: '' };
  }

  // raw: { url, title, ogTitle, siteName, h1, jsonLd: [string], selection, text }
  function parseJobPage(raw) {
    const r = raw || {};
    const url = String(r.url || '');
    const posting = findJobPostings(r.jsonLd)[0];
    const fromUrl = companyFromUrl(url);
    const result = { company: '', role: '', description: '', url, source: 'page' };

    if (posting) {
      const org = posting.hiringOrganization;
      result.company = oneLine(typeof org === 'string' ? org : org?.name || '');
      result.role = oneLine(decodeEntities(posting.title || ''));
      result.description = htmlToText(posting.description || '');
      const loc = [].concat(posting.jobLocation || []).map((l) => l?.address?.addressLocality).filter(Boolean)[0];
      const remote = posting.jobLocationType === 'TELECOMMUTE' ? 'Remote' : '';
      const where = [loc, remote].filter(Boolean).join(' · ');
      if (where && result.description) result.description = `Location: ${where}\n\n${result.description}`;
      result.source = 'structured';
    }

    const titled = splitTitle(r.ogTitle || r.title || '', result.company || fromUrl || r.siteName);
    if (!result.role) result.role = oneLine(r.h1) || titled.role;
    if (!result.company) result.company = titled.company || fromUrl || oneLine(r.siteName);

    // A selection is what the user chose to send; it beats our guesses.
    const selection = clean(r.selection);
    if (selection.length >= 40) {
      result.description = selection;
      result.source = 'selection';
    } else if (!result.description) {
      result.description = clean(r.text);
    }

    result.company = result.company.slice(0, LIMITS.company);
    result.role = result.role.slice(0, LIMITS.role);
    result.description = result.description.slice(0, LIMITS.description);
    return result;
  }

  // Validates and normalises a job sent by the extension. Returns
  // { ok: true, job } or { ok: false, error }. Used by both the host (before
  // writing) and the app (before saving), since neither trusts the other side.
  function cleanImport(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'No job in the message.' };
    const str = (v, max) => (typeof v === 'string' ? v : '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
    const job = {
      company: oneLine(str(input.company, LIMITS.company)),
      role: oneLine(str(input.role, LIMITS.role)),
      description: clean(str(input.description, LIMITS.description)),
      url: str(input.url, LIMITS.url),
    };
    if (job.url) {
      let u;
      try {
        u = new URL(job.url);
      } catch {
        return { ok: false, error: 'The page address is not valid.' };
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Only web pages (http or https) can be imported.' };
      u.hash = '';
      job.url = u.toString();
    }
    if (!job.company && !job.role && !job.description) return { ok: false, error: 'The job has no company, role or description.' };
    return { ok: true, job };
  }

  return { parseJobPage, cleanImport, htmlToText, splitTitle, companyFromUrl, findJobPostings, LIMITS };
});
