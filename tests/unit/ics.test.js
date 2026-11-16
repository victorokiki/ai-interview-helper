// Calendar invites: parsing (folding, escaping, quoted params), time zones
// (UTC, IANA with DST, Windows names, VTIMEZONE offsets, floating), meeting
// links, interview detection, job matching and the import plan.
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../../packages/core/ics');

const CRLF = (s) => s.trim().split('\n').map((l) => l.replace(/^\s{4}/, '')).join('\r\n');

// Shaped like a Google Calendar invite.
const GOOGLE = CRLF(`
    BEGIN:VCALENDAR
    PRODID:-//Google Inc//Google Calendar 70.9054//EN
    METHOD:REQUEST
    BEGIN:VEVENT
    DTSTART;TZID=America/New_York:20261203T100000
    DTEND;TZID=America/New_York:20261203T110000
    UID:abc123@google.com
    ORGANIZER;CN="Sam Lee":mailto:sam.lee@contoso.com
    ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;CN=Jordan Lee:mailto:jordan@example.com
    ATTENDEE;CN="Priya Rao, Staff Engineer":mailto:priya@contoso.com
    SUMMARY:Technical Interview: Contoso <> Jordan Lee
    DESCRIPTION:Hi Jordan\\, looking forward to it!\\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\\n\\nAgenda: system design
     \\; coding.
    LOCATION:
    STATUS:CONFIRMED
    BEGIN:VALARM
    ACTION:DISPLAY
    DESCRIPTION:This is an event reminder
    END:VALARM
    END:VEVENT
    END:VCALENDAR`);

test('Google-style invite: fields, folding, escaping, IANA zone', () => {
  const { method, events } = I.parseIcs(GOOGLE);
  assert.equal(method, 'REQUEST');
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.title, 'Technical Interview: Contoso <> Jordan Lee');
  assert.equal(e.start, Date.UTC(2026, 11, 3, 15, 0)); // 10:00 EST = 15:00 UTC
  assert.equal(e.end - e.start, 3600000);
  assert.equal(e.description, 'Hi Jordan, looking forward to it!\nJoin with Google Meet: https://meet.google.com/abc-defg-hij\n\nAgenda: system design; coding.', 'VALARM description must not replace the event one');
  assert.equal(e.link, 'https://meet.google.com/abc-defg-hij');
  assert.deepEqual(e.organizer, { name: 'Sam Lee', email: 'sam.lee@contoso.com' });
  assert.deepEqual(e.attendees[1], { name: 'Priya Rao, Staff Engineer', email: 'priya@contoso.com' });
  assert.equal(e.isInterview, true);
  assert.equal(e.cancelled, false);
  assert.equal(e.approximateTime, false);
  assert.deepEqual(I.contactLines(e), ['Sam Lee, sam.lee@contoso.com', 'Jordan Lee, jordan@example.com', 'Priya Rao, Staff Engineer, priya@contoso.com']);
});

test('time zones: DST, Windows names, VTIMEZONE offsets, Outlook labels, UTC, floating, all-day', () => {
  // America/New_York in July is UTC-4.
  assert.equal(I.zonedToUtc({ y: 2026, mo: 6, d: 1, h: 9, mi: 30, s: 0 }, 'America/New_York'), Date.UTC(2026, 6, 1, 13, 30));
  const outlook = CRLF(`
    BEGIN:VCALENDAR
    METHOD:REQUEST
    BEGIN:VTIMEZONE
    TZID:Custom Lagos
    BEGIN:STANDARD
    DTSTART:16010101T000000
    TZOFFSETFROM:+0100
    TZOFFSETTO:+0100
    END:STANDARD
    END:VTIMEZONE
    BEGIN:VEVENT
    SUMMARY:Phone screen
    DTSTART;TZID=W. Central Africa Standard Time:20261210T140000
    DURATION:PT45M
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:Onsite
    DTSTART;TZID=Custom Lagos:20261211T090000
    DTEND;TZID=Custom Lagos:20261211T120000
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:Old Outlook
    DTSTART;TZID="(UTC-05:00) Eastern Time (US & Canada)":20261212T090000
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:UTC
    DTSTART:20261213T080000Z
    DTEND:20261213T083000Z
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:Floating
    DTSTART:20261214T090000
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:All day
    DTSTART;VALUE=DATE:20261215
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:Mozilla path
    DTSTART;TZID=/mozilla.org/20050126_1/Europe/London:20260701T100000
    END:VEVENT
    END:VCALENDAR`);
  const ev = Object.fromEntries(I.parseIcs(outlook).events.map((e) => [e.title, e]));
  assert.equal(ev['Phone screen'].start, Date.UTC(2026, 11, 10, 13, 0));
  assert.equal(ev['Phone screen'].end - ev['Phone screen'].start, 45 * 60000);
  assert.equal(ev.Onsite.start, Date.UTC(2026, 11, 11, 8, 0));
  assert.equal(ev.Onsite.approximateTime, false, 'no daylight rule: the offset is exact');
  assert.equal(ev['Old Outlook'].start, Date.UTC(2026, 11, 12, 14, 0));
  assert.equal(ev['Old Outlook'].approximateTime, true);
  assert.equal(ev.UTC.start, Date.UTC(2026, 11, 13, 8, 0));
  assert.equal(ev.Floating.start, new Date(2026, 11, 14, 9, 0).getTime());
  assert.equal(ev['All day'].allDay, true);
  assert.equal(ev['Mozilla path'].start, Date.UTC(2026, 6, 1, 9, 0), 'BST is UTC+1');
  assert.equal(I.parseDuration('P1DT2H'), 26 * 3600000);
  assert.equal(I.resolveZone('Nowhere/Land', {}).unknown, true);
});

