# Moment selection and framing for podcast shorts

Evidence grades: **strong** = peer-reviewed, large sample, replicated or field-tested at scale; **moderate** = peer-reviewed but on a nearby domain (news, ads) or a single large study; **weak** = small sample, vendor or practitioner claim, or no outcome data; **myth** = popular claim with no supporting data, or with data against it. Each finding ends with **Rule:**, a check an automatic clipper could run.

Searches ran on 2026-10-21. About 18 tool calls; several primary PDFs could not be read (see Gaps).

## 1. Content signals that predict virality and shareability

### Takeaway
The most reliable content predictors are **high-arousal emotion** (awe, anger, anxiety, amusement, surprise beat low-arousal sadness), **drama or story structure**, and **a self-contained setup and payoff**. Plain "information-focused" content is shared *less* unless it carries risk or practical stakes. On short video, **creator popularity outweighs content features**, so content scores only move the odds and never guarantee a viral clip.

### Cited Findings
- **High-arousal emotion drives sharing. Strong (classic, partly replicated).** Berger & Milkman (JMR 2012) analysed nearly 7,000 NYT articles over about 3 months; roughly 20% made the most-emailed list. Content evoking high-arousal emotion was more viral, whether positive (awe) or negative (anger, anxiety), and low-arousal sadness was shared less. — [Scientific American summary](https://www.scientificamerican.com/article/the-secret-to-online-success-what-makes-content-go-viral); [paper PDF](https://faculty.wharton.upenn.edu/wp-content/uploads/2011/11/Virality.pdf)
  - **Replication is partial.** Heimbach & Hinz (IJRM 2016, German news magazine) "could not replicate all the effects" but found results consistent across channels. — [IDEAS/RePEc](https://ideas.repec.org/a/eee/ijrema/v33y2016i3p695-701.html). A Norwegian thesis (2015, n=108 Facebook-shared articles) found high arousal, social currency and practical usefulness frequent in shared news, but not identical effects. — [DUO, Univ. of Oslo](https://www.duo.uio.no/handle/10852/49755)
  - **Rule:** Have the LLM rate each candidate's dominant emotion and its arousal level (1–5). Boost high-arousal awe, anger, indignation, amusement and surprise; penalise low-arousal sad or reflective tone. Use this as a boost, never a hard filter.
- **Positive emotion created through drama beats information. Moderate (YouTube video ads, 2 field studies, 11 emotions, 60+ characteristics, J. Marketing 2019).** Tellis, MacInnis, Tirunillai & Zhang found that information-focused content has a significantly negative effect on sharing, except in risky contexts. Amusement, excitement, inspiration and warmth drive sharing, and these come from drama (plot and characters) and surprise. — [AMA, JM Insights (2020)](https://www.ama.org/2020/06/11/what-drives-virality-sharing-of-online-digital-content-the-critical-role-of-information-emotion-and-brand-prominence/); [Baylor summary (2020)](https://kellercenter.hankamer.baylor.edu/news/story/2020/riding-wave-how-make-your-videos-go-viral)
  - **Rule:** Down-rank pure explainer or list segments ("there are three types of X") unless they carry stakes: risk, money, health, or a mistake to avoid. Up-rank segments with a character, a conflict and a turn.
- **Creator popularity is the strongest TikTok predictor; close-up and medium shots, on-screen text and point of view also matter. Moderate (n=400 labelled TikToks, WebSci 2022).** — [Ling et al., arXiv 2111.02452](https://arxiv.org/abs/2111.02452)
  - **Rule:** Clip scores cannot predict absolute views across channels. Calibrate any score only against the user's own channel history. Always burn in on-screen text, and frame faces in close-up or medium shot (see section 5).
- **Popular TikToks mostly evoke happiness (58%) and surprise (24%). Weak (industry content analysis by Semrush, not peer-reviewed; date not confirmed).** — [PR Daily](https://www.prdaily.com/?p=322541)
- **A journal paper on arousal and valence in short-video virality is listed for *Computers in Human Behavior* vol. 184 (2026).** I could not read its findings, so treat it as a lead only. — [Shelepenkov & Kosonogov, NYU IFP listing](https://ifp.nyu.edu/2026/journal-article-abstracts/s0747563226001573/)
- **Humor in short-form ads supports engagement through attention, comprehension and recall, "but this effect is not automatic" and depends on execution. Weak (single regional study on ads).** — [Shahen, Benha Univ.](https://fapa.stafpu.bu.edu.eg/Advertisement/6599/publications/Mohamed%20Yousry%20Shahen_The%20Use%20of%20Humor%20in%20the%20Visual%20Content%20of%20Short%20Form%20Video%20Advertisements%20on%20Social%20Media%20and%20Its%20Relationship%20to%20Active%20Engagement%20with%20the%20Advertising%20Message.pdf)
- **Self-contained moments are the target unit. Strong (Spotify, field-tested).** Spotify defines a good podcast preview as "engaging, self-contained moments that are easy to understand without additional context." Its prompt also requires complete thoughts at start and end, no ads or self-promotion, emotional resonance, valuable insight and a fit with the episode's central theme (2025). — [Zhu et al., Spotify, arXiv 2505.23908](https://arxiv.org/html/2505.23908v1)
  - **Rule:** Reject any candidate whose first sentence needs earlier context: an unresolved pronoun ("he", "that", "this thing"), "so", "and", "but", "like I said", or an answer to a question that is not in the clip. Reject sponsor reads and self-promo ("link in the description", "our sponsor", "use code").
- **Vendor-stated selection criteria all converge on setup, insight and payoff. Weak (vendor claims, no outcome data).** Vizard v2 (July 2026) says each clip holds "the setup, the insight, and the payoff" and narrows an hour to about 13 clips. — [Vizard blog](https://vizard.ai/blog/meet-vizard-model-v2-full-context-clips-that-the-algorithm-actually-rewards). Opus Clip scores Hook, Flow, Value and Trend. — [Opus help](https://help.opus.pro/docs/article/virality-score)
- **Numbers and specifics.** I found no direct study of short video; see Gaps. Tellis et al. imply that specifics help only when they create stakes, not as plain information. — [AMA (2020)](https://www.ama.org/2020/06/11/what-drives-virality-sharing-of-online-digital-content-the-critical-role-of-information-emotion-and-brand-prominence/)

### Inferences
- A good scoring rubric for the LLM is: (a) hook in the first sentence, (b) a high-arousal emotion or surprise, (c) a story or contrarian turn with a payoff inside the clip, (d) it stands alone, (e) practical stakes. Pure information without stakes should score low.
- "Controversy" maps onto anger and indignation, which is high-arousal and shared more. Berger & Milkman support this; I found no podcast-specific test.
- Because creator size dominates, the tool should rank clips *within* an episode. It should not promise absolute virality.

### Gaps
- I could not extract exact Berger & Milkman effect sizes (odds change per SD of awe, anger and so on); both PDFs were compressed binary. Commonly quoted figures, such as "awe +30%", were **not verified here**.
- No peer-reviewed study tests "numbers and specifics in the hook" for short video. Treat it as practitioner lore (weak).
- I found no meta-analysis of emotion and virality.

## 2. Audio and prosody signals (laughter, energy, speech rate, crosstalk, pauses)

### Takeaway
Audio adds a **small but consistent** gain over text alone when a model is trained on real replay data. Highlight segments are only *slightly* higher in arousal, valence and dominance than other segments. Prosody alone is a weak predictor. Laughter and volume spikes are widely used heuristics with little direct published validation for podcasts.

### Cited Findings
- **Rhapsody (2025): 13,364 YouTube podcast episodes**, with labels from YouTube "Most Replayed" peaks. Each episode is split into 100 segments of about 16 s each, and averages 5.32 highlights. — [arXiv 2505.19429v2](https://arxiv.org/html/2505.19429v2). **Strong (large, real-behaviour labels).**
  - Fine-tuned Llama-3.2-1B, text only: F1 0.163, AP 0.134. Adding HuBERT audio raised these to F1 0.197, AP 0.153, and hit rate from 0.452 to 0.490. Adding valence, dominance and arousal (DVA) gave a smaller lift: F1 0.175. Random baseline: F1 0.039.
  - Highlight segments had "slightly higher" mean valence, dominance and arousal, but "the difference is small".
  - Fine-tuned models did best on **Comedy** (HuBERT hit rate 0.820) and worst on **News & Politics**.
  - **Rule:** Use mic loudness and energy as a secondary feature, worth roughly 10–20% of the score. Never use it as the primary selector. Weight laughter and energy more for comedy or banter shows, and less for news, politics or explainer shows.
- **Most Replayed has a start-of-video artifact.** 75% of episodes originally showed a "highlight" at segment 1, which the authors corrected. Beyond that, they found no positional pattern. — [Rhapsody](https://arxiv.org/html/2505.19429v2). **Strong.**
  - **Rule:** Do not favour or penalise a moment by its position in the episode. Exclude the cold-open or intro if it is itself a trailer of later clips, to avoid duplicates.
- **Livestream highlight work favours speech and transcript over visual shot changes.** AntPivot argues that information in shot and scene changes is "less necessary" than the streamer's language. — [arXiv 2206.04888 (2022)](https://arxiv.org/pdf/2206.04888). Combining audio and chat improves livestream highlight detection. — [NTUST thesis (2023)](https://etheses.lib.ntust.edu.tw/thesis/detail/590f577e03369bc72ce43154484cf294/?seq=1). **Moderate.**
- **Laughter, pitch rise and volume increase are named as highlight markers in a USPTO application** (MFCC, volume, pitch and VGGish features). **Weak (patent assertion, no results).** — [USPTO 12614387](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12614387). A laughter-detection algorithm exists (Interspeech 2009), but it is not tied to engagement. — [ISCA](https://www.isca-archive.org/interspeech_2009/sudheerkumar09_interspeech.html)
  - **Rule:** Treat a laughter burst on the *listener's* mic, right after the speaker's line, as a "payoff landed" marker. End the clip about 0.5–1.5 s after the laugh decays, and do not cut mid-laugh. This is an inference to validate in-house, not a proven predictor of virality.
- **Prosody and audience size. Weak (pilot, n=10 YouTubers, Interspeech 2019).** Wider pitch range and more intensity variation went with more *subscribers*. For *views*, pitch range showed no effect, and more intensity variation went with *fewer* views. — [Berger et al., Interspeech 2019](https://www.isca-archive.org/interspeech_2019/berger19_interspeech.html)
  - **Myth flag:** "Louder or more energetic always means more viral" is **not supported**. Use energy relative to the speaker's own baseline (a z-score) to find *emphasis*, not absolute loudness.
- **Speech rate, pauses and stress.** A PACIS 2020 paper proposes speech rate, pauses and stress as engagement cues moderated by pitch. **Weak (I saw the abstract only).** — [PACIS 2020](https://aisel.aisnet.org/pacis2020/145/)
- **Crosstalk and interruptions.** I found no published study linking them to clip performance. Practitioners warn that auto-reframe "can lock onto the wrong face during crosstalk". — [practitioner summary via Klap blog](https://klap.app/blog/vertical-video-editing)

### Inferences
- A practical audio feature set: per-mic loudness z-score against that speaker's median, overlap of both mics (crosstalk), listener-mic laughter bursts, and pauses longer than 1.5 s. These features help find **boundaries** (where a thought or a laugh ends) more reliably than they predict virality.
- A dramatic pause *before* a punchline can be kept, but dead air longer than about 1 s *inside* a clip should be tightened. This is a practitioner convention, not tested.

### Gaps
- I found no study of laughter frequency against short-clip views or completion for podcasts.
- I found no Spotify or YouTube publication that names prosody features in its own clip or preview ranking, beyond Spotify's legacy "peak region" model, which is not described in detail.

## 3. How commercial clipping tools score "virality", and whether it works

### Takeaway
Opus Clip, Vizard and others disclose **rubric names only** (hook, flow, value, trend, stand-alone, takeaway). They publish **no correlation between their scores and real views**. Independent testers find that about 20–40% of auto-clips need to be thrown away, mostly for missing context. Treat vendor scores as rankings within one video, not predictions.

### Cited Findings
- **Opus Clip score: 0–99, from four components.** Hook (does the opening grab attention), Flow (logical progression and a satisfying end), Value (useful, emotional, personal connection) and Trend (fits current trends). ClipAnything also checks prompt relevance. Weights and formula are not published. — [Opus help center](https://help.opus.pro/docs/article/virality-score). **Weak as evidence of predictive power.**
- **Opus claims its model is trained on "hundreds of thousands of (clip, performance) pairs"** and that the scores are "predictive but not certainties". This is a vendor claim with no published validation. — [Opus API blog](https://www.opus.pro/blog/viral-moment-detection-api). **Weak.**
- **An independent review (Aug 2026, updated Oct 2026) found "no idea" whether high scores mean more views.** The top-scored clips matched the passages a human would pick, and timestamps matched the source. — [Marc Andrews](https://marcandrews.com/?p=6263). **Weak (n=21 clips, no publishing).**
- **A competitor test (BIGVU, Jul 2026), 50+ clips over 14 days:** about 40% discarded; expect 20–40% discards in general; causes were "contextually incomplete moment" and caption drift. No correlation figure reported, and BIGVU is a competitor. — [BIGVU](https://bigvu.tv/blog/opus-clip-tested-2026-where-ai-wins-40-percent-discard/). **Weak.**
- **Vizard (Jul 2026):** its score is split into hook strength, clear takeaway and story flow. Tags such as "Hot take", "Storytelling" and "Bold claim hook" appear only on a strong signal. It produces about 13 clips per hour of video. No performance data. — [Vizard blog](https://vizard.ai/blog/meet-vizard-model-v2-full-context-clips-that-the-algorithm-actually-rewards). Vizard also says it compares candidates for overlap and keeps the strongest version. — [Vizard blog post 4076](https://vizard.ai/blog/?p=4076). Third-party accounts of Vizard's signals conflict: one cites "speech energy, topic transitions", another says there is "no real virality score". — [Techsy comparison](https://techsy.io/en/blog/opusclip-vs-vizard)
- **Klap, Munch, Descript, Riverside:** I found no disclosure of scoring signals.
- **Myth flag: "A virality score of 90+ means the clip will go viral."** No vendor or independent source shows calibration against real views (as of Oct 2026).

### Inferences
- What tools actually agree on is the rubric: hook, stand-alone context, payoff, and dedupe of the same idea. Copy the rubric, and do not imitate a single opaque number.
- **Rule:** Show the user sub-scores with one-line reasons (hook, stand-alone, payoff, emotion, energy) instead of one magic number. Dedupe candidates that make the same point and keep the highest-scoring version.

### Gaps
- No public data correlates any vendor's virality score with views, retention or shares.

## 4. Using an LLM to pick moments from a transcript

### Takeaway
LLM selection over **timestamped sentences**, with a structured rubric and few-shot examples, beats legacy ML in Spotify's field test. Zero-shot LLMs are only modestly better than random at matching *replay* peaks. The main failures are missing context, bad boundaries and length drift, and they should be fixed in **code**, not in the prompt. Pairwise ranking is not clearly better than pointwise scoring; both have known biases.

### Cited Findings
- **Spotify LLM previews (2025). Strong (6-week A/B test in 67 countries).** Gemini 1.5 Pro received timestamped sentences plus episode title and description, with a step-by-step prompt (find the main topic, then evaluate segments) and few-shot curated examples. Results:
  - Previews were better or non-inferior to legacy ML 81.09% of the time (n=238; wins 54.2%; p=1.37e-10).
  - Evaluation time per user rose 4.6%.
  - Processing was about 5x faster.
  - Output averaged about 62 s and had to be **trimmed in code to the last complete sentence**, because the LLM did not hit length targets reliably.
  - Prompt tuning was manual.
  — [arXiv 2505.23908](https://arxiv.org/html/2505.23908v1)
  - **Rule:** Feed the transcript as numbered sentences or speaker turns with start and end times. Have the LLM return *sentence IDs*, not free timestamps. Then snap to sentence or turn boundaries and enforce length limits in code.
- **Zero-shot LLMs barely beat random at predicting Most-Replayed segments. Strong.** GPT-4o text F1 was 0.057 and Gemini text 0.065, against random 0.039. Gemini text plus raw audio was no better (F1 0.063). A *fine-tuned* 1B model with audio reached 0.197. — [Rhapsody](https://arxiv.org/html/2505.19429v2)
  - **Rule:** Do not trust zero-shot LLM confidence as a virality probability. If the user has channel analytics (retention or replays per clip), collect them and fine-tune or few-shot from *their* winners. Feed audio as computed features (energy peaks, laughter) in text form, not as raw audio.
- **Fine-tuned models under-predict count:** 3.5–4.0 highlights per episode against a true 5.32. — [Rhapsody](https://arxiv.org/html/2505.19429v2). Vizard targets about 13 per hour. — [Vizard](https://vizard.ai/blog/meet-vizard-model-v2-full-context-clips-that-the-algorithm-actually-rewards)
  - **Rule:** Over-generate about 2x the clips you will keep, then rank and dedupe.
- **One-shot whole-transcript prompting is "ambiguous and not very useful"; use layered calls.** — [Sieve Data blog](https://sievedata.com/blog/generate-video-highlights-long-form-content-podcasts). **Weak (practitioner).** An open-source pipeline uses a planner prompt (clip concepts) and then an extractor prompt (verbatim spans per concept). — [HF ai-transcript-clipper](https://huggingface.co/spaces/rm8630/ai-transcript-clipper/blob/main/app.py)
  - **Rule:** Run a two-stage process. (1) Chunked candidate generation: windows of about 10 minutes with 1–2 minutes of overlap, so context is not lost. (2) A separate scoring and ranking pass over the shortlisted candidates, each with ±30 s of surrounding transcript so the judge can see missing context.
- **Topic segmentation alone misses moments and fails to exclude ads.** — [Spotify paper](https://arxiv.org/html/2505.23908v1). **Moderate.**
- **Failure modes in the wild:** "contextually incomplete moment" is the main discard reason, with about 40% discarded. — [BIGVU (Jul 2026)](https://bigvu.tv/blog/opus-clip-tested-2026-where-ai-wins-40-percent-discard/). **Weak.**
  - **Rule:** Run a deterministic **boundary validator** after the LLM:
    - The start must be a sentence start on a speaker-turn boundary, or a question's start.
    - The first word must not be a conjunction or back-reference.
    - The end must close a sentence, and must not end on a question unless the answer follows.
    - Duration must fall in the target band. Spotify used about 60 s; vertical platforms allow longer, so tune per platform.
    - Fail, then extend or shift by whole sentences, up to N tries, else drop the candidate.
- **Pairwise versus pointwise LLM judging. Moderate.**
  - Pairwise judges show significant position bias across 12 judges and more than 100k instances. The bias is strongest when the two candidates are close in quality. — [Liang et al., "Judging the Judges", ICLR 2025, arXiv 2406.07791](https://arxiv.org/html/2406.07791v6)
  - Rubric (pointwise) scoring also has position bias over score options; balanced permutations with aggregation improve agreement with humans. — [arXiv 2602.02219 (2026)](https://arxiv.org/abs/2602.02219v1)
  - A secondhand review reports that pairwise is easier to game (for example by assertive wording), and that absolute scores are more stable. — [Moonlight review](https://www.themoonlight.io/en/review/pairwise-or-pointwise-evaluating-feedback-protocols-for-bias-in-llm-based-evaluation)
  - **Rule:** Score each candidate pointwise on a rubric to shortlist. Then rank the top 5–8 side by side *in a list*, run it twice with the order shuffled or reversed, and average the ranks. Treat candidates whose rank flips between orders as ties. Never trust a single ordering.

### Inferences
- The best recipe from the evidence: timestamped sentence IDs, a rubric with few-shot examples taken from the user's own best clips, over-generation, a code boundary validator, dedupe, and a shuffled side-by-side final ranking.
- Ask the LLM for a one-line "why this works" and a "what context is missing?" field. A non-empty missing-context answer is a cheap reject signal (an inference, not tested).

### Gaps
- I found no published study of LLM clip *length* against short-platform completion rate.
- I found no head-to-head test of side-by-side ranking against pointwise scoring for clip selection specifically.

## 5. Podcast framing: speaker-follow vs split screen vs wide vs PiP; reaction shots

### Takeaway
**No published A/B data** compares layouts for retention. Practitioner consensus, which is weak but consistent, says: **default to a speaker-follow close-up** and switch to **stacked split screen only when the listener's reaction or the back-and-forth *is* the content**. Never crop a wide two-shot to vertical. The peer-reviewed signal that close-up and medium shots predict TikTok virality supports keeping faces large.

### Cited Findings
- **Close-up and medium shots "play an essential role" in TikTok virality. Moderate (n=400, 2022).** — [Ling et al.](https://arxiv.org/abs/2111.02452)
  - **Rule:** Keep the active speaker's face large, roughly 35–60% of frame height in single-speaker mode. In split mode, each face still needs to fill its own panel.
- **Speaker-follow as default; split only when both reactions matter. Weak (practitioner consensus, 2025–2026).** "Alternate between close reframes, a wider vertical view, and split-screen only when both reactions are editorially important." Split "reduces the size of each face and leaves less room for readable text." — [Klap blog](https://klap.app/blog/vertical-video-editing); [CapCut guide](https://www.capcut.com/create/podcast-clips-for-social-media-long-form-editing)
- **Switch shots on conversational events, not on a timer. Weak.** "Use a split layout, alternate between speakers, or cut to the host for a question, interruption, or meaningful reaction. Do not switch simply because a few seconds have passed." — [CapCut guide](https://www.capcut.com/create/podcast-clips-for-social-media-long-form-editing)
  - **Rule:** Cut to the listener's camera only on (a) a question, (b) an interruption or crosstalk, or (c) a reaction. A reaction means a laugh or loudness burst on the listener's mic, or a visible expression change if face analysis supports it. Hold at least about 1.5–2 s per shot, and avoid ping-pong cuts on back-channel "mm-hm".
- **The wide-shot crop is a known failure.** A wide two-person shot cropped to vertical cuts both speakers off and frames the gap between them. — [summary of practitioner guides incl. Klap](https://klap.app/blog/vertical-video-editing). **Weak, but universal.**
  - **Rule:** Never output a center-crop of a wide shot when two faces are detected far apart. Use per-camera crops, or stack the two faces.
- **Auto-tracking errors happen during crosstalk.** Fix the speaker track or switch to a split frame. — [Klap](https://klap.app/blog/vertical-video-editing). **Weak.**
  - **Rule:** When both mics are active at once for more than about 1 s, switch to the stacked split rather than flicking between speakers. Return to speaker-follow when one mic dominates (for example, at least 6 dB louder for at least 1 s).
- **Split screen or gallery beats single-speaker tracking when one person says something surprising and the other's reaction is the point. Weak (vendor).** — [ClipSpeed multi-speaker split screen](https://www.clipspeed.ai/ai-tools/multi-speaker-split-screen.html)
- **Each panel should have one dominant moment**, so the listener's reaction does not compete with the speaker. — [CapCut guide](https://www.capcut.com/create/podcast-clips-for-social-media-long-form-editing). **Weak.**
- **Caption safe zone:** keep captions in the middle part of a 1080×1920 frame, away from platform UI. — [CapCut guide](https://www.capcut.com/create/podcast-clips-for-social-media-long-form-editing). **Weak, but standard.** In split mode, put captions on the seam between panels.
- **Measure layout effects with your own metric.** YouTube Shorts "Viewed vs. Swiped away" is per-Short, under Studio → Analytics → Content → Shorts. There is no official benchmark: one channel's 90-day rate was 26.6% viewed, while third-party "aim for 75–80%" advice is unsupported. — [Subscribr (2025–26)](https://subscribr.ai/youtube-strategy/youtube-shorts-analytics-metrics-growth); [Social Media Examiner](https://www.socialmediaexaminer.com/how-to-analyze-your-youtube-shorts/)
  - **Rule:** Log the layout mode per clip and compare viewed-vs-swiped and average view duration against the user's own previous Shorts.
- **Myth flag: "85% of social video is watched on mute."** It is widely repeated by vendors in 2025–26, but it traces to a 2016 Facebook-era figure. No current Shorts or TikTok source was found. — [repeated in practitioner guides](https://klap.app/blog/vertical-video-editing). Burned-in captions are still justified by Ling et al.'s on-screen-text finding (moderate). — [arXiv 2111.02452](https://arxiv.org/abs/2111.02452)
- **Picture-in-picture:** I found no data or clear consensus.

### Inferences
- Default state machine: single-speaker close-up for the active mic; stacked split for crosstalk, Q&A volleys or listener laughter; a listener cutaway of 1–2 s when the listener laughs or reacts audibly. Skip the wide shot except as a brief establishing frame, if at all.
- The opening 1–2 s should show the speaker's face large, with the hook line captioned. This is consistent with the close-up finding and the "start on the strongest line" advice. — [practitioner guides](https://klap.app/blog/vertical-video-editing)

### Gaps
- I found no public A/B test (academic or creator) of speaker-follow vs split vs wide vs PiP on retention. Large clip channels (for example Diary of a CEO or Modern Wisdom clips) publish no layout analytics.
- I found no data on the best reaction-shot duration or frequency.
