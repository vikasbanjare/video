/*
 * Pulse — repeated-take / bad-take cleanup (fuzzy).
 * Real retakes are rarely word-for-word identical — the speaker rephrases a
 * little (5–15% different). So instead of exact matching we split the transcript
 * into PHRASES (by pauses / sentence punctuation / a change of speaker) and
 * cluster phrases that are SIMILAR (token LCS ratio ≥ threshold), then keep the
 * last COMPLETE take and return the others' time ranges to ripple-delete.
 *
 * Works on every script the owner records in: English, Hinglish written in
 * Latin letters, Hindi in Devanagari, Urdu, and any mix of them (norm() keeps
 * letters, marks and digits of every script — it used to erase everything that
 * was not a–z, so a Devanagari transcript read as "clean").
 *
 * Podcast safety: a guest's answer often repeats the host's question word for
 * word ("aapne pehla business kab start kiya tha?" → "maine pehla business
 * college mein start kiya tha"). A retake is the SAME person going BACK to the
 * start of a line, so two phrases are only linked when:
 *   - they come from the same speaker (whenever speaker labels exist),
 *   - they sit within a short window (phrases AND seconds),
 *   - the later one RESTARTS the earlier one (their openings share a word),
 *   - one is not a question while the other is a finished statement,
 *   - the grammatical person does not flip ("aap/you" ↔ "main/I"), and
 *   - a Hindi question word (kab/kitne/kaun/kyun/kahan) is not answered away.
 *
 * Pure (no DOM/Node) so it's unit-tested and runs anywhere.
 */
