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
  var NEGATION = /^(not|never|nothing|nobody|none|cannot|.+n't|mat|मत)$/;
  var NEG_INTERJ = /^(no|nahi|nahin|na|नहीं|नही|ना)$/;
  /* What a speaker says between takes ("no no wait", "arre ruko, ek baar phir
     se"): strong markers, the filler words around them, whole phrases. */
  var CHAT_STRONG = wordSet(['no', 'nope', 'wait', 'again', 'redo', 'sorry', 'cut', 'ugh', 'over', 'messed', 'flubbed', 'scratch',
    'terrible', 'awful', 'horrible', 'damn', 'dammit', 'shit', 'fuck', 'crap', 'retry', 'restart', 'stop',
    'ruko', 'ruk', 'rukiye', 'dobara', 'galat', 'arre', 'arey', 'arrey', 'oops',
    'रुको', 'रुकिए', 'दोबारा', 'गलत', 'ग़लत', 'अरे']);
  var CHAT_WEAK = wordSet(['let', 'me', 'try', 'that', 'this', 'it', 'one', 'more', 'time', 'okay', 'ok', 'hmm', 'um', 'uh', 'oh', 'man',
    'god', 'was', 'is', 'i', 'do', 'did', 'hold', 'on', 'start', 'take', 'two', 'three', 'from', 'the', 'top', 'line', 'up', 'so',
    'bad', 'not', 'good', 'right', 'yeah', 'well', 'alright', 'a', 'go', 'gonna', 'redo',
    'ek', 'baar', 'bar', 'phir', 'fir', 'se', 'chalo', 'theek', 'thik', 'ho', 'gaya', 'gayi', 'hai', 'main', 'toh', 'haan', 'acha',
    'achha', 'accha', 'nahi', 'nahin', 'aur', 'shuru', 'karte', 'karta', 'karti', 'hain', 'yaar', 'bhai',
    'एक', 'बार', 'फिर', 'से', 'चलो', 'ठीक', 'हो', 'गया', 'गई', 'है', 'मैं', 'तो', 'हाँ', 'हां', 'अच्छा', 'नहीं', 'और', 'शुरू',
    'करते', 'करता', 'हैं', 'यार']);
  var CHAT_PHRASES = ['one more time', 'take two', 'take three', 'start over', 'from the top', 'try that again', 'try it again',
    'do that again', 'do it again', 'that again', 'ek baar aur', 'ek baar phir', 'ek aur baar', 'phir se', 'fir se',
    'galat ho gaya', 'nahi nahi', 'shuru se', 'फिर से', 'एक बार और', 'एक बार फिर', 'गलत हो गया', 'नहीं नहीं', 'शुरू से'];

  var RETRY_OPEN = wordSet(['wait', 'sorry', 'ugh', 'oops', 'arre', 'arey', 'arrey', 'ruko', 'ruk', 'rukiye', 'अरे', 'रुको', 'रुकिए']);
  var RETRY_AGAIN = wordSet(['again', 'redo', 'retry', 'dobara', 'दोबारा', 'phir', 'fir', 'फिर']);
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

  /* One spoken word, two spellings: on Auto language the transcriber writes the
     same Hinglish word in Latin in one take and in Devanagari in the retake
     ("listed competitors" / "लिस्टिट कमपेटिटोर्स"), and exact tokens never
     matched — an abandoned take stayed in. skel() is the word's sound
     skeleton in either script: consonants only, voiced/unvoiced and aspirated
     folded together ("listed", "लिस्टिट" → "lst"). Used ONLY to compare two
     takes (same()); the word lists keep their exact tokens. */
  var DEV_SK = { 'क': 'k', 'ख': 'k', 'ग': 'k', 'घ': 'k', 'ङ': 'n', 'च': 'c', 'छ': 'c', 'ज': 'c', 'झ': 'c', 'ञ': 'n',
    'ट': 't', 'ठ': 't', 'ड': 't', 'ढ': 't', 'ण': 'n', 'त': 't', 'थ': 't', 'द': 't', 'ध': 't', 'न': 'n',
    'प': 'p', 'फ': 'p', 'ब': 'p', 'भ': 'p', 'म': 'm', 'र': 'r', 'ल': 'l', 'ळ': 'l', 'व': 'w',
    'श': 's', 'ष': 's', 'स': 's', 'ं': 'n', 'ँ': 'n' };
  var _sk = {};
  function skel(t) {
    if (_sk[t] != null) return _sk[t];
    var s = '', i;
    if (/[\u0900-\u097F]/.test(t)) {
      var d = t.normalize ? t.normalize('NFD') : t;   // क़ → क + nukta: the base sound
      for (i = 0; i < d.length; i++) if (DEV_SK[d[i]]) s += DEV_SK[d[i]];
    } else {
      s = t.replace(/ow$/, 'o').replace(/ti(?=[aeiou])/g, 'sh').replace(/ch/g, 'C').replace(/c(?=[eiy])/g, 's').replace(/g(?=es?$)/g, 'j')   // presence, challenges: soft c and g   // "relationships" says sh: रिलेशन्शिप्स.replace(/[ptkgdb]h/g, function (m) { return m[0]; }).replace(/sh/g, 's').replace(/ph/g, 'p')
        .replace(/[aeiouyhw']/g, function (m) { return m === 'w' ? 'w' : ''; })
        .replace(/[cqgk]/g, 'k').replace(/C/g, 'c').replace(/[jz]/g, 'c').replace(/d/g, 't').replace(/[bf]/g, 'p').replace(/v/g, 'w').replace(/x/g, 'ks');
    }
    s = s.replace(/m/g, 'n').replace(/(.)\1+/g, '$1');   // m/n one nasal: अनुस्वार is "m" before p/b (कंपनी = company)
    return (_sk[t] = s);
  }
  // ponytail: 3+ consonants before two spellings count as one word — shorter skeletons collide ("so"/"se")
  function same(x, y) {
    if (x === y) return true;
    if (!x || !y) return false;
    var a = skel(x);
    return a.length >= 3 && a === skel(y);
  }

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
        cur[j] = same(a[i - 1], b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
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
    for (var i = 0; i < n; i++) if (same(a[i], b[i])) match++;
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
    return A.length > 0 && isNearPrefix(A, B) && same(B[A.length - 1], A[A.length - 1]);
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
    if (OPEN_END[last]) return false;                                  // "I see the, I see the problem": left hanging
    var remark = 0, i;
    for (i = 0; i < u.length; i++) {
      if (REMARK[u[i]] || INTERJ[u[i]]) remark++;
      else if (!FUNC[u[i]] && !FIRST[u[i]] && !SECOND[u[i]] && !EMPHATIC[u[i]]) break;
    }
    if (i === u.length && remark) return true;                         // "bahut accha", "I know", "oh my god"
    // each copy stands alone — a pause mark after BOTH ("…, …, and then")
    return CLOSED.test(rawA) && CLOSED.test(rawB);
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
      for (var j = 0; j < ob.length; j++) if (same(oa[i], ob[j])) return true;
    }
    // an opening made only of glue ("what is the…") must then be re-said as is
    return oa.length >= 2 && ob.length >= 2 && same(oa[0], ob[0]) && same(oa[1], ob[1]);
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
    // A false start and the "arre ruko, ek baar phir se" after it, said
    // without a pause, are ONE phrase — so it matched the full take only by
    // half, and the owner's Hindi retake was kept (v0.10.101). Split where the
    // chatter starts when everything from there on is chatter.
    if (opts.asides !== false) phrases = [].concat.apply([], phrases.map(function (ph) {
      // only where a retry OPENS ("wait", "sorry", "arre", "ruko"…) and the
      // rest says "again" — "I want to stop and go over this again" is a line
      var t = ph.map(function (w) { return norm(w.text); });
      for (var i = 2; i < t.length - 1; i++) {
        if (!RETRY_OPEN[t[i]]) continue;
        var tail = t.slice(i), chat = 0, joinedT = ' ' + tail.join(' ') + ' ';
        tail.forEach(function (x) { if (CHAT_STRONG[x] || CHAT_WEAK[x]) chat++; });
        var again = tail.some(function (x) { return RETRY_AGAIN[x]; }) ||
          CHAT_PHRASES.some(function (ph2) { return joinedT.indexOf(' ' + ph2.split(' ').map(norm).join(' ') + ' ') >= 0; });
        if (again && tail.length <= (opts.maxAsideWords || 8) && chat / tail.length >= 0.75) return [ph.slice(0, i), ph.slice(i)];
      }
      return [ph];
    }));
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
    // a line and its opposite are two things said, not two takes ("AI isn't
    // coming to take your job. Someone using AI will be coming to take your
    // job." — the owner's webinar had the first cut as a retake)
    // ("no" / "nahi" said first or last is the speaker stopping a take — "…blah,
    // no" — not the line saying no)
    var neg = toks.map(function (t) {
      return t.some(function (w, i) { return NEGATION.test(w) || (i > 0 && i < t.length - 1 && NEG_INTERJ.test(w)); });
    });
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
      if (neg[a] !== neg[b]) return false;
      if (ask[a] && !ask[b]) return false;
      if (ask[b] && !ask[a] && ct[a].length >= ct[b].length) return false;
      // "Right, the algorithm rewards…" after "The algorithm rewards…": the
      // other person agreeing and picking the thought up — unless the labels
      // say it is the same voice, or the owner said it is only them. With the
      // speakers unknown (Auto on a plain transcript, the default) a lone
      // speaker's "haan toh aaj hum…" after an UNFINISHED "aaj hum…" is still
      // a restart when it says all of the earlier line again and goes on from
      // its last word; an agreeing reply ends the thought its own way.
      // With "Two or more people" the owner has told us it is a conversation:
      // an agreeing echo always protects the other person's line, however it
      // was punctuated. Whisper often drops the full stop, and "So for me
      // consistency is key," followed by "Exactly, for me consistency is key,
      // and…" was being cut as a false start — the card promises an answer
      // that echoes the question is never cut.
      if (people !== 'one' && (spk[a] == null || spk[b] == null) && agree[b] && !agree[a] &&
          (people === 'many' || isStmt[a] || !carriesOn(ct[a], ct[b]))) return false;
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
        // a line only half like another is a retake when said again soon
        // after; minutes apart it is the next point of an agenda ("We're going
        // to go deeper into…" / "…deeper than that." 26 s apart on Strong)
        var simAB = phraseSim(ct[a], ct[b]);
        if ((simAB >= (st ? Math.max(thresh, 0.8) : thresh) && (simAB >= 0.75 || startOf(b) - endOf(a) <= 20)) ||
            (!st && b - a <= containWin && ct[a].length <= ct[b].length &&
             phraseContain(ct[a], ct[b]) >= containThresh &&
             // a FINISHED short line inside a longer one is an abandoned first
             // take only when the longer one starts the same way; "The tool
             // changed." → "And because the tool changed, the playbook…" builds on it
             (!isStmt[a] || isNearPrefix(ct[a], ct[b]))) ||
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

    // ABANDONED TAKES: an earlier attempt whose words come back, in order, in
    // the speech that follows — split into different phrases than the first
    // time ("returns unpredictable … listed competitors … valuation bannet bro"
    // stopped in a stumble, then "lekin kuch challenges bhi hain, returns
    // unpredictable … / listed / competitors … valuation karna …" 48 s later).
    // Phrase-to-phrase the two never matched (each phrase held only part of
    // the other), so the stumbling take stayed in; the hand edit of the same
    // recording dropped it. One-way and conservative: only the EARLIER phrase is
    // ever cut, it must have 5+ words, and 90% of them must come back (75% when
    // it trails off unfinished — the usual abandoned take; a finished sentence
    // said again later may be a recap).
    if (opts.abandoned !== false && people !== 'many') {   // a conversation: echoes are replies
      for (var ab = 0; ab < P; ab++) {
        if (deleted[ab] || ack[ab] || ct[ab].length < 5) continue;
        // a full stop is weak evidence (Whisper puts one on fragments, and a
        // stumble split off as its own phrase leaves one behind)
        var need = SENT_END.test(ends[ab]) ? 0.82 : 0.75, done = false;
        // a stumble, chatter and the retake can take more than a minute; this
        // pass only ever cuts the earlier, mostly repeated phrase, so it looks a little further
        var abGap = Math.max(maxGapSec, opts.abandonedGapSec || 90);
        for (var bb = ab + 1; bb < P && !done; bb++) {
          if (startOf(bb) - endOf(ab) > abGap) break;
          if (deleted[bb] || (spk[ab] != null && spk[bb] != null && spk[ab] !== spk[bb])) continue;
          // an agreeing reply that says the line again is the OTHER person
          // ("Haan bilkul, …", "जी हाँ, …"): never a take, as in sameLine
          if (agree[bb] && !agree[ab]) continue;
          // the speech that follows from bb, phrase by phrase, about as long as ab and a bit
          var stream = [], last = bb, sNeg = false, sAsk = false, sQ = false;
          for (var sb = bb; sb < P && stream.length < ct[ab].length * 1.6 + 4; sb++) {
            if (sb > bb && startOf(sb) - endOf(sb - 1) > 3) break;
            stream = stream.concat(ct[sb]); last = sb;
            sNeg = sNeg || neg[sb]; sAsk = sAsk || ask[sb]; sQ = sQ || isQ[sb];
          }
          if (stream.length < ct[ab].length) continue;   // the later version must be at least as full
          // sameLine's guards, over the whole stretch: a "ना" or a question word
          // may sit in the stretch's second phrase, not its first
          if (sNeg !== neg[ab] || (ask[ab] && !sAsk) || (isQ[ab] !== sQ && isQ[ab])) continue;
          if (lcsLen(ct[ab], stream) / ct[ab].length >= need) {
            deletes.push(cutOf(ab, 'abandoned take'));
            removedWords += phrases[ab].length;
            deleted[ab] = inRetakeGroup[ab] = true;
            done = true;
            // false starts leading into it ("October 26 / October / October 2026
            // ke report…" before the real take): short phrases right before,
            // each within 6 s of the next, mostly said again in the good take
            for (var pb = ab - 1; pb >= 0 && !deleted[pb] && startOf(pb + 1) - endOf(pb) <= 6 &&
                 ct[pb].length >= 1 && ct[pb].length <= 4 && 2 * lcsLen(ct[pb], stream) >= ct[pb].length; pb--) {
              deletes.push(cutOf(pb, 'false start'));
              removedWords += phrases[pb].length;
              deleted[pb] = inRetakeGroup[pb] = true;
            }
            // the stumble that ended it ("…valuation bannet bro"), split off as a
            // phrase of its own: short, right after it, and mostly not said in the retake
            var tl = ab + 1;
            if (tl < P && tl < bb && !deleted[tl] && ct[tl].length && ct[tl].length <= 3 && startOf(tl) - endOf(ab) <= 1 &&
                2 * lcsLen(ct[tl], stream) <= ct[tl].length) {   // mostly not said again (a sound-alike may match by chance)
              deletes.push(cutOf(tl, 'abandoned take'));
              removedWords += phrases[tl].length;
              deleted[tl] = inRetakeGroup[tl] = true;
            }
          }
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
      var STRONG = CHAT_STRONG, WEAK = CHAT_WEAK, PHRASES = CHAT_PHRASES;
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

  /* How alike two spoken words are, in any spelling or script: 2 the same word,
   0.6 the same short word, 0.3 only a hint ("है"/"hai"), -1.5 different. */
  function wordSc(a, b) {
    // a different word costs more than leaving one out on each side (≈0.85), so a
    // retake is never soaked up as "said differently" against the next line
    if (!a || !b) return -1.5;
    if (a === b) return 2;
    // a number cut short and said again: "October 26 … October 2026"
    if (/^\d{2,}$/.test(a) && /^\d{2,}$/.test(b) && (a.slice(-b.length) === b || b.slice(-a.length) === a)) return 0.6;
    var x = skel(a), y = skel(b);
    if (!x && !y && a.length <= 4 && b.length <= 4) return 0.3;   // "है"/"hai": all vowel and h — a hint, never enough to cut
    if (x && y && x !== y && Math.min(x.length, y.length) >= 4 && skelDist(x, y) <= (Math.min(x.length, y.length) >= 8 ? 2 : 1)) return 1;   // misheard: "returns"/"रिटेंस"
    if (!x || x !== y) return -1.5;
    return x.length >= 3 ? 2 : 0.6;                    // short words ("ka"/"की") anchor only weakly
  }
  // edit distance between two sound skeletons, stopping early past 2
  function skelDist(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    var prev = [], cur, i, j;
    for (j = 0; j <= b.length; j++) prev.push(j);
    for (i = 1; i <= a.length; i++) {
      cur = [i];
      for (j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
      prev = cur;
    }
    return prev[b.length];
  }

  /* A run of spoken words the script alignment left out: a FALSE START (said
     again right after — or a stutter of what was just said) → true, cut it;
     or the owner changing a line / ad-libbing → false, keep it.
       run    — the left-out words (normalized), 1–6 of them
       before — up to 8 words spoken just before it that ARE in the script
       after  — up to 8 words spoken just after it that ARE in the script
       sc(a,b)— how alike two words sound: 2 same word (any spelling),
                0.6 same short word ("ka"/"की"), -1.5 different
     Examples from the test video:
       run "लेकिन कुछ चैलेंजिस भी हैं"  after "लेकिन कुछ challenges भी हैं रिटर्न…"  → true
       run "Infrastructure"             before "बड़े institutions का पैसा"
                                        after "commercial real estate और"         → false */
  function isFalseStart(run, before, after, sc) {
    // in-order overlap of the run with a stretch of speech: [matched words, strong ones]
    function ordered(x, y) {
      var L = [], S = [], i, j;
      for (i = 0; i <= x.length; i++) { L.push([]); S.push([]); for (j = 0; j <= y.length; j++) { L[i].push(0); S[i].push(0); } }
      for (i = 1; i <= x.length; i++) for (j = 1; j <= y.length; j++) {
        var v = sc(x[i - 1], y[j - 1]);
        if (v >= 0.6 && L[i - 1][j - 1] + 1 >= Math.max(L[i - 1][j], L[i][j - 1])) { L[i][j] = L[i - 1][j - 1] + 1; S[i][j] = S[i - 1][j - 1] + (v >= 2 ? 1 : 0); }
        else if (L[i - 1][j] >= L[i][j - 1]) { L[i][j] = L[i - 1][j]; S[i][j] = S[i - 1][j]; }
        else { L[i][j] = L[i][j - 1]; S[i][j] = S[i][j - 1]; }
      }
      return [L[x.length][y.length], S[x.length][y.length]];
    }
    var need = Math.ceil(run.length * 0.6), k = run.length + 2, r;
    // a restart: said again straight away. The run may restart more than once
    // ("October 26 October 2026" before "October 2026 CARE…"): from its LAST
    // restart on it must match in order; every word before that must be said
    // again too (one stray opening word — "लेकिन" before "कुछ…" — is allowed)
    var r0 = -1, a, q;
    for (a = run.length - 1; a >= 0 && r0 < 0; a--) for (q = 0; q < Math.min(2, after.length); q++) if (sc(run[a], after[q]) >= 0.6) { r0 = a; break; }
    if (r0 >= 0) {
      var tail = run.slice(r0), head = run.slice(0, r0), said = 0;
      r = ordered(tail, after.slice(0, tail.length + 2));
      for (a = 0; a < head.length; a++) for (q = 0; q < Math.min(after.length, k + 2); q++) if (sc(head[a], after[q]) >= 0.6) { said++; break; }
      var headOk = said === head.length || (head.length === 1 && r0 === 1);
      if (headOk && r[0] >= Math.ceil(tail.length * 0.6) && r[1] + (said ? 1 : 0) >= 1 && (r[1] >= 1 || tail.length + head.length >= 2)) return true;
    }
    // a stutter: what was just said, said again
    if (before.length && sc(run[run.length - 1], before[before.length - 1]) >= 0.6) {
      r = ordered(run, before.slice(-k));
      if (r[0] >= need && r[1] >= 1) return true;
    }
    return false;
  }

  /* 📜 Retakes from the script. The owner nearly always has the script, and a
     take that is IN the script but not the take they kept is a retake —
     however far back it is and however it was split into phrases.
     The whole script is aligned to the whole transcript once (Gotoh: a run of
     spoken words left out costs once to open, almost nothing to extend, so the
     alignment keeps ONE complete take, not words picked from two). Read back
     from the end, a tie goes to the LATER take — the one the owner kept.
     Spoken words the alignment leaves out:
       · that repeat the script nearby → an earlier / abandoned take → cut;
       · anything else is the owner speaking off-script (a changed line, an
         ad-lib) → kept. Words said differently from the script stay too.
     words: [{start,end,text}] · script: array of script words
     → { deletes:[{start,end,text,reason}], matched, rate } */
  function scriptTakes(words, script, opts) {
    opts = opts || {};
    var T = (words || []).map(function (w) { return norm(w.text); }), S = (script || []).map(norm);
    // the script's sentences (its punctuation — the transcript often has none)
    var sid = [], sn = 0;
    for (var si = 0; si < (script || []).length; si++) { sid.push(sn); if (SENT_END.test(String(script[si]))) sn++; }
    var n = T.length, m = S.length;
    if (n < 4 || m < 4) return { deletes: [], matched: 0, rate: 0 };
    // ponytail: n×m direction bytes (3 per cell) — ~25 MB for a 25-minute talk; band it if longer talks need it
    if (n * m > 9e6) return { deletes: [], matched: 0, rate: 0, tooLong: true };
    var sc = wordSc;
    var MATCH_MIN = 0.6, OPEN = 2.5, EXT = 0.05, SKIP_S = 0.8, LATE = 0.002;   // LATE ≪ EXT: breaks ties only
    var NEG = -1e9, W = m + 1;
    // M: i,j aligned (match or said-differently) · X: transcript word i skipped · Y: script word j not said
    var dM = new Uint8Array((n + 1) * W), dX = new Uint8Array((n + 1) * W), dY = new Uint8Array((n + 1) * W);
    var pM = new Float64Array(W), pX = new Float64Array(W), pY = new Float64Array(W);
    var cM = new Float64Array(W), cX = new Float64Array(W), cY = new Float64Array(W), i, j;
    for (j = 0; j <= m; j++) { pM[j] = NEG; pX[j] = NEG; pY[j] = j ? -SKIP_S * j : 0; }
    pM[0] = 0;
    function best3(a, b, c) { return a >= b ? (a >= c ? 0 : 2) : (b >= c ? 1 : 2); }
    for (i = 1; i <= n; i++) {
      // words before the script starts are free to leave out (warm-up, "rolling")
      cM[0] = NEG; cY[0] = NEG; cX[0] = 0;
      for (j = 1; j <= m; j++) {
        // + a tiny lean to LATER words: two complete takes score the same, and the owner keeps the last
        var k = i * W + j, s = sc(T[i - 1], S[j - 1]) + LATE * i / n;
        var a = pM[j - 1], b = pX[j - 1], c = pY[j - 1], f = best3(a, b, c);
        cM[j] = (f === 0 ? a : f === 1 ? b : c) + s; dM[k] = f;
        a = pM[j] - OPEN; b = pX[j] - EXT; c = pY[j] - OPEN; f = best3(a, b, c);
        cX[j] = f === 0 ? a : f === 1 ? b : c; dX[k] = f;
        a = cM[j - 1] - SKIP_S; b = cX[j - 1] - SKIP_S; c = cY[j - 1] - SKIP_S; f = best3(a, b, c);
        cY[j] = f === 0 ? a : f === 1 ? b : c; dY[k] = f;
      }
      var t;
      t = pM; pM = cM; cM = t; t = pX; pX = cX; cX = t; t = pY; pY = cY; cY = t;
    }
    // words after the script ends are free too: best end over every i on the last script word
    // (only the final row's scores are kept, so trailing words count as skipped from the last row)
    var state = best3(pM[m], pX[m], pY[m]);
    var at = new Int32Array(n).fill(-1);    // transcript word → script word it stands for (-1: left out)
    i = n; j = m;
    while (i > 0 && j > 0) {
      var kk = i * W + j;
      if (state === 0) {
        if (sc(T[i - 1], S[j - 1]) >= MATCH_MIN) at[i - 1] = j - 1; else at[i - 1] = -2;   // -2: said differently, kept
        state = dM[kk]; i--; j--;
      } else if (state === 1) { state = dX[kk]; i--; }
      else { state = dY[kk]; j--; }
    }
    // left-out runs: cut the ones that repeat the script around where they sit
    var deletes = [], matched = 0, pos = new Int32Array(n), lastJ = -1;
    for (i = 0; i < n; i++) { if (at[i] >= 0) { matched++; lastJ = at[i]; } pos[i] = lastJ; }
    for (i = 0; i < n; ) {
      if (at[i] !== -1) { i++; continue; }
      // a run ends at a long pause: what comes after it is another attempt
      var e = i; while (e + 1 < n && at[e + 1] === -1 && words[e + 1].start - words[e].end < 1) e++;
      // the words spoken AND in the script right around the run (up to 8 each side)
      var run = [], before = [], after = [], r;
      for (r = i; r <= e; r++) if (T[r]) run.push(T[r]);
      for (r = i - 1; r >= 0 && before.length < 8; r--) if (at[r] !== -1 && T[r]) before.unshift(T[r]);
      for (r = e + 1; r < n && after.length < 8; r++) if (at[r] !== -1 && T[r]) after.push(T[r]);
      // ponytail: fragments only (≤6 words / 4 s). Choosing between two COMPLETE takes is
      // findRepeatedTakes' job — both match the script alike, so alignment can't pick the kept one.
      // (up to 6 s for 4 words or fewer: a stumbled word is often stretched — "October" over 2 s)
      var rdur = words[e].end - words[i].start;
      var short = run.length <= (opts.maxWords || 6) && (rdur <= (opts.maxSec || 4) || (run.length <= 4 && rdur <= 6));
      if (short && run.length && isFalseStart(run, before, after, sc)) {
        // an abandoned attempt is cut from the pause before it, the way the owner
        // cuts — not mid-phrase ("11,009 | Client Relationships…" goes whole);
        // never more than 3 words back and never past a sentence's end
        // the retake's script sentence: back-extension stays inside it, and a
        // left-out word that ends the sentence before ("…kar rahi | hai") stays
        var ka = e + 1; while (ka < n && at[ka] < 0) ka++;
        var tgt = ka < n ? sid[at[ka]] : -1, p0 = pos[i], s0 = i;
        while (s0 < e && p0 + 1 < m && sid[p0 + 1] !== tgt && sc(T[s0], S[p0 + 1]) > 0) { s0++; p0++; }
        if (s0 === i) while (s0 > 0 && i - s0 < 3 && words[s0].start - words[s0 - 1].end < 0.25 && !SENT_END.test(String(words[s0 - 1].text || '')) &&
               (at[s0 - 1] < 0 || sid[at[s0 - 1]] === tgt)) s0--;
        var w0 = words[s0], w1 = words[e];
        deletes.push({ start: w0.start, end: e + 1 < n ? Math.max(w1.end, Math.min(words[e + 1].start, w1.end + 0.25)) : w1.end,
          text: words.slice(s0, e + 1).map(function (w) { return w.text; }).join(' '), reason: 'not the take in your script' });
      } else {
        var sw = laterTake(i, e);
        if (sw) deletes.push(sw);
      }
      i = e + 1;
    }
    /* The LATER take of a line, left out because an earlier one was matched
       first ("October 2026 CARE report…" at 61 s, said again at 96 s and
       carried straight on into the rest of the sentence). The owner keeps the
       last take, so the earlier one is cut — only when the later run re-says
       those script words in order (2+ real words), is at least as complete,
       and flows straight into the script's next words. */
    function laterTake(i0, e0) {
      var p = pos[i0], lo = Math.max(0, p - (e0 - i0 + 1) * 2 - 4);
      if (p < 0 || e0 - i0 < 2) return null;
      var xs = [], k, q;
      for (k = i0; k <= e0; k++) if (T[k]) xs.push(k);
      // in-order match of the run against the script just before p → its script indices
      var A = xs.length, B = p - lo + 1, L = [], a, b;
      for (a = 0; a <= A; a++) { L.push(new Int16Array(B + 1)); }
      for (a = 1; a <= A; a++) for (b = 1; b <= B; b++)
        L[a][b] = sc(T[xs[a - 1]], S[lo + b - 1]) >= 0.6 ? L[a - 1][b - 1] + 1 : Math.max(L[a - 1][b], L[a][b - 1]);
      var qs = [], strong = 0;
      for (a = A, b = B; a > 0 && b > 0; ) {
        if (sc(T[xs[a - 1]], S[lo + b - 1]) >= 0.6 && L[a][b] === L[a - 1][b - 1] + 1) { qs.push(lo + b - 1); if (sc(T[xs[a - 1]], S[lo + b - 1]) >= 2) strong++; a--; b--; }
        else if (L[a - 1][b] >= L[a][b - 1]) a--; else b--;
      }
      if (qs.length < Math.max(3, Math.ceil(A * 0.5)) || strong < 2) return null;   // misheard names ("एडिल वाइस") don't match
      var qa = Math.min.apply(null, qs), qb = Math.max.apply(null, qs);
      // the earlier stretch matched to those script words
      var E = [];
      for (k = 0; k < i0; k++) if (at[k] >= qa && at[k] <= qb) E.push(k);
      if (E.length < 3 || E.length * 0.8 > qs.length) return null;    // the later run is (about) as complete
      // it flows on: the next matched word comes straight after and goes on in the script
      for (k = e0 + 1; k < n && at[k] === -1; k++);
      if (k >= n || at[k] <= qb || words[k].start - words[e0].end > 2) return null;
      var f = E[0], l = E[E.length - 1];
      while (f > 0 && E[0] - f < 3 && words[f].start - words[f - 1].end < 0.25 && !SENT_END.test(String(words[f - 1].text || ''))) f--;
      // …and to the end of that attempt: words said on without a pause that the later take re-says too
      var reach = at[k];
      while (l + 1 < i0 && l - E[E.length - 1] < 3 && words[l + 1].start - words[l].end < 0.25 && (at[l + 1] < 0 || at[l + 1] < reach) &&
             !SENT_END.test(String(words[l].text || ''))) l++;
      // and the off-script words said straight after it ("…valuation. Bonnet! Bro!") —
      // the reaction to the attempt, before the owner starts again
      var le = l;
      while (l + 1 < i0 && l - le < 4 && at[l + 1] === -1 && words[l + 1].start - words[l].end < 1) l++;
      return { start: words[f].start, end: Math.max(words[l].end, Math.min(l + 1 < n ? words[l + 1].start : words[l].end, words[l].end + 0.25)),
        text: words.slice(f, l + 1).map(function (w) { return w.text; }).join(' '), reason: 'an earlier take (your script, said again later)' };
    }
    return { deletes: deletes, matched: matched, rate: matched / Math.max(1, Math.min(n, m)), at: opts.debug ? at : undefined };
  }

  /* 📜 Script mode: ONE take per script line. A recording made line by line
     (Ashish's: every section 3–5 times, out of order, with the crew talking in
     between) can't be untangled by pauses and nearby repeats — but with the
     script it is simple: every take of a line but the LAST complete one is a
     retake, and talk that is in no line is chatter.
       · takes of a sentence: in-order matches of ≥55% of its words (2+ real ones)
       · kept: the last take at least 85% as complete as its best
       · cut: the other takes; off-script stretches of 3+ words — unless they look
         like a line with no take found (a garbled transcript must not lose it)
     Nothing at all when under 40% of the sentences are found (another script).
     words: [{start,end,text}] (heard words) · script: the script's words as written
     → { deletes, found, sentences, missing:[text] } */
  function scriptKeep(words, script, opts) {
    opts = opts || {};
    // the script as text: each line ends a sentence too (bullet lines have no full stop)
    if (typeof script === 'string') script = [].concat.apply([], script.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').split(/\r?\n/)
      .map(function (ln) { return ln.split(/\s+/).filter(Boolean).concat(['\n']); }));
    var sents = [], cur = [];
    (script || []).forEach(function (w) {
      var t = w === '\n' ? '' : norm(w); if (t) cur.push(t);
      if (w === '\n' || SENT_END.test(String(w)) || /[:：]$/.test(String(w))) { if (cur.length >= 2) sents.push(cur); cur = []; }
    });
    if (cur.length >= 2) sents.push(cur);
    var n = (words || []).length, T = (words || []).map(function (w) { return norm(w.text); });
    var none = { deletes: [], found: 0, sentences: sents.length, missing: [] };
    if (n < 10 || sents.length < 2) return none;
    var MIN_COV = opts.minCov || 0.55, NEAR_BEST = 0.75;
    // in-order matches of a sentence inside a stretch of words → [pairs], strong count
    function lcs(Q, i0, i1) {
      var A = Q.length, B = i1 - i0, L = [], a, b;
      for (a = 0; a <= A; a++) L.push(new Int16Array(B + 1));
      for (a = A - 1; a >= 0; a--) for (b = B - 1; b >= 0; b--)
        L[a][b] = wordSc(Q[a], T[i0 + b]) >= 0.6 ? L[a + 1][b + 1] + 1 : Math.max(L[a + 1][b], L[a][b + 1]);
      var pairs = [], strong = 0;
      for (a = 0, b = 0; a < A && b < B; ) {
        var v = wordSc(Q[a], T[i0 + b]);
        if (v >= 0.6 && L[a][b] === L[a + 1][b + 1] + 1) { pairs.push(i0 + b); if (v >= 1) strong++; a++; b++; }   // near matches count: real evidence
        else if (L[a + 1][b] >= L[a][b + 1]) a++; else b++;
      }
      return { pairs: pairs, strong: strong };
    }
    var takes = [], chosen = [], missing = [], k, i;
    for (k = 0; k < sents.length; k++) {
      var Q = sents[k], q = Q.length, cands = [];
      for (i = 0; i < n; i++) {
        if (!T[i]) continue;
        var open = false;
        for (var o = 0; o < Math.min(3, q) && !open; o++) if (wordSc(T[i], Q[o]) >= 0.6) open = true;
        if (!open) continue;
        var r = lcs(Q, i, Math.min(n, i + Math.ceil(q * 1.6) + 3));
        var cov = r.pairs.length / q;
        if (cov >= MIN_COV && r.strong >= Math.min(2, q - 1)) cands.push({ k: k, s: r.pairs[0], e: r.pairs[r.pairs.length - 1], cov: cov });
      }
      // one candidate per place: the most complete, then the tightest
      cands.sort(function (x, y) { return (y.cov - x.cov) || ((x.e - x.s) - (y.e - y.s)); });
      var uniq = [];
      cands.forEach(function (c) {
        if (!uniq.some(function (u) { var ov = Math.min(u.e, c.e) - Math.max(u.s, c.s) + 1; return ov > 0.5 * Math.min(u.e - u.s + 1, c.e - c.s + 1); })) uniq.push(c);
      });
      if (!uniq.length) { missing.push(k); continue; }
      var best = uniq[0].cov, pick = null;
      uniq.forEach(function (c) { if (c.cov >= best * NEAR_BEST && (!pick || c.s > pick.s)) pick = c; });   // the LAST complete take
      // the take's own first / last words can be weak matches ("…kar rahi | hai."):
      // up to 2 more each side, said without a pause, that sound like the sentence's ends
      var ends = Q.slice(-3), opens = Q.slice(0, 3), x2;
      for (x2 = 0; x2 < 2 && pick.e + 1 < n && words[pick.e + 1].start - words[pick.e].end < 0.35 &&
           ends.some(function (t) { return wordSc(T[pick.e + 1], t) > 0; }); x2++) pick.e++;
      for (x2 = 0; x2 < 2 && pick.s > 0 && words[pick.s].start - words[pick.s - 1].end < 0.35 &&
           opens.some(function (t) { return wordSc(T[pick.s - 1], t) > 0; }); x2++) pick.s--;
      chosen.push(pick);
      uniq.forEach(function (c) { if (c !== pick) { c.better = c.cov > pick.cov + 0.1; takes.push(c); } });
    }
    if (chosen.length < sents.length * 0.4) return none;
    var keep = new Uint8Array(n), take = new Uint8Array(n), any = new Uint8Array(n);
    chosen.forEach(function (c) { for (var x = c.s; x <= c.e; x++) keep[x] = 1; });
    // doubt: a cut take that matches the script BETTER than the kept one, or a short
    // off-script stretch (could be a line the transcript garbled) — asked, not cut
    var doubt = new Uint8Array(n);
    takes.forEach(function (c) { for (var x = c.s; x <= c.e; x++) { take[x] = 1; any[x] = 1; if (c.better) doubt[x] = 1; } });
    // a stretch in no line: chatter — unless it looks like a line still missing
    function likeMissing(i0, i1) {
      for (var mi = 0; mi < missing.length; mi++) {
        var Qm = sents[missing[mi]], lm = lcs(Qm, i0, i1 + 1);
        if (lm.pairs.length >= Math.max(3, Qm.length * 0.4) && lm.strong >= 1) return true;
      }
      return false;
    }
    var cut = new Uint8Array(n);
    for (i = 0; i < n; i++) if (take[i] && !keep[i]) cut[i] = 1;
    for (i = 0; i < n; ) {
      if (keep[i] || any[i]) { i++; continue; }
      var e = i; while (e + 1 < n && !keep[e + 1] && !any[e + 1]) e++;
      var said = 0; for (var x = i; x <= e; x++) if (T[x]) said++;
      if (said >= 3 && !likeMissing(i, e)) for (x = i; x <= e; x++) { cut[x] = 1; if (said < 6) doubt[x] = 1; }
      i = e + 1;
    }
    // a word or two left between two cuts belongs with them; a piece with no text goes with the word before
    for (i = 1; i < n; i++) if (!T[i] && cut[i - 1]) cut[i] = 1;
    for (i = 0; i < n; ) {
      if (cut[i] || keep[i]) { i++; continue; }
      var e2 = i; while (e2 + 1 < n && !cut[e2 + 1] && !keep[e2 + 1]) e2++;
      if (e2 - i < 2 && i > 0 && e2 + 1 < n && cut[i - 1] && cut[e2 + 1]) for (x = i; x <= e2; x++) cut[x] = 1;
      i = e2 + 1;
    }
    var deletes = [];
    for (i = 0; i < n; ) {
      if (!cut[i]) { i++; continue; }
      var e3 = i; while (e3 + 1 < n && cut[e3 + 1] && doubt[e3 + 1] === doubt[i]) e3++;   // sure and doubtful cuts kept apart
      var dl = { start: words[i].start, end: e3 + 1 < n ? Math.max(words[e3].end, Math.min(words[e3 + 1].start, words[e3].end + 0.25)) : words[e3].end,
        text: words.slice(i, e3 + 1).map(function (w) { return w.text; }).join(' '),
        reason: any[i] ? 'another take of a line in your script' : 'not in your script' };
      if (doubt[i]) dl.needsReview = true;   // the panel lists it to check instead of cutting it
      deletes.push(dl);
      i = e3 + 1;
    }
    return { deletes: deletes, found: chosen.length, sentences: sents.length,
      missing: missing.map(function (mk) { return sents[mk].join(' '); }), chosen: opts.debug ? chosen : undefined };
  }

  /* 📜 Script mode by ATTEMPT. A take-by-take recording (Ashish's: each section
     3–5 times, the crew talking in between) is speech blocks separated by
     pauses — and an editor keeps or drops whole attempts, never splices inside
     one. Each attempt is placed in the script by local alignment (sound
     skeletons, so a half-garbled attempt still finds its lines); an attempt
     another one re-says (80% of its script words) is cut — the later wins,
     unless it is clearly broken off (under 60% of the other's words). Speech
     that says no line is chatter, cut unless it looks like a line nobody kept.
     With word-level script mode: Ashish, speech only, kept-but-you-cut 82 s →
     37 s, no script line lost; Edelweiss unchanged.
     grid: CPSilence.combineMics' grid (peak, state, hop, n, t0) · speechDb: the
     voice's speech level · → { deletes, attempts } */
  function scriptAttempts(words, grid, speechDb, scriptText, opts) {
    opts = opts || {};
    var none = { deletes: [], attempts: 0 };
    if (!grid || !grid.peak || !isFinite(speechDb) || !scriptText || !(words || []).length) return none;
    var PAUSE = opts.pause || 1.0, quietDb = speechDb - 12, step = Math.max(1, Math.round(0.1 / grid.hop)), blk = step * grid.hop;
    // 1. attempts: speech between pauses of PAUSE or more (0.1 s blocks under speech − 12 dB)
    var loud = [], g, k;
    for (g = 0; g < grid.n; g += step) { var mx = -99; for (k = g; k < g + step && k < grid.n; k++) mx = Math.max(mx, grid.peak[k]); loud.push(mx >= quietDb); }
    var att = [], s0 = -1, last = -1, b;
    for (b = 0; b <= loud.length; b++) {
      var on = b < loud.length && loud[b];
      if (on) { if (s0 < 0) s0 = b; last = b; }
      else if (s0 >= 0 && ((b - last) * blk >= PAUSE || b === loud.length)) { att.push({ start: grid.t0 + s0 * blk, end: grid.t0 + (last + 1) * blk }); s0 = -1; }
    }
    // 2. the script's words with sentence numbers (a line or a full stop ends one)
    var S = [], sid = [], sn = 0;
    String(scriptText).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').split(/\r?\n/).forEach(function (line) {
      line.split(/\s+/).forEach(function (w) { if (!w) return; var t = norm(w); if (t) { S.push(t); sid.push(sn); } if (SENT_END.test(w) || /[:：]$/.test(w)) sn++; });
      sn++;
    });
    var m = S.length;
    if (m < 20) return none;
    // 3. each attempt's place in the script: local alignment, match +2 / +1, mismatch or gap −1
    att.forEach(function (a) {
      a.w = words.filter(function (w) { return w.text && (w.start + w.end) / 2 >= a.start && (w.start + w.end) / 2 < a.end; });
      var A = [], i, j; a.w.forEach(function (w) { var t = norm(w.text); if (t) A.push(t); });
      var n = A.length; a.n = n; a.pos = {}; a.size = 0;
      if (n < 2) return;
      var H = [], D = [], best = 0, bi = 0, bj = 0;
      for (i = 0; i <= n; i++) { H.push(new Float32Array(m + 1)); D.push(new Uint8Array(m + 1)); }
      for (i = 1; i <= n; i++) for (j = 1; j <= m; j++) {
        var v = wordSc(A[i - 1], S[j - 1]), sc = v >= 2 ? 2 : v >= 0.6 ? 1 : -1, h = H[i - 1][j - 1] + sc, d = 1;
        if (H[i - 1][j] - 1 > h) { h = H[i - 1][j] - 1; d = 2; }
        if (H[i][j - 1] - 1 > h) { h = H[i][j - 1] - 1; d = 3; }
        if (h <= 0) { h = 0; d = 0; }
        H[i][j] = h; D[i][j] = d;
        if (h > best) { best = h; bi = i; bj = j; }
      }
      for (i = bi, j = bj; i > 0 && j > 0 && D[i][j]; ) {
        var dd = D[i][j];
        if (dd === 1) { if (wordSc(A[i - 1], S[j - 1]) >= 0.6 && !a.pos[j - 1]) { a.pos[j - 1] = 1; a.size++; } i--; j--; }
        else if (dd === 2) i--; else j--;
      }
    });
    // 4. an attempt another re-says is cut: the later wins unless clearly broken off
    var sp = att.filter(function (a) { return a.size >= 3; });
    sp.forEach(function (a) {
      a.cut = sp.some(function (o) {
        if (o === a) return false;
        var ov = 0; for (var p in a.pos) if (o.pos[p]) ov++;
        return ov >= 0.8 * a.size && (o.start > a.start ? o.size >= 0.6 * a.size : a.size < 0.6 * o.size);
      });
    });
    // 5. chatter: speech that says no line — unless it looks like a line nobody kept
    var lineKept = {};
    sp.forEach(function (a) { if (!a.cut) for (var p in a.pos) lineKept[sid[p]] = 1; });
    att.forEach(function (a) {
      if (a.size >= 3 || !(a.n >= 2)) return;
      var lost = 0; for (var p in a.pos) if (!lineKept[sid[p]]) lost++;
      a.cut = lost < 2; a.chatter = true;
    });
    var deletes = att.filter(function (a) { return a.cut; }).map(function (a) {
      return { start: a.start, end: a.end, text: a.w.map(function (w) { return w.text; }).join(' '),
        reason: a.chatter ? 'not in your script' : 'another take of a line in your script' };
    });
    return { deletes: deletes, attempts: att.length };
  }

  return {
    scriptAttempts: scriptAttempts,
    scriptKeep: scriptKeep,
    scriptTakes: scriptTakes,
    findRepeatedTakes: findRepeatedTakes, flatten: flatten, tidyDeletes: tidyDeletes,
    phraseSim: phraseSim, phraseContain: phraseContain, isNearPrefix: isNearPrefix,
    lcsLen: lcsLen, splitPhrases: splitPhrases, _norm: norm, _skel: skel, _wordSc: wordSc
  };
});
