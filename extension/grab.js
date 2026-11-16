// Runs in the job page only when the user clicks the extension button
// (activeTab). Collects what the popup needs to fill in the job; the value of
// the last expression is returned to the popup. Reads, never changes, the page.
(() => {
  const meta = (key) => document.querySelector(`meta[property="${key}"], meta[name="${key}"]`)?.content || '';
  const main = document.querySelector('main, article, [role="main"]') || document.body;
  return {
    url: location.href,
    title: document.title,
    ogTitle: meta('og:title'),
    siteName: meta('og:site_name'),
    h1: document.querySelector('h1')?.innerText || '',
    jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20).map((s) => s.textContent.slice(0, 300000)),
    selection: String(window.getSelection() || '').slice(0, 60000),
    text: (main?.innerText || '').slice(0, 60000),
  };
})();