test('meeting links, cancellations and non-interview events', () => {
  assert.equal(I.meetingLink('Room 4', 'Join: https://contoso.zoom.us/j/123456789?pwd=abc.'), 'https://contoso.zoom.us/j/123456789?pwd=abc');
  assert.equal(I.meetingLink('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d'), 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d');
  assert.equal(I.meetingLink('https://evil.example/zoom.us/j/1'), '');
  const cancel = I.parseIcs(CRLF(`
    BEGIN:VCALENDAR
    METHOD:CANCEL
    BEGIN:VEVENT
    SUMMARY:Canceled: Interview with Contoso
    DTSTART:20261203T150000Z
    STATUS:CANCELLED
    END:VEVENT
    BEGIN:VEVENT
    SUMMARY:Dentist
    DTSTART:20261204T150000Z
    RRULE:FREQ=YEARLY
    END:VEVENT
    END:VCALENDAR`)).events;
  assert.equal(cancel[0].cancelled, true);
  assert.equal(cancel[1].isInterview, false);
  assert.equal(cancel[1].recurring, true);
});

test('matching events to jobs and guessing new jobs', () => {
  const jobs = [
    { id: 'j1', company: 'Contoso Ltd', role: 'SRE', interviewAt: null },
    { id: 'j2', company: 'Fabrikam', role: 'PM', interviewAt: Date.UTC(2026, 11, 5, 15) },
    { id: 'j3', company: 'Microsoft', role: 'SWE' },
  ];
  const e = I.parseIcs(GOOGLE).events[0];
  assert.deepEqual(I.matchJob(e, jobs), { jobId: 'j1', score: 6 });
  const byDomain = { title: 'Chat', description: '', location: '', organizer: { email: 'recruiting@fabrikam.co.uk' }, attendees: [] };
  assert.equal(I.matchJob(byDomain, jobs).jobId, 'j2');
  assert.equal(I.matchJob({ title: 'Chat', description: '', location: '', organizer: { email: 'someone@gmail.com' }, attendees: [] }, jobs), null);
  assert.deepEqual(I.guessJob({ title: 'Interview with Northwind for Data Engineer', organizer: null, attendees: [] }), { company: 'Northwind', role: 'Data Engineer' });
  assert.deepEqual(I.guessJob({ title: 'Tailspin Toys - Phone screen', organizer: null, attendees: [] }), { company: 'Tailspin Toys', role: '' });
  assert.deepEqual(I.guessJob({ title: 'Video call', organizer: { email: 'talent@adatum.io' }, attendees: [] }), { company: 'Adatum', role: '' });

  const now = Date.UTC(2026, 10, 15);
  const events = [
    e,
    { ...e, uid: 'x', title: 'Interview with Northwind', organizer: { email: 'hr@northwind.com' }, attendees: [], description: '', start: Date.UTC(2026, 11, 1, 15), end: Date.UTC(2026, 11, 1, 16) },
    { ...e, uid: 'c', title: 'Fabrikam interview', cancelled: true, organizer: null, attendees: [], description: '', start: Date.UTC(2026, 11, 5, 15), end: Date.UTC(2026, 11, 5, 16) },
    { ...e, uid: 'd', title: 'Dentist', isInterview: false, organizer: null, attendees: [], description: '', start: Date.UTC(2026, 10, 20), end: Date.UTC(2026, 10, 20, 1) },
    { ...e, uid: 'old', title: 'Interview long ago', organizer: null, attendees: [], start: Date.UTC(2026, 0, 1), end: Date.UTC(2026, 0, 1, 1) },
  ];
  const plan = I.planImport(events, jobs, now);
  assert.deepEqual(plan.map((p) => [p.event.uid, p.action, p.jobId]), [
    ['x', 'new', null],
    ['abc123@google.com', 'update', 'j1'],
    ['c', 'clear', 'j2'],
    ['d', 'skip', null],
  ]);
  assert.equal(plan[0].guess.company, 'Northwind');
});
