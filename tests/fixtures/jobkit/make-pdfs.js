// Rebuilds the PDF files of the job-kit test fixture (a fictional candidate
// from the Autonomous Job Kit's own example profile). Run with:
//   npx electron tests/fixtures/jobkit/make-pdfs.js
// tracker.xlsx in the fixture was made with the kit's own tracker.py
// (add/update), so it has the exact layout the kit writes.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const apps = path.join(__dirname, 'job-search', 'Applications');
const NORTHWIND = path.join(apps, '2026-11-02 Northwind Freight - Junior Data Analyst');
const BLUEWATER = path.join(apps, '2026-11-05 Bluewater Bank - Reporting Analyst');

const page = (body) => `<!doctype html><meta charset="utf-8"><style>body{font:11pt Arial,sans-serif;margin:40px}h1{font-size:18pt;margin:0}h2{font-size:12pt;margin:14px 0 4px;border-bottom:1px solid #999}li{margin:2px 0}</style>${body}`;

const resume = (firstBullet) =>
  page(`<h1>Alex Morgan Tremblay</h1><div>Halifax, NS · alex.tremblay@example.com</div>
<h2>Experience</h2>
<b>Data Analyst</b>, Harbourline Logistics, Halifax, NS (Jun 2024 to Present)
<ul><li>${firstBullet}</li><li>Reduced duplicate customer records by 18% by writing validation rules for a 120,000-row CRM migration.</li></ul>
<b>Operations Assistant</b>, Bluenose Outfitters, Dartmouth, NS (Sep 2022 to May 2024)
<ul><li>Reconciled point-of-sale and stock counts for 900+ products each month.</li></ul>
<h2>Education</h2>Bachelor of Commerce, Business Analytics, Atlantic Coast University (2019 to 2023)
<h2>Skills</h2>Power BI, SQL, Python, Excel, Git, Salesforce`);

const FILES = [
  [path.join(NORTHWIND, 'Alex_Tremblay_Resume_Northwind.pdf'), resume('Cut weekly shipment reporting from 6 hours to 40 minutes by automating data pulls with Python and SQL, feeding Power BI dashboards.')],
  [
    path.join(NORTHWIND, 'Alex_Tremblay_Cover_Letter_Northwind.pdf'),
    page(`<p>Dear Northwind Freight hiring team,</p><p>I am applying for the Junior Data Analyst role. At Harbourline Logistics I cut weekly shipment reporting from 6 hours to 40 minutes by automating data pulls with Python and SQL.</p><p>Sincerely,<br>Alex Tremblay</p>`),
  ],
  [path.join(BLUEWATER, 'Alex_Tremblay_Resume_Bluewater.pdf'), resume('Built weekly reports in Excel and Power BI from automated Python and SQL data pulls, cutting reporting from 6 hours to 40 minutes.')],
];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  for (const [file, html] of FILES) {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    fs.writeFileSync(file, await win.webContents.printToPDF({ pageSize: 'Letter' }));
    console.log('wrote', path.relative(__dirname, file));
  }
  app.exit(0);
});