(function (root, factory) {
  var lib = factory();
  if (typeof module === 'object' && module.exports) module.exports = lib;
  if (root) root.CPTakes = lib;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  /* Everything that is not a letter, a combining mark (Devanagari matras,
     virama, nukta, anusvara…) or a digit — in ANY script. Built with the
     RegExp constructor inside try/catch: a /\p{…}/u literal is a parse error on
     an engine without Unicode property escapes and would take the whole file
     down; the fallback keeps Latin + Latin-1/Extended, Greek/Cyrillic, Arabic/
     Urdu and all the Indic blocks. */
  var NON_WORD = (function () {
    try { return new RegExp("[^\\p{L}\\p{M}\\p{N}']", 'gu'); }
    catch (e) { return /[^a-z0-9'À-ɏͰ-ӿ؀-ۿݐ-ݿऀ-෿꣠-ꣿ]/g; }
  })();

  /* One comparable token per spoken word: NFC (so a precomposed and a
     decomposed nukta compare equal), Latin case-folded, curly apostrophes
     straightened, punctuation and dandas dropped. Nukta and matras are KEPT —
     stripping them turns different Hindi words into the same one. */
  function norm(w) {
    var s = String(w == null ? '' : w);
    if (s.normalize) s = s.normalize('NFC');
    return s.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(NON_WORD, '').replace(/^'+|'+$/g, '');
  }

  /* Sentence ends: Latin . ! ? plus the Devanagari danda/double danda, the Urdu
     full stop and question mark, the full-width ones and an ellipsis. */
  var SENT_END = /[.!?।॥۔؟？！…]["'”’)\]]*$/;
  var QUESTION_END = /[?؟？]["'”’)\]]*$/;
  var STATEMENT_END = /[.!।॥۔！]["'”’)\]]*$/;

  /* Flatten cues (line-level, with text) into a word stream with even per-word
     timing when real word cues aren't supplied. Every such time inside a line
     is a GUESS: each word says so (estimated), and the first and last word
     of each line say so too (cueStart / cueEnd) — the line's own start and
     end are the only real times there are. */
  function flatten(cues) {
    var out = [];
    for (var c = 0; c < (cues || []).length; c++) {
      var ws = String(cues[c].text).replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
      var n = Math.max(1, ws.length), d = ((cues[c].end - cues[c].start) || n * 0.4) / n;
      for (var k = 0; k < ws.length; k++) {
        var o = { start: cues[c].start + k * d, end: cues[c].start + (k + 1) * d, text: ws[k], estimated: true };
        if (k === 0) o.cueStart = true;
        if (k === ws.length - 1) o.cueEnd = true;
        out.push(o);
      }
    }
    return out;
  }
  /* Is a cut edge at this word a REAL time? A word with real timing, or the
     start (end) of a caption line whose word times are only estimated. */
  function realStart(w) { return !w || !w.estimated || !!w.cueStart; }
  function realEnd(w) { return !w || !w.estimated || !!w.cueEnd; }

  /* Longest-common-subsequence length of two token arrays (order-aware, tolerant
     of insertions/deletions/substitutions — exactly how retakes differ). */
  function lcsLen(a, b) {
    if (!a || !b) return 0;
    var n = a.length, m = b.length;
    if (!n || !m) return 0;
    var prev = new Array(m + 1), cur = new Array(m + 1), i, j;
    for (j = 0; j <= m; j++) prev[j] = 0;
    for (i = 1; i <= n; i++) {
      cur[0] = 0;
      for (j = 1; j <= m; j++) {
        cur[j] = (a[i - 1] === b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[m];
  }

  /* Similarity of two phrases (0..1): LCS over normalized tokens / longer length.
     Two retakes of the same line score ~0.85–0.95; unrelated lines score < ~0.4. */
  function phraseSim(A, B) {
    if (!A.length || !B.length) return 0;
    return lcsLen(A, B) / Math.max(A.length, B.length);
  }

  /* Containment: how much of the SHORTER phrase is covered by the longer one
     (LCS / shorter length). High containment with a short A means A is a
     fragment/restart of B even when overall similarity (LCS / longer) is low. */
  function phraseContain(A, B) {
    if (!A.length || !B.length) return 0;
    return lcsLen(A, B) / Math.min(A.length, B.length);
  }

  /* Is `a` a near-prefix of `b` — the speaker started a line, stopped, and
     restarted it ("so the— so the main thing is…"). `a` must be the shorter one. */
  function isNearPrefix(a, b, frac) {
    frac = (frac == null) ? 0.7 : frac;
    var n = a.length;
    if (!n || n >= b.length) return false;
    var match = 0;
    for (var i = 0; i < n; i++) if (a[i] === b[i]) match++;
    return (match / n) >= frac;
  }

  function wordSet(list) { var o = {}; for (var i = 0; i < list.length; i++) o[norm(list[i])] = 1; return o; }

  /* Hesitation sounds — never "content" when judging how complete a take is. */
  var FILLERS = wordSet(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'ah', 'ahh', 'hmm', 'hmmm', 'hm', 'mm', 'mmm', 'mhm',
    'aa', 'aaa', 'aaaa', 'उम', 'उम्म', 'उम्मम', 'अम्म', 'अं', 'हम्म', 'हम्मम', 'आआ', 'आआआ']);

  /* Words that open a line without being part of it ("okay so…", "toh…") —
     skipped before comparing two openings. */
  var LEAD = wordSet(['okay', 'ok', 'so', 'and', 'but', 'now', 'well', 'right', 'alright', 'yeah', 'yes', 'basically', 'actually',
    'toh', 'to', 'aur', 'haan', 'ha', 'acha', 'achha', 'accha', 'chalo', 'dekho', 'matlab', 'yaani', 'yani', 'phir', 'fir', 'ki',
    'तो', 'और', 'हाँ', 'हां', 'अच्छा', 'चलो', 'देखो', 'मतलब', 'यानी', 'फिर', 'कि'].concat(Object.keys(FILLERS)));

  /* Glue words: a shared "the" or "hai" at the start of two lines proves
     nothing about one restarting the other. */
  var FUNC = wordSet(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'it',
    'this', 'that', 'so', 'i', 'you', 'we', 'he', 'she', 'they', 'my', 'your', 'our', 'do', 'did', 'does', 'what', 'how', 'when',
    'hai', 'hain', 'ka', 'ki', 'ke', 'mein', 'me', 'se', 'ko', 'ne', 'aur', 'toh', 'bhi', 'hi', 'par', 'pe', 'ye', 'yeh', 'wo', 'woh',
    'vo', 'ek', 'ho', 'tha', 'thi', 'the', 'kya', 'na', 'nahi',
    'है', 'हैं', 'का', 'की', 'के', 'में', 'से', 'को', 'ने', 'और', 'तो', 'भी', 'ही', 'पर', 'ये', 'यह', 'वो', 'वह', 'एक', 'हो',
    'था', 'थी', 'थे', 'क्या', 'ना', 'नहीं']);

  /* Grammatical person. The same speaker re-reading a line keeps "you" as
     "you"; a reply turns the host's "aap/you" into "main/I". */
  var SECOND = wordSet(['aap', 'aapne', 'aapka', 'aapki', 'aapke', 'aapko', 'aapse', 'tum', 'tumne', 'tumhara',
    'tumhari', 'tumhare', 'tumko', 'tumse', 'tu', 'tujhe', 'tera', 'teri', 'tere', 'you', 'your', 'yours', "you're", 'youre',
    "you've", "you'll", "you'd", 'yourself',
    'आप', 'आपने', 'आपका', 'आपकी', 'आपके', 'आपको', 'आपसे', 'तुम', 'तुमने', 'तुम्हारा', 'तुम्हारी', 'तुम्हारे', 'तुमको', 'तुमसे',
    'तू', 'तुझे', 'तेरा', 'तेरी', 'तेरे']);
  var FIRST = wordSet(['main', 'maine', 'mera', 'meri', 'mere', 'mujhe', 'mujhse', 'hum', 'humne', 'hamne', 'hamara', 'hamari',
    'hamare', 'humara', 'humari', 'humare', 'humko', 'hamko', 'humein', 'hamein', 'i', "i'm", 'im', "i've", "i'll", "i'd", 'my',
    'me', 'mine', 'myself', 'we', "we're", 'our', 'us',
    'मैं', 'मैंने', 'मेरा', 'मेरी', 'मेरे', 'मुझे', 'मुझसे', 'हम', 'हमने', 'हमारा', 'हमारी', 'हमारे', 'हमको', 'हमें']);

  /* Hindi question words. One take of a line keeps them when the speaker
     re-reads it; an ANSWER replaces them ("kitne saal?" → "do saal"). English
     what/how/when are left out: they open statements too ("what I learned…"). */
  var ASK = wordSet(['kab', 'kitna', 'kitne', 'kitni', 'kahan', 'kahaan', 'kaha', 'kaun', 'kaunsa', 'kaunsi', 'kaunse', 'kyun',
    'kyon', 'kyu', 'kyoon', 'kya', 'kaise', 'kaisa', 'kaisi',
    'कब', 'कितना', 'कितने', 'कितनी', 'कहाँ', 'कहां', 'कौन', 'कौनसा', 'कौनसी', 'कौनसे', 'क्यों', 'क्यूं', 'क्यूँ', 'क्या', 'कैसे',
    'कैसा', 'कैसी']);

  /* Acknowledgements ("haan bilkul.", "right.", "जी हाँ") — on a podcast the
     other person says them right before their own sentence that starts the
     same way. Never an abandoned take. */
  var BACKCHANNEL = wordSet(['haan', 'haa', 'haanji', 'ji', 'jee', 'bilkul', 'sahi', 'theek', 'thik', 'acha', 'achha', 'accha',
    'hmm', 'hm', 'yes', 'yeah', 'yep', 'yup', 'right', 'exactly', 'absolutely', 'sure', 'correct', 'true', 'okay', 'ok', 'totally',
    'हाँ', 'हां', 'जी', 'बिल्कुल', 'बिलकुल', 'सही', 'ठीक', 'अच्छा', 'हम्म']);
  function allIn(toks, set) { if (!toks.length) return false; for (var i = 0; i < toks.length; i++) if (!set[toks[i]]) return false; return true; }

  /* Words that open a REPLY by agreeing: "Right, the algorithm rewards watch
     time…" after the host's "The algorithm rewards watch time…". A line that
     opens with one while the line before it does not is the other person
     picking the thought up — not the same person starting again. ("okay",
     "so", "acha" are left out: a lone speaker restarts with those.) */
  var AGREE = wordSet(['yes', 'yeah', 'yep', 'yup', 'right', 'exactly', 'absolutely', 'totally', 'true', 'correct', 'sure',
    'definitely', 'agreed', 'indeed', 'haan', 'haa', 'haanji', 'ji', 'jee', 'bilkul', 'sahi', 'ekdum', 'bilkulji',
    'हाँ', 'हां', 'जी', 'बिल्कुल', 'बिलकुल', 'सही', 'एकदम']);

  function has(toks, set) { for (var i = 0; i < toks.length; i++) if (set[toks[i]]) return true; return false; }
  /* Does a line open by agreeing ("Yes, …", "Oh right, …", "Haan bilkul, …")? */
  var INTERJ = wordSet(['oh', 'ah', 'well', 'arre', 'arey', 'are', 'acha', 'achha', 'accha', 'ओह', 'अरे', 'अच्छा']);
  /* Said twice on purpose ("thank you, thank you", "come on, come on"). */
  var EMPHATIC = wordSet(['thank', 'thanks', 'you', 'please', 'bye', 'hello', 'hi', 'hey', 'wow', 'come', 'on', 'go', "let's", 'lets',
    'okay', 'ok', 'sorry', 'namaste', 'namaskar', 'dhanyavaad', 'dhanyawad', 'shukriya', 'chalo', 'bas', 'wah', 'waah', 'kya', 'baat',
    'नमस्ते', 'नमस्कार', 'धन्यवाद', 'शुक्रिया', 'चलो', 'बस', 'वाह', 'क्या', 'बात']);
  function opensAgreeing(t) {
    var i = 0;
    while (i < t.length - 1 && i < 2 && (FILLERS[t[i]] || INTERJ[t[i]])) i++;
    return !!AGREE[t[i]];
  }
  /* A line with its lead-in dropped ("haan toh", "yes,", "oh right", "um"). */
  function bodyOf(t) {
    var i = 0;
    while (i < t.length - 1 && i < 3 && (LEAD[t[i]] || AGREE[t[i]] || INTERJ[t[i]] || FILLERS[t[i]])) i++;
    return t.slice(i);
  }
  /* Does line b say (nearly) all of line a again, from a's start, and carry
     on past a's last word? That is a restart of an unfinished line ("aaj hum
     baat karenge" → "haan toh aaj hum baat karenge … aur bachat …"), not a
     reply ("…more than likes" → "right, …more than anything else"). */
  function carriesOn(a, b) {
    var A = bodyOf(a), B = bodyOf(b);
    return A.length > 0 && isNearPrefix(A, B) && B[A.length - 1] === A[A.length - 1];
  }

  /* A few words said twice can be a whole REMARK repeated for emphasis —
     agreeing, praising, exclaiming: "theek hai, theek hai, …", "bahut accha,
     bahut accha, …", "I know, I know, but…", "oh my god, oh my god, …",
     "no worries, no worries". Never a restart. Words such a remark is made
     of (with glue words and pronouns around them): */
  var REMARK = wordSet(['theek', 'thik', 'sahi', 'accha', 'acha', 'achha', 'acchha', 'bahut', 'bohot', 'bahot', 'baat', 'kamaal',
    'kamal', 'mast', 'zabardast', 'jabardast', 'badhiya', 'badiya', 'shandaar', 'bilkul', 'ekdum', 'haan', 'haa', 'ji', 'nahi',
    'nahin', 'arre', 'arey', 'wah', 'waah', 'sach', 'sachchi', 'pakka', 'suno', 'dekho', 'ruko', 'chalo', 'bas', 'shabash', 'yaar',
    'know', 'course', 'worries', 'worry', 'god', 'gosh', 'wow', 'great', 'good', 'nice', 'cool', 'amazing', 'awesome', 'perfect',
    'done', 'fine', 'sure', 'true', 'really', 'seriously', 'totally', 'absolutely', 'exactly', 'right', 'yes', 'yeah', 'no', 'okay',
    'ok', 'oh', 'ah', 'see', 'look', 'listen', 'wait', 'hold', 'stop', 'never', 'love', 'beautiful', 'brilliant', 'excellent',
    'wonderful', 'incredible', 'crazy', 'insane', 'lovely', 'fantastic', 'correct', 'agreed', 'indeed', 'definitely', 'obviously',
    'man', 'bro', 'dude',
    'ठीक', 'सही', 'अच्छा', 'बहुत', 'बात', 'कमाल', 'मस्त', 'ज़बरदस्त', 'जबरदस्त', 'बढ़िया', 'शानदार', 'बिल्कुल', 'बिलकुल', 'एकदम',
    'हाँ', 'हां', 'जी', 'नहीं', 'अरे', 'वाह', 'सच', 'पक्का', 'सुनो', 'देखो', 'रुको', 'चलो', 'बस', 'शाबाश', 'यार']);
  /* Hindi puts the verb last, so a unit that ENDS in one is a finished
     clause said twice ("sahi hai", "kya baat hai", "ho gaya", "kar diya"),
     not a line broken off and started again. */
  var VERB_END = wordSet(['hai', 'hain', 'hoon', 'hun', 'ho', 'tha', 'thi', 'gaya', 'gayi', 'gaye', 'gai', 'hua', 'hui', 'hue',
    'diya', 'liya', 'kiya',
    'है', 'हैं', 'हूँ', 'हूं', 'हो', 'था', 'थी', 'थे', 'गया', 'गई', 'गयी', 'गए', 'गये', 'हुआ', 'हुई', 'हुए', 'दिया', 'लिया', 'किया']);
  /* …while a unit that ends in one of these is plainly unfinished ("so the,",
     "we need to,", "what we do is,", "paise ke,"), however it is punctuated. */
  var OPEN_END = wordSet(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'for', 'and', 'or', 'but', 'with', 'from', 'by', 'into',
    'about', 'my', 'your', 'our', 'their', 'his', 'her', 'its', 'is', 'are', 'was', 'were', 'be', 'am', 'if', 'because', 'when',
    'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'ne', 'par', 'pe', 'aur', 'ya', 'lekin', 'magar', 'agar', 'jab', 'jo',
    'का', 'की', 'के', 'को', 'से', 'में', 'ने', 'पर', 'पे', 'और', 'या', 'लेकिन', 'मगर', 'अगर', 'जब', 'जो', 'कि']);
  /* A word followed by a pause mark: comma, dash, sentence end. */
  var CLOSED = /[,;:…—–.!?।॥۔؟،？！-]["'”’)\]]*$/;
  /* Is the unit u (normalized tokens) said twice a repeated remark, not a
     restart? rawA / rawB = how each copy's last word is written. */
  function isRemark(u, rawA, rawB) {
    var last = u[u.length - 1];
    if (VERB_END[last]) return true;                                   // "theek hai", "ho gaya"
    var remark = 0, i;
    for (i = 0; i < u.length; i++) {
      if (REMARK[u[i]] || INTERJ[u[i]]) remark++;
      else if (!FUNC[u[i]] && !FIRST[u[i]] && !SECOND[u[i]] && !EMPHATIC[u[i]]) break;
    }
    if (i === u.length && remark) return true;                         // "bahut accha", "I know", "oh my god"
    // each copy stands alone — a pause mark after BOTH ("…, …, and then") —
    // and the unit does not end where a line cannot ("so the, so the,")
    return CLOSED.test(rawA) && CLOSED.test(rawB) && !OPEN_END[last];
  }

  function pTokens(p) { var a = []; for (var i = 0; i < p.length; i++) { var n = norm(p[i].text); if (n) a.push(n); } return a; }
  function pText(p) { var s = []; for (var i = 0; i < p.length; i++) s.push(p[i].text); return s.join(' '); }
  function pConf(p) { var s = 0, c = 0; for (var i = 0; i < p.length; i++) { if (p[i].conf != null) { s += p[i].conf; c++; } } return c ? s / c : null; }
  /* Majority speaker of a phrase, or null when the transcript has no labels. */
  function pSpeaker(p) {
    var cnt = {}, best = null, bn = 0;
    for (var i = 0; i < p.length; i++) {
      var s = p[i].speaker;
      if (s == null || s === '') continue;
      s = String(s); cnt[s] = (cnt[s] || 0) + 1;
      if (cnt[s] > bn) { bn = cnt[s]; best = s; }
    }
    return best;
  }
  function lastText(p) { return p.length ? String(p[p.length - 1].text || '').trim() : ''; }

  /* Tokens a take really SAYS: hesitations dropped and an immediate stutter
     ("is is", "the the") counted once — so a stumbling take does not look
     "more complete" than the clean re-read that follows it. */
  function contentToks(t) {
    var out = [];
    for (var i = 0; i < t.length; i++) {
      if (FILLERS[t[i]]) continue;
      if (out.length && out[out.length - 1] === t[i]) continue;
      out.push(t[i]);
    }
    return out;
  }

  /* Split a word stream into phrases at pauses (gap in word timing), sentence
     punctuation, or a change of speaker — each phrase is one candidate "take". */
  function splitPhrases(words, pauseGap) {
    pauseGap = (pauseGap != null) ? pauseGap : 0.45;
    if (!words || !words.length) return [];
    var phrases = [], cur = [words[0]];
    for (var k = 1; k < words.length; k++) {
      var gap = words[k].start - words[k - 1].end;
      var endsSentence = SENT_END.test(String(words[k - 1].text || ''));
      var sa = words[k - 1].speaker, sb = words[k].speaker;
      var newSpeaker = sa != null && sb != null && sa !== '' && sb !== '' && String(sa) !== String(sb);
      if (gap > pauseGap || endsSentence || newSpeaker) { if (cur.length) phrases.push(cur); cur = []; }
      cur.push(words[k]);
    }
    if (cur.length) phrases.push(cur);
    return phrases;
  }

  /* Opening of a phrase with lead-in words ("okay so", "toh", "um") skipped. */
  function opening(t, n) {
    var i = 0;
    while (i < t.length - 1 && i < 3 && LEAD[t[i]]) i++;
    return t.slice(i, i + n);
  }
  /* Does `b` go back to where `a` began? Their first three meaningful words must
     share a non-glue word. A reply picks up the question's END ("…the hardest
     part of that first year?" → "The hardest part was…"); a retake repeats its
     START. */
  function restarts(a, b) {
    var oa = opening(a, 3), ob = opening(b, 3);
    for (var i = 0; i < oa.length; i++) {
      if (FUNC[oa[i]] || FIRST[oa[i]] || SECOND[oa[i]]) continue;   // glue and pronouns prove nothing
      for (var j = 0; j < ob.length; j++) if (oa[i] === ob[j]) return true;
    }
    // an opening made only of glue ("what is the…") must then be re-said as is
    return oa.length >= 2 && ob.length >= 2 && oa[0] === ob[0] && oa[1] === ob[1];
  }

  /*
   * Find repeated takes (fuzzy).
   *   words: [{start,end,text, conf?, speaker?}]
   *   opts.sim      similarity 0..1 to call two phrases the same take (default .6)
   *   opts.minRun   min words a take must have to be considered (default 3)
   *   opts.keep     'best' = the last COMPLETE take (a take that stops short is
   *                 cut even when it came last) | 'last' | 'confident'
   *   opts.pauseGap pause (s) that separates takes (default .45)
   *   opts.window   max phrases between two takes of a line (default 16)
   *   opts.maxGapSec max seconds between two takes of a line (default 60)
   *   opts.people   who is talking, when the owner said so or the transcript's
   *                 speaker labels show it: 'one' = a lone speaker (labels are
   *                 then ignored — a diarizer that splits one voice in two must
   *                 not hide a retake); 'many' = a conversation: two lines
   *                 whose speaker is unknown are linked only when nearly
   *                 identical (sim >= .8, no fragment links), and a finished
   *                 sentence is never a false start; unset = not known.
   * Returns { deletes:[{start,end,text,reason}], kept:n, removedWords:n }.
   * Each delete spans a worse take INCLUDING its trailing pause (up to the next
   * phrase) so ripple-deleting it leaves no dangling silence.
   */
  function findRepeatedTakes(words, opts) {
    opts = opts || {};
    var thresh = (opts.sim != null) ? opts.sim : 0.6;
    var minRun = Math.max(2, opts.minRun || 3);
    var keep = opts.keep || 'last';
    var win = opts.window || 16;                // how many phrases ahead a retake can be (a retake after a "ugh let me redo that" aside is often >6 phrases away)
    var maxGapSec = (opts.maxGapSec != null) ? opts.maxGapSec : 60;   // …but never minutes later: that is a callback, not a retake
    var containThresh = (opts.contain != null) ? opts.contain : 0.85;
    var containWin = opts.containWindow || 4;
    var N = (words || []).length;
    if (N < minRun * 2) return { deletes: [], kept: 0, removedWords: 0 };

    var phrases = splitPhrases(words, opts.pauseGap);
    var toks = phrases.map(pTokens);
    var ct = toks.map(contentToks);   // what each phrase SAYS — "um", "uh" and "is is" don't make two takes differ
    var P = phrases.length;
    var people = (opts.people === 'one' || opts.people === 'many') ? opts.people : null;
    var spk = phrases.map(people === 'one' ? function () { return null; } : pSpeaker);
    var ends = phrases.map(lastText);
    var isQ = ends.map(function (s) { return QUESTION_END.test(s); });
    var isStmt = ends.map(function (s) { return STATEMENT_END.test(s); });
    var p2 = toks.map(function (t) { return has(t, SECOND); });
    var p1 = toks.map(function (t) { return has(t, FIRST); });
    var ask = toks.map(function (t) { return has(t, ASK); });
    var ack = toks.map(function (t) { return allIn(t, BACKCHANNEL); });
    var agree = toks.map(opensAgreeing);
    function startOf(idx) { return phrases[idx][0].start; }
    function endOf(idx) { return phrases[idx][phrases[idx].length - 1].end; }

    /* Could phrase a (earlier) and phrase b (later) be two takes of ONE line by
       ONE person? Every rule here only ever says "no". */
    function sameLine(a, b) {
      if (spk[a] != null && spk[b] != null && spk[a] !== spk[b]) return false;      // different people
      if ((isQ[a] && isStmt[b]) || (isStmt[a] && isQ[b])) return false;              // a question and its answer
      if ((p2[a] && !p2[b] && p1[b]) || (p2[b] && !p2[a] && p1[a])) return false;    // "aap/you" ↔ "main/I"
      // "kitne saal rahe?" answered by "do saal raha": the question word goes
      // away. (A shorter FIRST attempt that stopped before reaching it is fine.)
      if (ask[a] && !ask[b]) return false;
      if (ask[b] && !ask[a] && ct[a].length >= ct[b].length) return false;
      // "Right, the algorithm rewards…" after "The algorithm rewards…": the
      // other person agreeing and picking the thought up — unless the labels
      // say it is the same voice, or the owner said it is only them. With the
      // speakers unknown (Auto on a plain transcript, the default) a lone
      // speaker's "haan toh aaj hum…" after an UNFINISHED "aaj hum…" is still
      // a restart when it says all of the earlier line again and goes on from
      // its last word; an agreeing reply ends the thought its own way.
      if (people !== 'one' && (spk[a] == null || spk[b] == null) && agree[b] && !agree[a] &&
          (isStmt[a] || !carriesOn(ct[a], ct[b]))) return false;
      return true;
    }
    /* Is take i a deliberately shorter, FINISHED version of the fullest take
       f ("So the secret … is posting consistency every single day." → "The
       secret … is consistency.")? It ends in a full stop or question mark
       (not "…"), not on a word no line ends on ("…is."), is not simply f cut
       off (Whisper puts a full stop on fragments too: "So the secret … is
       posting."), and ends on a word f also says — a new last word may be a
       misheard fragment, so that case keeps the fuller take as before. */
    function finishedShorter(i, f) {
      if (i === f || !(isStmt[i] || isQ[i])) return false;
      var t = ct[i], last = t[t.length - 1];
      if (!last || OPEN_END[last] || carriesOn(t, ct[f])) return false;
      return ct[f].indexOf(last) >= 0;
    }
    /* A conversation whose speakers are not labelled: only a near-identical
       line can be the same person saying it again. */
    function strict(a, b) { return people === 'many' && (spk[a] == null || spk[b] == null); }

    // Union-find: group phrases that are similar within a small window. This is
    // transitive, so a drifting run of 3–4 retakes (take1≈take2≈take3, even if
    // take1 vs take3 alone is weaker) all collapse into ONE group → complete
    // removal, not just the first pair.
    var parent = []; for (var x = 0; x < P; x++) parent[x] = x;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function uni(a, b) { parent[find(a)] = find(b); }
    for (var a = 0; a < P; a++) {
      if (toks[a].length < minRun || ack[a]) continue;
      var hi = Math.min(P - 1, a + win);
      for (var b = a + 1; b <= hi; b++) {
        if (startOf(b) - endOf(a) > maxGapSec) break;
        if (toks[b].length < Math.min(minRun, 2) || ack[b]) continue;
        if (!ct[a].length || !ct[b].length || !restarts(ct[a], ct[b]) || !sameLine(a, b)) continue;
        // Link if the two phrases are broadly similar (a re-recorded line) OR if
        // the EARLIER, shorter one is largely CONTAINED in a later one close by
        // (an abandoned partial take the full line then replaces). A long line
        // followed by a short FINISHED echo of it is a summary or an answer — not
        // a retake.
        // A long line followed straight away by an UNFINISHED start of itself
        // (no full stop — the speaker began again and gave up) is linked too;
        // keep:'best' then keeps the complete one.
        var st = strict(a, b);
        if (phraseSim(ct[a], ct[b]) >= (st ? Math.max(thresh, 0.8) : thresh) ||
            (!st && b - a <= containWin && ct[a].length <= ct[b].length &&
             phraseContain(ct[a], ct[b]) >= containThresh) ||
            (!st && b === a + 1 && ct[b].length < ct[a].length && !SENT_END.test(ends[b]) &&
             isNearPrefix(ct[b], ct[a]) && phraseContain(ct[a], ct[b]) >= containThresh)) uni(a, b);
      }
    }

    var groups = {};
    for (var g = 0; g < P; g++) { var r = find(g); (groups[r] = groups[r] || []).push(g); }

    function nextStart(idx) { return (idx + 1 < P) ? phrases[idx + 1][0].start : phrases[idx][phrases[idx].length - 1].end; }
    /* A phrase cut whose start or end sits INSIDE a caption line with only
       estimated word times is still listed, but flagged: the owner hears it
       (▶) before it is ticked — it could clip a word or leave half of one. */
    function cutOf(idx, reason) {
      var d = { start: startOf(idx), end: nextStart(idx), text: pText(phrases[idx]), reason: reason };
      var endOk = (idx + 1 < P) ? realStart(phrases[idx + 1][0]) : realEnd(phrases[idx][phrases[idx].length - 1]);
      if (!realStart(phrases[idx][0]) || !endOk) { d.estimated = true; d.needsReview = true; }
      return d;
    }

    var deletes = [], removedWords = 0;
    var inRetakeGroup = {};   // phrase idx → member of a real (2+) retake group
    var deleted = {};         // phrase idx → already cut (never list a phrase twice)
    Object.keys(groups).forEach(function (key) {
      var grp = groups[key];
      if (grp.length < 2) return;
      for (var gm = 0; gm < grp.length; gm++) inRetakeGroup[grp[gm]] = true;
      grp.sort(function (x, y) { return x - y; });
      var keepIdx = grp[grp.length - 1];          // default: keep the LAST attempt
      if (keep === 'best') {
        // The LAST COMPLETE take: walk back from the last attempt and keep the
        // first one that says (nearly) everything the fullest attempt says.
        // Hesitations and stutters don't count as content, so a stumbling take
        // never beats the clean re-read after it; a take that stops short is
        // cut even if it came last.
        // A shorter take that is a FINISHED sentence counts too — the speaker
        // tightened the line on purpose (finishedShorter).
        var lens = [], maxLen = 0, li, full = 0;
        for (li = 0; li < grp.length; li++) { lens[li] = ct[grp[li]].length; if (lens[li] > maxLen) { maxLen = lens[li]; full = li; } }
        for (li = grp.length - 1; li >= 0; li--) {
          if (!maxLen || lens[li] >= 0.75 * maxLen ||
              (lens[li] >= 0.5 * maxLen && finishedShorter(grp[li], grp[full]))) { keepIdx = grp[li]; break; }
        }
      } else if (keep === 'confident') {
        var bc = -Infinity, anyConf = false;
        for (var ci = 0; ci < grp.length; ci++) {
          var cf = pConf(phrases[grp[ci]]);
          if (cf != null) { anyConf = true; if (cf > bc) { bc = cf; keepIdx = grp[ci]; } }
        }
        // No per-word confidence anywhere (the common case for most transcripts)?
        // Fall back to the LAST take — never silently keep the first/worse one.
        if (!anyConf) keepIdx = grp[grp.length - 1];
      }
      for (var c2 = 0; c2 < grp.length; c2++) {
        var idx = grp[c2];
        if (idx === keepIdx) continue;
        deletes.push(cutOf(idx, 'repeated take'));
        removedWords += phrases[idx].length;
        deleted[idx] = true;
      }
    });

    // False starts / restarts: a SHORT phrase that is a near-prefix of the NEXT
    // phrase — the speaker began a line, stopped, and restarted it. These have no
    // full second take to cluster against, so the similarity pass alone misses
    // them. Delete the fragment, keep the completed line.
    if (opts.falseStarts !== false) {
      var maxFrag = opts.maxFragWords || 6;
      for (var fi = 0; fi + 1 < P; fi++) {
        if (deleted[fi]) continue;
        if (!ct[fi].length || ct[fi].length > maxFrag) continue;
        if (ack[fi] || !sameLine(fi, fi + 1)) continue;
        if (strict(fi, fi + 1) && isStmt[fi]) continue;   // a finished sentence, then the other person going on from it
        if (isNearPrefix(ct[fi], ct[fi + 1], opts.prefixFrac)) {
          deletes.push(cutOf(fi, 'false start'));
          removedWords += phrases[fi].length;
          deleted[fi] = true;
          inRetakeGroup[fi] = true;   // retake activity — lets the aside pass anchor on it
        }
      }
    }

    // Off-script ASIDES between takes ("no no wait", "ugh let me try that
    // again", "arre ruko, ek baar phir se"…): they're not similar to anything,
    // so the grouping can't catch them — but they're exactly what a one-button
    // cleanup must remove. TWO locks keep this safe: (1) the phrase must be
    // short and chatter-worded (a strong marker + mostly filler vocabulary), and
    // (2) it must sit DIRECTLY NEXT TO detected retake activity by the same
    // speaker. In a video with no retakes nothing is adjacent, so nothing can
    // ever be taken by mistake.
    if (opts.asides !== false) {
      var STRONG = wordSet(['no', 'nope', 'wait', 'again', 'redo', 'sorry', 'cut', 'ugh', 'over', 'messed', 'flubbed', 'scratch',
        'terrible', 'awful', 'horrible', 'damn', 'dammit', 'shit', 'fuck', 'crap', 'retry', 'restart', 'stop',
        'ruko', 'ruk', 'rukiye', 'dobara', 'galat', 'arre', 'arey', 'arrey', 'oops',
        'रुको', 'रुकिए', 'दोबारा', 'गलत', 'ग़लत', 'अरे']);
      var WEAK = wordSet(['let', 'me', 'try', 'that', 'this', 'it', 'one', 'more', 'time', 'okay', 'ok', 'hmm', 'um', 'uh', 'oh', 'man',
        'god', 'was', 'is', 'i', 'do', 'did', 'hold', 'on', 'start', 'take', 'two', 'three', 'from', 'the', 'top', 'line', 'up', 'so',
        'bad', 'not', 'good', 'right', 'yeah', 'well', 'alright', 'a', 'go', 'gonna', 'redo',
        'ek', 'baar', 'bar', 'phir', 'fir', 'se', 'chalo', 'theek', 'thik', 'ho', 'gaya', 'gayi', 'hai', 'main', 'toh', 'haan', 'acha',
        'achha', 'accha', 'nahi', 'nahin', 'aur', 'shuru', 'karte', 'karta', 'karti', 'hain', 'yaar', 'bhai',
        'एक', 'बार', 'फिर', 'से', 'चलो', 'ठीक', 'हो', 'गया', 'गई', 'है', 'मैं', 'तो', 'हाँ', 'हां', 'अच्छा', 'नहीं', 'और', 'शुरू',
        'करते', 'करता', 'हैं', 'यार']);
      var PHRASES = ['one more time', 'take two', 'take three', 'start over', 'from the top', 'try that again', 'try it again',
        'do that again', 'do it again', 'that again', 'ek baar aur', 'ek baar phir', 'ek aur baar', 'phir se', 'fir se',
        'galat ho gaya', 'nahi nahi', 'shuru se', 'फिर से', 'एक बार और', 'एक बार फिर', 'गलत हो गया', 'नहीं नहीं', 'शुरू से'];
      var PHRASE_TOKS = PHRASES.map(function (ph) { return ph.split(' ').map(norm).join(' '); });
      var maxAside = opts.maxAsideWords || 8;
      for (var ai = 0; ai < P; ai++) {
        if (inRetakeGroup[ai] || deleted[ai]) continue;
        var tk = toks[ai];
        if (!tk.length || tk.length > maxAside) continue;
        var near = (ai > 0 && inRetakeGroup[ai - 1] && (spk[ai] == null || spk[ai - 1] == null || spk[ai] === spk[ai - 1])) ||
                   (ai + 1 < P && inRetakeGroup[ai + 1] && (spk[ai] == null || spk[ai + 1] == null || spk[ai] === spk[ai + 1]));
        if (!near) continue;
        var joined = ' ' + tk.join(' ') + ' ';
        var strong = 0, weak = 0;
        for (var ti = 0; ti < tk.length; ti++) {
          if (STRONG[tk[ti]]) strong++;
          else if (WEAK[tk[ti]]) weak++;
        }
        var phraseHit = false;
        for (var pi = 0; pi < PHRASES.length && !phraseHit; pi++) if (joined.indexOf(' ' + PHRASE_TOKS[pi] + ' ') >= 0) phraseHit = true;
        var hasStrong = strong > 0 || phraseHit;
        var chattery = (strong + weak) / tk.length >= 0.75;
        if (hasStrong && chattery) {
          deletes.push(cutOf(ai, 'off-script aside'));
          removedWords += phrases[ai].length;
          deleted[ai] = true;
        }
      }
    }

    // Restarts INSIDE one breath: "so the, so the main thing is…", "toh main,
    // toh main kya bol raha tha…" — the pause is too short to split a phrase,
    // so the passes above never see two takes. Two to six words said and then
    // said again straight away, with the line going on after them: the first
    // copy is cut, from its first word to the first word of the second copy.
    // Never cut: one word said twice (Hindi doubles words on purpose —
    // "dheere dheere", "alag alag" — and English for emphasis, "very very"), a
    // run of one word ("no no no", "haan haan"), agreement or courtesy said
    // twice ("thank you, thank you"), or a repeat that ends the line. In a
    // conversation with no speaker labels a quick echo may be the OTHER person
    // ("…and the algorithm" / "the algorithm is everything") inside one phrase,
    // so there only a labelled phrase is searched. The cut lands between two
    // words INSIDE a phrase, so it needs real word timing: on a line whose word
    // times are only estimated (flatten) it would chop words at a guessed spot.
    if (opts.restarts !== false) {
      var minN = Math.max(2, minRun - 1), maxN = 6;
      for (var qi = 0; qi < P; qi++) {
        if (deleted[qi] || (people === 'many' && spk[qi] == null)) continue;
        if (phrases[qi].some(function (w) { return w.estimated; })) continue;
        var ph = phrases[qi], tw = [];
        for (var wi = 0; wi < ph.length; wi++) { var nt = norm(ph[wi].text); if (nt && !FILLERS[nt]) tw.push({ t: nt, w: wi }); }
        var k0 = 0;
        while (k0 < tw.length) {
          var hit = 0;
          for (var rn = Math.min(maxN, Math.floor((tw.length - k0 - 1) / 2)); rn >= minN && !hit; rn--) {
            var same = true, kinds = {}, nk = 0, polite = true;
            var unit = [];
            for (var rq = 0; rq < rn && same; rq++) {
              var tk1 = tw[k0 + rq].t;
              if (tk1 !== tw[k0 + rn + rq].t) same = false;
              if (!kinds[tk1]) { kinds[tk1] = 1; nk++; }
              if (!EMPHATIC[tk1] && !AGREE[tk1] && !BACKCHANNEL[tk1]) polite = false;
              unit.push(tk1);
            }
            if (same && nk >= 2 && !polite &&
                !isRemark(unit, ph[tw[k0 + rn - 1].w].text, ph[tw[k0 + 2 * rn - 1].w].text)) hit = rn;
          }
          if (!hit) { k0++; continue; }
          var first = ph[tw[k0].w], again = ph[tw[k0 + hit].w], said = [];
          for (var sw = tw[k0].w; sw < tw[k0 + hit].w; sw++) said.push(ph[sw].text);
          if (again.start > first.start) {
            deletes.push({ start: first.start, end: again.start, text: said.join(' '), reason: 'false start' });
            removedWords += tw[k0 + hit].w - tw[k0].w;
          }
          k0 += hit;
        }
      }
    }
    return { deletes: tidyDeletes(deletes, 0.1), kept: deletes.length, removedWords: removedWords };
  }

  /* Merge delete ranges that touch/overlap, drop anything shorter than min. */
  function tidyDeletes(deletes, minLen) {
    minLen = minLen || 0.08;
    var s = deletes.slice().sort(function (a, b) { return a.start - b.start; });
    var out = [];
    for (var i = 0; i < s.length; i++) {
      if (s[i].end - s[i].start < minLen) continue;
      if (out.length && s[i].start <= out[out.length - 1].end + 0.05) {
        var last = out[out.length - 1];
        last.end = Math.max(last.end, s[i].end);
        if (s[i].needsReview) last.needsReview = true;   // one guessed edge makes the merged cut one to hear first
        if (s[i].estimated) last.estimated = true;
        if (s[i].text && last.text !== s[i].text && (' / ' + last.text + ' / ').indexOf(' / ' + s[i].text + ' / ') < 0) last.text += ' / ' + s[i].text;
      } else {
        var o = {}; for (var k in s[i]) if (Object.prototype.hasOwnProperty.call(s[i], k)) o[k] = s[i][k];
        out.push(o);
      }
    }
    return out;
  }

  return {
    findRepeatedTakes: findRepeatedTakes, flatten: flatten, tidyDeletes: tidyDeletes,
    phraseSim: phraseSim, phraseContain: phraseContain, isNearPrefix: isNearPrefix,
    lcsLen: lcsLen, splitPhrases: splitPhrases, _norm: norm
  };
});
