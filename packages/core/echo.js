// Echo filter for setups without headphones: the microphone also picks up
// the interviewer playing from the speakers, so the same words arrive on both
// channels and appear twice, attributed to "Me". True acoustic echo
// cancellation (WebRTC AEC3 with the call audio as reference) is planned; this
// removes the visible symptom at the text level, cheaply and on every engine.
//
// A mic utterance counts as echo when it overlaps in time with an interviewer
// utterance AND most of its words appear in it. Repeating the question back
// later ("So you're asking how I'd scale it...") doesn't overlap in time and
// adds words, so it is kept.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./question') : root.CoreQuestion);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreEcho = api;
})(typeof self !== 'undefined' ? self : this, function (Q) {
  const DEFAULTS = { minWords: 3, overlapRatio: 0.7, slackMs: 1500 };

  // Fraction of the mic utterance's words found in the interviewer's text.
  function wordOverlap(meText, themText) {
    const me = Q.words(meText);
    if (!me.length) return 0;
    const them = new Set(Q.words(themText));
    return me.filter((w) => them.has(w)).length / me.length;
  }

  // Time ranges [startedAt, t] overlap, allowing for engine timing slack.
  function overlapsInTime(me, them, slackMs) {
    const meStart = me.startedAt || me.t;
    const themStart = them.startedAt || them.t;
    return meStart <= them.t + slackMs && me.t >= themStart - slackMs;
  }

  function isEcho(me, them, options = {}) {
    const o = { ...DEFAULTS, ...options };
    if (Q.words(me.text).length < o.minWords) return false;
    return overlapsInTime(me, them, o.slackMs) && wordOverlap(me.text, them.text) >= o.overlapRatio;
  }

  return { isEcho, wordOverlap, overlapsInTime, DEFAULTS };
});
