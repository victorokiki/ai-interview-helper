// Speculative answering with corrections.
//
// Answers start as soon as the interviewer has *probably* finished a question
// (an "eager" end-of-turn signal from the transcriber) instead of after the
// final transcript plus a safety wait. When the final transcript arrives:
//   - same question  → the draft is kept (promoted) and keeps streaming;
//   - changed        → the draft is cancelled and a new answer starts on the
//                      full, final question (a correction).
// If the interviewer resumes talking, the draft is cancelled. A follow-up
// sentence shortly after an answer started also triggers a correction. So
// every final answer is generated from the full final question: speed never
// costs answer quality.
//
// Pure state machine (no DOM, no timers): the host passes events in and gets
// start/cancel/promote callbacks. Time is injected for testability.
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./question') : root.CoreQuestion);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CoreSpeculation = api;
})(typeof self !== 'undefined' ? self : this, function (Q) {
  const DEFAULTS = {
    followUpMs: 2500, // a new interviewer sentence this soon after a question extends it
    minNewWordsToCorrect: 3, // ignore "right?" / "okay" style tails
  };

  class SpeculationController {
    constructor(host, options = {}) {
      this.host = host; // { start(question, {draft, corrected}) -> id, cancel(id, reason), promote(id, question), now() }
      this.opt = { ...DEFAULTS, ...options };
      this.pending = []; // finalized interviewer text not yet answered
      this.active = null; // { id, question, draft, startedAt }
      this.committedAt = 0; // when the last final answer started
      this.committedQuestion = '';
      this.stats = { drafts: 0, promoted: 0, cancelledDrafts: 0, corrections: 0, finals: 0 };
    }

    now() {
      return this.host.now ? this.host.now() : Date.now();
    }

    question(extra) {
      return [...this.pending, extra].filter(Boolean).join(' ').trim();
    }

    cancelActive(reason) {
      if (!this.active) return;
      this.host.cancel(this.active.id, reason);
      if (this.active.draft) this.stats.cancelledDrafts++;
      this.active = null;
    }

    // The transcriber thinks the interviewer has probably finished (Deepgram
    // Flux EagerEndOfTurn, a final segment ending in "?", or local silence).
    eager(utteranceText) {
      const q = this.question(utteranceText);
      if (!Q.looksLikeQuestion(q)) return;
      if (this.active && Q.sameQuestion(this.active.question, q)) return; // already on it
      if (this.active && !this.active.draft) return; // a final answer is running; let end() decide
      this.cancelActive('superseded');
      this.active = { id: this.host.start(q, { draft: true }), question: q, draft: true, startedAt: this.now() };
      this.stats.drafts++;
    }

    // The interviewer kept talking after an eager signal.
    resumed() {
      if (this.active?.draft) this.cancelActive('resumed');
    }

    // Final transcript of one interviewer utterance. `startedAt` is when the
    // interviewer began saying it (defaults to now).
    end(utteranceText, startedAt) {
      const began = startedAt || this.now();
      // A follow-up sentence begun right after we started answering: fold it
      // into that question and redo the answer if it adds real content.
      if (!this.pending.length && this.active && !this.active.draft && began - this.committedAt < this.opt.followUpMs) {
        const extended = `${this.committedQuestion} ${utteranceText}`.trim();
        if (Q.newContentWords(this.committedQuestion, extended) >= this.opt.minNewWordsToCorrect) {
          this.cancelActive('follow-up');
          this.startFinal(extended, true);
        }
        return;
      }
      const q = this.question(utteranceText);
      if (this.active?.draft) {
        if (Q.sameQuestion(this.active.question, q)) {
          this.host.promote(this.active.id, q);
          this.active = { ...this.active, question: q, draft: false };
          this.stats.promoted++;
          this.commit(q);
          return;
        }
        this.cancelActive('changed');
        if (Q.looksLikeQuestion(q)) this.startFinal(q, true);
        else this.pending.push(utteranceText);
        return;
      }
      if (Q.looksLikeQuestion(q)) {
        this.cancelActive('new-question');
        this.startFinal(q, false);
      } else {
        this.pending.push(utteranceText); // statement; may become a question with the next sentence
      }
    }

    startFinal(q, corrected) {
      this.active = { id: this.host.start(q, { draft: false, corrected }), question: q, draft: false, startedAt: this.now() };
      this.stats.finals++;
      if (corrected) this.stats.corrections++;
      this.commit(q);
    }

    commit(q) {
      this.pending = [];
      this.committedAt = this.now();
      this.committedQuestion = q;
    }

    // The host's answer stream finished or was stopped by the user.
    finished(id) {
      if (this.active?.id === id && !this.active.draft) this.active = { ...this.active, done: true };
    }

    // Manual "answer now": whatever is pending, no speculation.
    takePending() {
      const q = this.question('');
      this.pending = [];
      return q;
    }

    reset() {
      this.cancelActive('reset');
      this.pending = [];
      this.committedAt = 0;
      this.committedQuestion = '';
    }
  }

  return { SpeculationController, DEFAULTS };
});
