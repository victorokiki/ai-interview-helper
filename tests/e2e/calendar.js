// End-to-end test of calendar invite import: an .ics file through the file
// picker, the review list (match, new job, cancelled, skip), applying it to
// jobs, re-importing without duplicates, dropping a file on the Jobs tab, the
// meeting link in the job editor, and interview reminders (day before and
// 30 minutes before, with Join meeting).
const electron = require('electron');
const { app, dialog } = electron;
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'out', 'calendar');
fs.rmSync(out, { recursive: true, force: true });
const userData = path.join(out, 'userdata');
fs.mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);

const DAY = 86400000;
const now = Date.now();
const round = (ms) => Math.floor(ms / 3600000) * 3600000;
const contosoAt = round(now + 10 * DAY); // given as New York wall time in the file
const northwindAt = round(now + 12 * DAY);
const fabrikamAt = round(now + 5 * DAY);
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function nyStamp(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}T${p.hour}${p.minute}${p.second}`;
}
const ICS = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'UID:contoso-1',
  `DTSTART;TZID=America/New_York:${nyStamp(contosoAt)}`,
  'DURATION:PT1H',
  'SUMMARY:Technical Interview: Contoso <> Jordan',
  'ORGANIZER;CN="Sam Lee":mailto:sam.lee@contoso.com',
  'ATTENDEE;CN="Priya Rao":mailto:priya@contoso.com',
  'DESCRIPTION:Join: https://meet.google.com/abc-defg-hij\\nSystem design and coding.',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:northwind-1',
  `DTSTART:${utcStamp(northwindAt)}`,
  `DTEND:${utcStamp(northwindAt + 1800000)}`,
  'SUMMARY:Interview with Northwind',
  'ORGANIZER;CN=Recruiting:mailto:talent@northwind.com',
  'LOCATION:https://northwind.zoom.us/j/999',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:fabrikam-1',
  `DTSTART:${utcStamp(fabrikamAt)}`,
  'SUMMARY:Fabrikam interview',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:dentist',
  `DTSTART:${utcStamp(round(now + 2 * DAY))}`,
  'SUMMARY:Dentist',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');
const icsPath = path.join(out, 'invites.ics');
fs.writeFileSync(icsPath, ICS);

// The file picker returns our file.
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [icsPath] });

fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ provider: 'ollama', ollamaUrl: 'http://127.0.0.1:9', transcription: 'local', jobsMigrated: true, liveNoticeAck: true, meetingDetection: false, activeJobId: 'j1' }));
fs.writeFileSync(
  path.join(userData, 'jobs.json'),
  JSON.stringify([
    { id: 'j1', company: 'Contoso Ltd', role: 'SRE', stage: 'applied', contacts: 'Sam Lee, sam.lee@contoso.com', notes: 'Referred by Kim.' },
    { id: 'j2', company: 'Fabrikam', role: 'PM', stage: 'interviewing', interviewAt: fabrikamAt, notes: '' },
  ]),
);
require(path.join(__dirname, '..', '..', 'src', 'main.js'));

const logs = [];
const check = (name, ok, extra = '') => {
  logs.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`);
  fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
};
const readJobs = () => JSON.parse(fs.readFileSync(path.join(userData, 'jobs.json'), 'utf8'));

