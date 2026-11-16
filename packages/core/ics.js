// Calendar invites (.ics, RFC 5545) for Jobs: parses events, converts their
// times to UTC (IANA, Windows/Outlook and fixed-offset time zones), finds the
// meeting link, tells interviews from other meetings, matches each event to a
// job, and builds the import plan the user reviews. Pure; loads as CommonJS or
// as a browser global (CoreIcs). Needs Intl time zone support (Node, Chromium).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreIcs = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Outlook and Exchange write Windows zone names.
  const WINDOWS_ZONES = {
    'Dateline Standard Time': 'Etc/GMT+12',
    'Hawaiian Standard Time': 'Pacific/Honolulu',
    'Alaskan Standard Time': 'America/Anchorage',
    'Pacific Standard Time': 'America/Los_Angeles',
    'US Mountain Standard Time': 'America/Phoenix',
    'Mountain Standard Time': 'America/Denver',
    'Central Standard Time': 'America/Chicago',
    'Central Standard Time (Mexico)': 'America/Mexico_City',
    'Canada Central Standard Time': 'America/Regina',
    'Eastern Standard Time': 'America/New_York',
    'SA Pacific Standard Time': 'America/Bogota',
    'Atlantic Standard Time': 'America/Halifax',
    'Newfoundland Standard Time': 'America/St_Johns',
    'E. South America Standard Time': 'America/Sao_Paulo',
    'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
    'UTC': 'UTC',
    'Coordinated Universal Time': 'UTC',
    'GMT Standard Time': 'Europe/London',
    'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'W. Europe Standard Time': 'Europe/Berlin',
    'Central Europe Standard Time': 'Europe/Budapest',
    'Central European Standard Time': 'Europe/Warsaw',
    'Romance Standard Time': 'Europe/Paris',
    'W. Central Africa Standard Time': 'Africa/Lagos',
    'GTB Standard Time': 'Europe/Bucharest',
    'E. Europe Standard Time': 'Europe/Chisinau',
    'FLE Standard Time': 'Europe/Kiev',
    'Egypt Standard Time': 'Africa/Cairo',
    'South Africa Standard Time': 'Africa/Johannesburg',
    'Israel Standard Time': 'Asia/Jerusalem',
    'Turkey Standard Time': 'Europe/Istanbul',
    'Russian Standard Time': 'Europe/Moscow',
    'E. Africa Standard Time': 'Africa/Nairobi',
    'Arab Standard Time': 'Asia/Riyadh',
    'Arabian Standard Time': 'Asia/Dubai',
    'Pakistan Standard Time': 'Asia/Karachi',
    'India Standard Time': 'Asia/Kolkata',
    'Bangladesh Standard Time': 'Asia/Dhaka',
    'SE Asia Standard Time': 'Asia/Bangkok',
    'China Standard Time': 'Asia/Shanghai',
    'Singapore Standard Time': 'Asia/Singapore',
    'Taipei Standard Time': 'Asia/Taipei',
    'W. Australia Standard Time': 'Australia/Perth',
    'Tokyo Standard Time': 'Asia/Tokyo',
    'Korea Standard Time': 'Asia/Seoul',
    'Cen. Australia Standard Time': 'Australia/Adelaide',
    'E. Australia Standard Time': 'Australia/Brisbane',
    'AUS Eastern Standard Time': 'Australia/Sydney',
    'New Zealand Standard Time': 'Pacific/Auckland',
  };

  function unfold(text) {
    return String(text || '')
      .replace(/^﻿/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n[ \t]/g, '');
  }

  function unescapeText(v) {
    return String(v || '').replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
  }

  // NAME;P1=V1;P2="a:b":VALUE → { name, params, value }
  function parseLine(line) {
    let inQuote = false;
    let colon = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inQuote = !inQuote;
      else if (line[i] === ':' && !inQuote) {
        colon = i;
        break;
      }
    }
    if (colon < 0) return null;
    const head = line.slice(0, colon);
    const value = line.slice(colon + 1);
    const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [];
    const name = (parts.shift() || '').toUpperCase();
    const params = {};
    for (const p of parts) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    return { name, params, value };
  }

  const fmtCache = {};
  function zoneOffset(utcMs, tz) {
    const f = (fmtCache[tz] ||= new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - utcMs;
  }

  function validZone(tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }

  // A wall-clock time in an IANA zone → UTC milliseconds (DST-aware).
  function zonedToUtc(f, tz) {
    const guess = Date.UTC(f.y, f.mo, f.d, f.h, f.mi, f.s);
    const off = zoneOffset(guess, tz);
    let utc = guess - off;
    const off2 = zoneOffset(utc, tz);
    if (off2 !== off) utc = guess - off2;
    return utc;
  }

  function offsetMinutes(s) {
    const m = /([+-])(\d{2}):?(\d{2})/.exec(s || '');
    return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
  }

  // How to read a TZID: an IANA zone, or a fixed offset (exact when the file's
  // VTIMEZONE has no daylight rule, otherwise approximate).
  function resolveZone(tzid, vtimezones) {
    if (!tzid) return null;
    const name = tzid.replace(/^"|"$/g, '').trim();
    if (WINDOWS_ZONES[name]) return { iana: WINDOWS_ZONES[name] };
    const iana = /([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)\s*$/.exec(name)?.[1];
    if (iana && validZone(iana)) return { iana };
    if (validZone(name)) return { iana: name };
    const vt = vtimezones[name];
    if (vt && vt.standard != null) return { fixed: vt.standard, approximate: vt.daylight != null && vt.daylight !== vt.standard };
    const utcLabel = /\(UTC([+-]\d{2}:\d{2})\)/.exec(name);
    if (utcLabel) return { fixed: offsetMinutes(utcLabel[1]), approximate: true };
    return { unknown: true };
  }

  // DTSTART/DTEND value → { ms, allDay, approximate }
  function parseDate(prop, vtimezones) {
    if (!prop) return null;
    const v = prop.value.trim();
    const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
    if (d) return { ms: new Date(+d[1], +d[2] - 1, +d[3]).getTime(), allDay: true, approximate: false };
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v);
    if (!m) return null;
    const f = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
    if (m[7]) return { ms: Date.UTC(f.y, f.mo, f.d, f.h, f.mi, f.s), allDay: false, approximate: false };
    const zone = resolveZone(prop.params.TZID, vtimezones);
    if (zone?.iana) return { ms: zonedToUtc(f, zone.iana), allDay: false, approximate: false, zone: zone.iana };
    if (zone?.fixed != null) return { ms: Date.UTC(f.y, f.mo, f.d, f.h, f.mi, f.s) - zone.fixed * 60000, allDay: false, approximate: zone.approximate };
    // Floating time (no zone) or a zone we can't read: this computer's time.
    return { ms: new Date(f.y, f.mo, f.d, f.h, f.mi, f.s).getTime(), allDay: false, approximate: Boolean(zone?.unknown) };
  }

  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || '').trim());
    if (!m) return 0;
    const ms = (((+m[2] || 0) * 7 + (+m[3] || 0)) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return m[1] === '-' ? -ms : ms;
  }

  function person(prop) {
    if (!prop) return null;
    const email = /mailto:([^\s>]+)/i.exec(prop.value)?.[1]?.toLowerCase() || '';
    const name = (prop.params.CN || '').replace(/^"|"$/g, '').trim();
    if (!email && !name) return null;
    return { name: name && name.toLowerCase() !== email ? name : '', email };
  }

  const MEETING_HOSTS = /(?:^|\.)(zoom\.us|zoomgov\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|whereby\.com|chime\.aws|gotomeeting\.com|bluejeans\.com|meet\.jit\.si|around\.co)$/i;
  function meetingLink(...texts) {
    const urls = [];
    for (const t of texts) for (const u of String(t || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || []) urls.push(u.replace(/[.,;]+$/, ''));
    const host = (u) => {
      try {
        return new URL(u).hostname;
      } catch {
        return '';
      }
    };
    return urls.find((u) => MEETING_HOSTS.test(host(u))) || '';
  }

  const INTERVIEW = /\b(interview(?:s|ing)?|phone screen|screening call|recruiter (?:call|screen|chat)|hiring manager|on-?site|technical (?:round|screen|assessment|interview)|coding (?:round|challenge|interview)|panel|final round|take[- ]home|system design|behaviou?ral|meet the team|culture (?:fit|chat))\b/i;

  // parseIcs(text) → { method, events: [...] }
  function parseIcs(text) {
    const lines = unfold(text).split('\n');
    const vtimezones = {};
    const raw = [];
    let method = '';
    const stack = [];
    let cur = null;
    let tz = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const p = parseLine(line);
      if (!p) continue;
      if (p.name === 'BEGIN') {
        const comp = p.value.trim().toUpperCase();
        stack.push(comp);
        if (comp === 'VEVENT') cur = { props: {}, attendees: [] };
        if (comp === 'VTIMEZONE') tz = { id: '', standard: null, daylight: null };
        continue;
      }
      if (p.name === 'END') {
        const comp = stack.pop();
        if (comp === 'VEVENT' && cur) raw.push(cur), (cur = null);
        if (comp === 'VTIMEZONE' && tz) (tz.id && (vtimezones[tz.id] = tz)), (tz = null);
        continue;
      }
      const top = stack[stack.length - 1];
      if (top === 'VCALENDAR' && p.name === 'METHOD') method = p.value.trim().toUpperCase();
      if (tz && top === 'VTIMEZONE' && p.name === 'TZID') tz.id = p.value.trim();
      if (tz && (top === 'STANDARD' || top === 'DAYLIGHT') && p.name === 'TZOFFSETTO') {
        const off = offsetMinutes(p.value);
        if (top === 'STANDARD' && tz.standard == null) tz.standard = off;
        if (top === 'DAYLIGHT' && tz.daylight == null) tz.daylight = off;
      }
      if (cur && top === 'VEVENT') {
        if (p.name === 'ATTENDEE') cur.attendees.push(p);
        else if (!cur.props[p.name]) cur.props[p.name] = p;
      }
    }

    const events = [];
    for (const r of raw) {
      const P = r.props;
      const start = parseDate(P.DTSTART, vtimezones);
      if (!start) continue;
      const endDate = parseDate(P.DTEND, vtimezones);
      const end = endDate ? endDate.ms : start.ms + (P.DURATION ? parseDuration(P.DURATION.value) : start.allDay ? 86400000 : 3600000);
      const title = unescapeText(P.SUMMARY?.value).replace(/\s+/g, ' ').trim() || '(no title)';
      const description = unescapeText(P.DESCRIPTION?.value).trim().slice(0, 4000);
      const location = unescapeText(P.LOCATION?.value).replace(/\s+/g, ' ').trim().slice(0, 500);
      const url = P.URL?.value?.trim() || '';
      const organizer = person(P.ORGANIZER);
      const attendees = r.attendees.map(person).filter(Boolean).slice(0, 20);
      const status = (P.STATUS?.value || '').trim().toUpperCase();
      events.push({
        uid: P.UID?.value?.trim() || `${start.ms}-${title}`,
        title,
        start: start.ms,
        end,
        allDay: start.allDay,
        approximateTime: start.approximate,
        zone: start.zone || null,
        location,
        link: meetingLink(location, url, description),
        organizer,
        attendees,
        description,
        cancelled: method === 'CANCEL' || status === 'CANCELLED',
        recurring: Boolean(P.RRULE),
        isInterview: INTERVIEW.test(title) || INTERVIEW.test(description.slice(0, 1500)),
      });
    }
    return { method, events };
  }

  // ---------- matching events to jobs ----------

  const GENERIC_DOMAINS = /^(gmail|googlemail|google|outlook|hotmail|live|msn|yahoo|icloud|me|mac|aol|proton|protonmail|gmx|mail|zoho|yandex|greenhouse|lever|ashbyhq|calendly|goodtime|workday|myworkday|icims|smartrecruiters|jobvite|teamtailor|recruitee|workable|bamboohr|zoom|resource|calendar|group|example)$/i;

  const compact = (s) => String(s || '').toLowerCase().replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|bv|group|technologies|technology|labs)\b\.?/g, '').replace(/[^a-z0-9]/g, '');

  function domainLabel(email) {
    const host = String(email || '').split('@')[1] || '';
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return '';
    const label = parts.length > 2 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) ? parts[parts.length - 3] : parts[parts.length - 2];
    return GENERIC_DOMAINS.test(label) ? '' : label.toLowerCase();
  }

  // Best job for an event, by company name in the title/description and by the
  // organizer's and attendees' email domains. → { jobId, score } or null
  function matchJob(event, jobs) {
    let best = null;
    const people = [event.organizer, ...(event.attendees || [])].filter(Boolean);
    for (const j of jobs || []) {
      const c = compact(j.company);
      if (c.length < 2) continue;
      // The name without "Inc", "Ltd" and the like, so "Contoso Ltd" matches "Contoso".
      const words =
        String(j.company)
          .toLowerCase()
          .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|gmbh|plc|sa|ag|bv)\b\.?/g, ' ')
          .replace(/[^a-z0-9& ]/g, ' ')
          .trim() || String(j.company).toLowerCase().trim();
      const re = new RegExp(`\\b${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\b`, 'i');
      let score = 0;
      if (re.test(event.title)) score += 3;
      else if (re.test(event.description) || re.test(event.location)) score += 2;
      if (people.some((p) => domainLabel(p.email) && (domainLabel(p.email) === c || (c.length >= 4 && domainLabel(p.email).startsWith(c))))) score += 3;
      if (score >= 2 && (!best || score > best.score)) best = { jobId: j.id, score };
    }
    return best;
  }

  const titleCase = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // Company and role for a new job, from the title or the organizer's domain.
  function guessJob(event) {
    const t = event.title;
    let company = '';
    let role = '';
    let m = /\binterview(?:ing)?\s+(?:with|at)\s+(.+?)(?:\s+(?:for|[-–—|:(])|$)/i.exec(t);
    if (m) company = m[1];
    if (!company && (m = /^(.+?)\s*(?:[-–—|:]|<>|x)\s*.*\b(interview|screen|round|chat|call)\b/i.exec(t))) company = m[1];
    if ((m = /\bfor\s+(?:the\s+)?(.+?)(?:\s+(?:role|position))?(?:\s*[-–—|(]|$)/i.exec(t))) role = m[1];
    if (!company) {
      const label = [event.organizer, ...(event.attendees || [])].map((p) => p && domainLabel(p.email)).find(Boolean);
      if (label) company = titleCase(label);
    }
    company = company.replace(/\b(phone|technical|final|onsite|on-site|recruiter|hiring manager)\b.*$/i, '').trim();
    return { company: company.slice(0, 200), role: role.trim().slice(0, 200) };
  }

  // The list the user reviews: recent and upcoming events, interviews and
  // matched events first, each with a suggested action:
  //   update (set the interview on a job), new (create a job), clear (a
  //   cancelled interview that is on a job), skip.
  function planImport(events, jobs, now = Date.now()) {
    const recent = events.filter((e) => e.end >= now - 7 * 86400000);
    const items = recent.map((event) => {
      const match = matchJob(event, jobs);
      const job = match && jobs.find((j) => j.id === match.jobId);
      let action = 'skip';
      if (event.cancelled) action = job && job.interviewAt === event.start ? 'clear' : 'skip';
      else if (job) action = 'update';
      else if (event.isInterview) action = 'new';
      return { event, action, jobId: job ? job.id : null, guess: guessJob(event) };
    });
    const rank = (i) => (i.action === 'skip' ? 1 : 0);
    return items.sort((a, b) => rank(a) - rank(b) || a.event.start - b.event.start).slice(0, 50);
  }

  // Contact lines ("Name, email") for the people on the invite.
  function contactLines(event) {
    const seen = new Set();
    const out = [];
    for (const p of [event.organizer, ...(event.attendees || [])]) {
      if (!p || !p.email || seen.has(p.email) || /calendar|noreply|no-reply|resource/i.test(p.email)) continue;
      seen.add(p.email);
      out.push([p.name, p.email].filter(Boolean).join(', '));
    }
    return out.slice(0, 10);
  }

  return { parseIcs, planImport, matchJob, guessJob, contactLines, meetingLink, zonedToUtc, resolveZone, parseDuration, WINDOWS_ZONES };
});
