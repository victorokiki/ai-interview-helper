// Question detection and "is this still the same question?" matching.
// Shared by the desktop renderer, the future server/web/mobile apps and tests.
// Plain JS, no dependencies; loads as CommonJS or as a browser global (CoreQuestion).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreQuestion = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const QUESTION_RE =
    /\?\s*$|^(so,?\s+|and,?\s+|okay,?\s+|now,?\s+)?(what|why|how|when|where|who|which|can|could|would|will|do|does|did|is|are|have|has|should|tell me|walk me|describe|explain|give me|talk (me )?(about|through)|share|imagine|suppose)\b/i;

  // Words that carry no meaning for "did the question change?": fillers and
  // small function words that speech recognition often adds, drops or merges
  // ("what's" vs "what is").
  const IGNORE = new Set([
    'um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'so', 'okay', 'ok', 'well', 'like', 'right', 'yeah', 'yes',
    'and', 'you', 'know', 'is', 'are', 'am', 'was', 'were', 'be', 'do', 'does', 'did', 'the', 'a', 'an', 'to', 'of', 'that',
    'it', 'just', 'kind', 'sort', 'maybe', 'actually', 'basically', 'now', 'then',
  ]);

  function words(text) {
    return (
      String(text || '')
        .toLowerCase()
        .replace(/[‘’]/g, "'")
        .replace(/n't\b/g, ' not')
        .replace(/'(s|re|ve|ll|d|m)\b/g, '')
        .match(/[a-z0-9]+/g) || []
    );
  }

  function looksLikeQuestion(text) {
    const t = String(text || '').trim();
    return words(t).length >= 4 && (QUESTION_RE.test(t) || /\?/.test(t));
  }

  function contentWords(text) {
    return words(text).filter((w) => !IGNORE.has(w));
  }

  // True when `final` asks the same thing as `draft`. Speech-recognition
  // wobble is tolerated (a word swapped or dropped: about 10% on long
  // questions), but any net new content ("...that was failing?") means the
  // question changed and the answer must be redone.
  function sameQuestion(draft, final) {
    const a = contentWords(draft);
    const b = contentWords(final);
    if (!a.length || !b.length) return false;
    const setA = new Set(a);
    const setB = new Set(b);
    const added = [...setB].filter((w) => !setA.has(w)).length;
    const removed = [...setA].filter((w) => !setB.has(w)).length;
    const tolerance = Math.max(1, Math.floor(Math.max(setA.size, setB.size) * 0.1));
    return added <= tolerance && removed <= tolerance && added <= removed;
  }

  // Number of meaningful words in `later` that `earlier` does not contain.
  function newContentWords(earlier, later) {
    const seen = new Set(contentWords(earlier));
    return contentWords(later).filter((w) => !seen.has(w)).length;
  }

  // Rough question type, used to give the answer the right structure.
  // Checked in order; the first match wins.
  const TYPES = [
    ['salary', /\b(salary|compensation|pay range|expected pay|expectations? (for|on) (pay|salary)|offer|equity|bonus|notice period)\b/i],
    ['behavioral', /\b(tell me about a time|describe a (time|situation)|give (me )?an example|when (have|did) you|have you ever|conflict|disagree(d)?|a (failure|mistake)|challenge you faced|proud of|difficult (stakeholder|colleague|situation))\b/i],
    ['coding', /\b(algorithm|big o|time complexity|implement (a|an|the)|write (a|an|the)? ?(function|program|query|code)|linked list|binary (tree|search)|reverse (a|the) (string|list)|two sum|leetcode)\b/i],
    ['system-design', /\b(design (a|an|the)|architect|how would you (build|scale)|scal(e|ing) (to|for)|requests per second|rate limiter|url shortener|distributed|high availability|throughput)\b/i],
    ['motivation', /\b(why (do you want|are you interested|this (role|company)|our company|us)|why are you leaving|tell me about yourself|walk me through your (resume|background|cv)|where do you see yourself|(your )?(greatest |biggest )?(strengths?|weakness(es)?))\b/i],
    ['technical', /\b(difference between|what is (a|an|the)|explain|how does|how do .+ work|when would you use|pros and cons|trade-?offs?)\b/i],
  ];

  function questionType(text) {
    const t = String(text || '');
    for (const [type, re] of TYPES) if (re.test(t)) return type;
    return 'general';
  }

  return { looksLikeQuestion, sameQuestion, newContentWords, contentWords, words, questionType };
});