let started = false;
app.on('browser-window-created', (_e, win) => {
  if (started) return;
  started = true;
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') logs.push(`[console error] ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (code, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await js(code)) return true;
        await wait(50);
      }
      return false;
    };
    try {
      await wait(1000);
      // 1. Pick the file: the review list.
      await js(`document.querySelector('.tab[data-tab="jobs"]').click(); 0`);
      await until(`document.querySelectorAll('#jobList li').length === 2`);
      await js(`document.querySelector('#importInvite').click(); 0`);
      await until(`!document.querySelector('#calendarReview').hidden`);
      const rows = await js(`[...document.querySelectorAll('#calendarList li')].map((li) => [li.querySelector('.cal-title').textContent.trim(), li.querySelector('select').value, li.querySelector('.meta').textContent])`);
      check('review lists the invites in order with suggested actions', JSON.stringify(rows.map((r) => r[1])) === JSON.stringify(['clear:j2', 'update:j1', 'new', 'skip']) && /Cancelled/.test(rows[0][0]) && /Dentist/.test(rows[3][0]), JSON.stringify(rows.map((r) => r.slice(0, 2))));
      check('rows show organizer and meeting link host', /from Sam Lee/.test(rows[1][2]) && /meet\.google\.com link/.test(rows[1][2]) && /northwind\.zoom\.us link/.test(rows[2][2]));
      const guess = await js(`[...document.querySelectorAll('#calendarList li')][2].querySelector('[data-f="company"]').value`);
      check('new-job fields appear with the guessed company', guess === 'Northwind' && !(await js(`[...document.querySelectorAll('#calendarList li')][2].querySelector('.cal-new').hidden`)));
      check('nothing changed before Import', readJobs()[0].interviewAt == null);
      await js(`[...document.querySelectorAll('#calendarList li')][2].querySelector('[data-f="role"]').value = 'Data Engineer'; 0`);
      fs.writeFileSync(path.join(out, 'review.png'), (await win.webContents.capturePage()).toPNG());

      // 2. Import.
      await js(`document.querySelector('#calendarApply').click(); 0`);
      await until(`/Calendar import:/.test(document.querySelector('#banner').textContent)`);
      check('banner summarises the import', (await js(`document.querySelector('#banner').textContent`)).includes('updated 1 job, added 1 new job, removed 1 cancelled interview'));
      const [j1, j2, nw] = readJobs();
      check('matched job: interview time (New York → UTC), link, stage', j1.interviewAt === contosoAt && j1.interviewLink === 'https://meet.google.com/abc-defg-hij' && j1.stage === 'interviewing', `${j1.interviewAt} vs ${contosoAt}`);
      check('matched job: new contact added, existing one not repeated, note added', j1.contacts === 'Sam Lee, sam.lee@contoso.com\nPriya Rao, priya@contoso.com' && /^Referred by Kim\.\nCalendar: Technical Interview: Contoso <> Jordan \(/.test(j1.notes), JSON.stringify([j1.contacts, j1.notes]));
      check('cancelled interview removed from its job with a note', j2.interviewAt === null && /^Cancelled: Fabrikam interview/.test(j2.notes));
      check('new job created from the invite', nw.company === 'Northwind' && nw.role === 'Data Engineer' && nw.interviewAt === northwindAt && nw.interviewLink === 'https://northwind.zoom.us/j/999' && nw.contacts === 'Recruiting, talent@northwind.com' && nw.stage === 'interviewing');

      // 3. Re-importing the same invite doesn't duplicate notes or contacts.
      const again = await js(`window.api.calendarPick()`);
      await js(`window.api.calendarApply(${JSON.stringify([{ event: again.items.find((i) => i.event.uid === 'contoso-1').event, action: 'update', jobId: 'j1' }])})`);
      const j1b = readJobs()[0];
      check('re-import keeps notes and contacts as they were', j1b.notes === j1.notes && j1b.contacts === j1.contacts);

      // 4. Drop a file on the Jobs tab.
      await js(`(() => {
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(ICS)}], 'invite.ics', { type: 'text/calendar' }));
        document.querySelector('#tab-jobs').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      })(); 0`);
      await until(`!document.querySelector('#calendarReview').hidden && document.querySelectorAll('#calendarList li').length === 4`);
      const dropped = await js(`[...document.querySelectorAll('#calendarList select')].map((s) => s.value)`);
      check('dropped .ics opens the review; now matches the jobs it created', dropped.includes('update:j1') && dropped.some((v) => v.startsWith('update:') && v !== 'update:j1'), JSON.stringify(dropped));
      await js(`document.querySelector('#calendarCancel').click(); 0`);
      await js(`(() => {
        const dt = new DataTransfer();
        dt.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
        document.querySelector('#tab-jobs').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      })(); 0`);
      await until(`/Drop a calendar invite/.test(document.querySelector('#banner').textContent)`);
      check('other files are refused politely', true);

      // 5. Job editor shows the meeting link.
      await js(`[...document.querySelectorAll('#jobList li')].find((li) => li.textContent.includes('Contoso')).click(); 0`);
      await until(`!document.querySelector('#jobForm').hidden`);
      check('job editor has the meeting link with Join', (await js(`document.querySelector('#jobInterviewLink').value`)) === 'https://meet.google.com/abc-defg-hij' && !(await js(`document.querySelector('#joinMeeting').hidden`)));
      await js(`document.querySelector('#jobForm').requestSubmit(); 0`);
      await wait(300);
      check('saving the form keeps the meeting link', readJobs()[0].interviewLink === 'https://meet.google.com/abc-defg-hij');

      // 6. Interview reminders.
      await js(`window.api.saveJob({ ...${JSON.stringify(readJobs()[0])}, interviewAt: Date.now() + 20 * 3600000 }).then(() => window.api.checkReminders())`);
      await until(`/Interview with Contoso Ltd — SRE (today|tomorrow) at/.test(document.querySelector('#banner').textContent)`);
      check('day-before reminder', /A quick practice round now helps/.test(await js(`document.querySelector('#banner').textContent`)) && (await js(`document.querySelector('#banner button').textContent`)) === 'Open job');
      check('it fires once', (await js('window.api.checkReminders()')).length === 0);
      await js(`window.api.saveJob({ ...${JSON.stringify(readJobs()[0])}, interviewAt: Date.now() + 20 * 60000 }).then(() => window.api.checkReminders())`);
      await until(`/interview starts at/.test(document.querySelector('#banner').textContent)`);
      check('30-minute reminder offers Join meeting', (await js(`document.querySelector('#banner button').textContent`)) === 'Join meeting');
      const r = readJobs()[0];
      check('both interview reminders marked', !!r.interviewSoonNotifiedAt && !!r.interviewNotifiedAt && (await js('window.api.checkReminders()')).length === 0);
      fs.writeFileSync(path.join(out, 'reminder.png'), (await win.webContents.capturePage()).toPNG());
    } catch (err) {
      logs.push('[e2e-error] ' + err.stack);
    }
    fs.writeFileSync(path.join(out, 'log.txt'), logs.join(String.fromCharCode(10)));
    app.exit(0);
  });
});
