# Hooks and Endings for Short Vertical Clips Cut from Podcasts and Interviews (YouTube Shorts, Instagram Reels, TikTok)

Research date: 2026-10-21. Evidence ratings used throughout:
- **STRONG**: platform-official data or definitions, or a peer-reviewed or large controlled study.
- **MODERATE**: large creator or vendor dataset with a stated method but no controls, or platform marketing data without published method.
- **WEAK**: a single creator's anecdote, small or undisclosed sample, or a vendor blog repeating numbers without a source.
- **MYTH/UNPROVEN**: widely repeated, but no primary source found, or a primary source contradicts it.

Overall caveat: across about 20 searches and fetches, I found **no published controlled A/B test** on podcast-clip openings or endings from any platform or clipping tool (Opus Clip, Vizard, Submagic, Klap, Captions, Descript). Most "data-backed" hook content online is vendor marketing. The strongest material is (a) platform metric definitions, (b) TikTok's own ad-creative correlational stat, (c) one ECCV 2024 academic dataset (Snapchat, 90k videos), and (d) one mid-size creator dataset (5,400 Shorts).

---

## Q1. How much of the audience is lost in the first 1-3 seconds? (swipe-away stats, 3-second hold rates)

### Takeaway
YouTube publishes the metric (viewed vs. swiped away) but no official benchmark. The best non-official dataset (5,400 Shorts, 3.3B views, 2023) found Shorts under 60% "viewed" performed poorly and those at 70-90% did better. So roughly 10-40% of feed impressions are lost at the very first decision even on well-performing Shorts. The widely quoted "71% decide in 3 seconds" and "65-70% 3-second hold threshold" figures are secondary and unverified.

### Cited Findings
- **STRONG (definition).** YouTube Analytics' Reach tab defines "Viewed (vs. swiped away)" as the percentage of times viewers watched a Short compared with how often they swiped past it in the Shorts feed. YouTube gives no official "good" threshold. — [YouTube Help: Understand your content performance](https://support.google.com/youtube/answer/12220281)
- **STRONG (context, dated 2023).** YouTube launched two Shorts metrics, "Shown in feed" and "Viewed (vs. swiped away)", around Feb 2023, on Studio web and mobile (Advanced and content-level analytics). — [Mr. Vacca video, Feb 24 2023, mirrored on Google Help community](https://support.google.com/youtube/community-video/273390203/new-youtube-shorts-metric-viewed-vs-swiped-away?hl=en)
- **STRONG (platform change, Mar 2025).** From March 31, 2025, a YouTube Shorts "view" counts every time a Short starts or replays, with no minimum watch time. The older measure is kept as "engaged views" in Advanced Mode, and YPP eligibility and earnings still use engaged views. **Implication: since April 2025, raw Shorts view counts no longer reflect hook quality. Use engaged views or viewed-vs-swiped instead.** — [Sprout Social support note](https://support.sproutsocial.com/hc/en-us/articles/35874991211533-YouTube-Shorts-View-Count-Update-March-2025); [PPC Land](https://ppc.land/youtube-changes-how-shorts-views-are-counted-from-march-31/); [Digital Music News, Mar 27 2025](https://www.digitalmusicnews.com/2025/03/27/how-does-youtube-shorts-count-views-2025/)
- **MODERATE (dataset, Nov 2023, before the view-count change).** 5,400 Shorts from 33 channels (3.3B views): Shorts with under 60% viewed-vs-swiped performed poorly, and those at 70-90% did better. A high VVSA did not guarantee success, similar to CTR on long-form. The same study found no strong correlation between likes, shares or comments and view performance. Shorts with average view duration over 50 s averaged 4.1M views. — [Lacombled, "A Study of 3.3 Billion Views", Medium, Nov 23 2023](https://medium.com/@antoinelacombled/cracking-the-youtube-shorts-algorithm-a-study-of-3-3-billion-views-4711fdf7931b)
- **WEAK (secondary benchmarks).** One agency's analysis says Shorts above 70-90% viewed performed best, and Social Media Examiner suggests 50% viewed as a baseline goal. — [Dooley Social Studio, citing Vaizle and Social Media Examiner](https://www.dooleysocial.studio/blog/unlocking-youtube-shorts-algorithm). Third-party guides suggest 75-80% viewed, but there is no official universal threshold. — [ContentStudio guide](https://contentstudio.io/blog/youtube-shorts-analytics-guide); [Subscribr](https://subscribr.ai/youtube-strategy/youtube-shorts-analytics-metrics-growth)
- **WEAK / likely MYTH.** "If more than 40-50% of viewers swipe away in the first 2 seconds, the system instantly stops pushing the video." This comes from an unofficial reply in a Google Help community thread, not YouTube staff. — [Google Help community thread](https://support.google.com/youtube/thread/439203789/my-shorts-suddenly-experienced-a-drastic-drop-in-views?hl=en)
- **WEAK (secondary, primary not found).** "71% of TikTok users decide whether to keep watching within the first three seconds" is attributed to TikTok creative insights via an Asia research aggregator. — [Animoto blog](https://animoto.com/blog/video-marketing/why-first-3-seconds-matter); [Dynamoi](https://dynamoi.com/learn/tiktok-music-promotion/what-is-the-3-second-rule-on-tiktok). The same Dynamoi page claims a "65-70% retention at 3 s" threshold for TikTok promotion, and I found no TikTok source for it. → **MYTH/UNPROVEN as a hard threshold.**
- **WEAK (vendor claims).** "Strong hooks maintain 80-90% of viewers through the first 3 seconds." — [OpusClip blog](https://www.opus.pro/blog/tiktok-length-format-retention-data). "Videos with 70-85% 3-second retention get 2.2x more total views." — [Webtonic, citing TTS Vibes](https://www.webtonic.io/blog/tiktok-hook-ideas-50-attention-grabbing-openings-that-stop-the-scroll). Neither discloses its method.
- **STRONG (academic, 2024).** SnapUGC (ECCV 2024) built a 90,000-video Snapchat dataset and defines **Engagement Continuation Rate (ECR) = P(watch > 5 s)** as a video's ability to captivate viewers at the beginning. ECR correlates **0.926** with normalized average watch percentage. In plain terms, how many people survive the first 5 seconds almost fully predicts overall watch percentage. Transcripts added no predictive value, partly because the authors say viewers decide on the first seconds. Visual-quality scores (MOS) did not strongly correlate with engagement. — [Li et al., "Delving Deep into Engagement Prediction of Short Videos", arXiv 2410.00289](https://arxiv.org/html/2410.00289v1)
- **MODERATE (adjacent, ads).** TikTok audiences watch about 21% of the average branded video, so 4 out of 5 viewers leave before the end. — [eMarketer, "Viewers move on before TikTok videos end"](https://www.emarketer.com/content/viewers-move-on-before-tiktok-videos-end) (search snippet only, page blocked; date and sample unverified)

### Inferences
- **Rule 1.1: Treat seconds 0-2 as the selection gate, and seconds 0-5 as the predictor of everything else.** ECR(5 s) correlating 0.93 with overall watch percentage is the most rigorous number found. A clip-picker should score the first 5 s of a candidate separately from the rest and reject candidates whose first 5 s are weak, even if the middle is strong.
- **Rule 1.2: Target "viewed" at 70% or more, and treat under 60% as a failed hook.** This is a heuristic band from a single 2023 dataset, not a platform rule. If the tool gets analytics feedback, use viewed-vs-swiped (YouTube) and engaged views, not raw views, as the hook-quality label. Raw views have been inflated by replays since March 31, 2025.
- **Rule 1.3: Don't hard-code "65-70% at 3 s" as an algorithm threshold.** No platform has published it.

### Gaps
- No official per-second swipe curve for YouTube, Instagram or TikTok, and no official average swipe rate.
- Instagram does not publish a 3-second hold rate benchmark. I found no Mosseri primary statement with a number.
- The 3.3B-view study predates the March 2025 view-count change, and its sample is skewed to 33 channels.

---

## Q2. Cold opens, starting on the punchline, and flash-forwards vs. starting where the moment naturally begins

### Takeaway
No controlled test was found that compares a flash-forward or cold open against a natural start for short clips. The best indirect evidence is TikTok's own ad data: over 63% of its highest-CTR ads put the key message in the first 3 seconds. On the other side, the spoiler research that is often used to justify "show the ending first" failed to replicate. Front-loading is supported. Repeating the payoff at the start (true flash-forward) is unproven.

### Cited Findings
- **MODERATE (platform-official, correlational, ads).** TikTok: "over 63% of all videos with the highest CTR highlight their key message or product within the first 3 seconds." No method or sample is published, and these are ads, not organic clips. — [TikTok for Business, "9 creative tips to drive auction ad performance"](https://ads.tiktok.com/business/en-US/blog/9-creative-tips-to-drive-auction-ad-performance); [TikTok Auction Ads Creative Tips PDF](https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf)
- **MODERATE (counterpoint, ads).** A Billion Dollar Boy analysis (reported via search snippet) found that front-loading *brand* messaging cut the 25% view rate of paid Instagram and TikTok placements by 44%, and recommends saving the CTA for the end. **The point: front-load the interesting thing, not the sales message.** — [eMarketer](https://www.emarketer.com/content/viewers-move-on-before-tiktok-videos-end) (page blocked, figure unverified at source)
- **STRONG but CONTESTED (academic, 2011 and later).** Leavitt and Christenfeld (Psychological Science, 2011) found spoiled stories were slightly *more* enjoyed. A replication by Levine, Betzner and Autry (Discourse Processes, n=215) found the opposite: spoilers at the start *reduced* enjoyment, and mid-story spoilers had no effect. A summary concludes the evidence cannot show spoilers either help or hurt. — [OnFiction research bulletin, 2017](https://www.onfiction.ca/2017/04/research-bulletin-spoiler-alert-not-all.html); [The Conversation](https://theconversation.com/enough-with-the-spoiler-alerts-plot-spoilers-often-increase-enjoyment-62154). These are written stories, not video, and the studies are old (2011 and 2017).
- **WEAK (practitioner).** Strong podcast Shorts open on conflict or surprise, need no prior episode context, and resolve within about 8 seconds. The advice is to "cut straight to the sentence that makes someone stop scrolling." — [Influencers-Time podcast snippet hook-testing playbook](https://www.influencers-time.com/podcast-snippets-to-shorts-a-brand-hook-testing-playbook/)
- **WEAK (definition).** A flash-forward is one kind of cold open (later event shown, then back to the setup), and not every flash-forward is short enough to work as an opener. — [Creator Essentials glossary: cold open](https://www.creatoressentials.com/glossary/cold-open/)
- **WEAK (anecdote, Apr 2026).** A Reddit creator reports that the first 1-2 seconds decide a clip, and that 25-45 s clips beat longer ones. — [Reddit snapshot](https://reddit.sentinel-team.org/posts/1skjvqi/snapshots/2026-04-14T00%3A14%3A25.91648Z)

### Inferences
- **Rule 2.1 (supported): Start the clip as close to the high-value line as context allows.** In practice, choose the in-point so the strongest claim or turn arrives by about 3 s. Prefer moving the in-point later (dropping setup) over adding a teaser.
- **Rule 2.2 (unproven, make it optional): A flash-forward (strongest line, then a jump back to the setup) is an editorial option, not a default.** No evidence shows it beats a tight natural start. The replication failure suggests that revealing the payoff up front can lower satisfaction. If implemented, A/B it, and make the teaser a *question-opening* fragment of the payoff rather than the full resolution, so the curiosity gap stays open.
- **Rule 2.3: Never front-load promotional content** (guest name card, show plug, sponsor) before the interesting line.

### Gaps
- No published A/B from Opus Clip, Vizard, Submagic, Klap, Captions or Descript comparing teaser-first against natural start.
- No platform data on organic (non-ad) clips with key-moment placement.

---

## Q3. Question hooks, bold-claim hooks, number hooks, "you" hooks: which openings hold viewers?

### Takeaway
There is no rigorous comparative evidence ranking hook *types* by retention. The largest dataset, OpusClip's AI-classified "13.5M clips" research hub, publishes usage counts by hook type but does not publicly show per-type views. "Surprising statistic" is the most-used data hook (15,708 of 15,993 data-hook clips), mostly in marketing content, and rare in interview/discussion clips (25). Hook-type rankings circulating online are **unproven**.

### Cited Findings
- **MODERATE (vendor dataset, usage only).** OpusClip analyzed 15,993 clips using data/statistics hooks (from a stated 13.5M-clip corpus, TikTok and YouTube, temporal coverage 2024-01 to 2026-04, 7-day views and likes, AI-classified hook categories). Subcategories: Surprising Statistic 15,708 and Trend Data 285. By genre: Marketing & Ads 11,434, News & Politics 963, Education 888, Coaching 272, **Interviews & Discussion 25**. The performance-by-platform table rendered empty ("—"), so no per-type view numbers are public. — [OpusClip Research: Data/Statistics Hooks, updated Apr 3 2026](https://www.opus.pro/research/how-to-use-data-statistics-hooks)
- **WEAK (vendor advice, no data).** The same page recommends stats that *defy expectations* ("numbers that confirm what people already believe don't create curiosity"), plus contrarian ("Here's the truth about X nobody's saying") and "You've been doing X wrong" pattern-interrupt templates. — [OpusClip](https://www.opus.pro/research/how-to-use-data-statistics-hooks)
- **WEAK (anecdote, 500 videos, no method).** A Reddit poster's frame-by-frame review: (1) 0.5 s of dead air or a breath at the start leads to swipes, so "start speaking the millisecond the video starts"; (2) a static seated speaker with no movement in the first 3 s "loses 30%"; (3) context-setting openers ("I'm going to show you…") underperform direct claims ("This is the best X you'll ever…"). — [r/SocialMediaMarketing](https://www.reddit.com/r/SocialMediaMarketing/comments/1qh66g7/i_analyzed_500_videos_to_understand_why_retention/)
- **MODERATE (academic, adjacent).** In SnapUGC, adding title and description text improved engagement prediction (SRCC 0.636 to 0.651), and audio-scene labels helped slightly. Visual "emotion" features did *not* help (0.696 to 0.690). There is no hook-type breakdown. — [arXiv 2410.00289](https://arxiv.org/html/2410.00289v1)
- **WEAK (academic, method only).** A 2024 qualitative TikTok marketing paper (interviews) asserts that hooks in the first 3 s drive FYP distribution. No quantitative outcome is reported. — [ResearchGate: "First 3 Second Impression of TikTok Marketing Strategy"](https://www.researchgate.net/publication/381101465_First_3_Second_Impression_of_Tiktok_Marketing_Strategy)

### Inferences
- **Rule 3.1: Score candidate first sentences on *surprise or contradiction* and *self-containedness*, not on hook template.** "Question vs. number vs. you" has no evidence. "Says something unexpected that a cold viewer can understand" is what the TikTok key-message stat, the Opus defy-expectations advice and the SnapUGC first-seconds finding all point to.
- **Rule 3.2: Penalize openers that are meta or context-setting** ("So today we're talking about…", "Let me tell you a story…") and favour openers that state the claim or conflict directly. The support for this is weak but consistent.
- **Rule 3.3: Don't invent text hooks** (fake stats, "nobody's telling you"). For interview content, the hook should be the guest's own strongest sentence. The Opus genre table shows interview clips rarely use data hooks.

### Gaps
- Opus's per-hook-type views are not public. The broader page [/research/best-video-hooks-short-form](https://www.opus.pro/research/best-video-hooks-short-form) returned 404 on 2026-10-21.
- No published Vizard, Submagic or Klap hook dataset was found.

---

## Q4. On-screen text hooks and title cards in the first seconds: help or hurt?

### Takeaway
No controlled study measures whether a first-frame text overlay or title card raises or lowers retention. The case for overlays rests on sound-off autoplay and practitioner consensus. The case against a *3-second title card that delays speech* is indirect but consistent: dead time before the first spoken word is the most common anecdotal cause of early swipes, and first-seconds content predicts overall engagement. Removing the 3 s title card is consistent with the evidence, provided the hook text, if any, is overlaid on the speaker from frame 1.

### Cited Findings
- **MYTH/UNPROVEN (no measurement found).** An extended search found no controlled study measuring first-frame text overlays against retention or views. Guidance is creator consensus plus the "feeds autoplay muted" argument. — [Kompozy guide](https://kompozy.io/guides/short-form-video-hooks); [CapCut hook patterns](https://www.capcut.com/create/short-form-video-hooks-first-3-second-patterns); [Naniza](https://naniza.io/blog/short-form-video-hooks)
- **WEAK (practitioner spec).** Overlay hook text should be 4-8 words, present in the *first frame* (not fading or typing in), because "a hook which finishes typing at second three has already lost the sound-off viewer who left at second one." — [Kompozy](https://kompozy.io/guides/short-form-video-hooks); [ClipForge 2026 playbook](https://clip-forge.io/blog/vertical-video-retention-editing-playbook-2026)
- **WEAK (academic qualitative, 2026).** In a study of AI-generated research TikToks, participants said text overlays helped multi-channel processing. One participant put caption impact at "maybe 1%". — [PaperTok, arXiv 2601.18218](https://arxiv.org/pdf/2601.18218)
- **MODERATE (academic, adjacent).** In SnapUGC, adding automatic video captions (scene descriptions, not subtitles) gave only a marginal gain (0.651 to 0.657), while title and description text gave a larger one. — [arXiv 2410.00289](https://arxiv.org/html/2410.00289v1)
- **WEAK (anecdote).** 0.5 s of silence at the start is "enough for a swipe" on TikTok. — [Reddit, 500-video review](https://www.reddit.com/r/SocialMediaMarketing/comments/1qh66g7/i_analyzed_500_videos_to_understand_why_retention/)

### Inferences
- **Rule 4.1: Never put a full-screen title card that replaces the speaker or delays the first spoken word.** The user's removal of the 3 s card is defensible.
- **Rule 4.2: If a hook text is used, overlay it on the speaker footage from frame 0.** Keep it to 8 words or fewer, show it static (no typewriter), and drop it within about 2-3 s. It should restate or sharpen the spoken first line, not introduce a separate topic. Keep it optional and off by default unless A/B data says otherwise.
- **Rule 4.3: Burned-in captions should start on frame 0, synchronized with the first word.** This follows from the sound-off argument. Their retention effect is unmeasured.

### Gaps
- No platform-published data on overlays (TikTok, Instagram or YouTube).
- I could not verify a Nielsen Norman "text + audio improves retention" citation used by one guide.

---

## Q5. Starting mid-sentence vs. at a sentence start; trimming warm-up words ("so", "um", "yeah")

### Takeaway
No direct study exists. The available evidence (dead-air anecdotes, first-5-seconds predicting engagement, TikTok's key message within 3 s) supports trimming leading filler and silence aggressively. Nothing found supports starting *mid-sentence*, and the self-containedness advice argues against it. The best start point is the first word of a self-contained sentence, with leading discourse markers removed.

### Cited Findings
- **WEAK.** "Cut the breath. Start speaking the millisecond the video starts." — [Reddit 500-video review](https://www.reddit.com/r/SocialMediaMarketing/comments/1qh66g7/i_analyzed_500_videos_to_understand_why_retention/)
- **WEAK.** Podcast Shorts should "not require context from earlier in the episode." — [Influencers-Time](https://www.influencers-time.com/podcast-snippets-to-shorts-a-brand-hook-testing-playbook/)
- **MODERATE.** Key message within the first 3 s correlates with top CTR (ads). — [TikTok for Business](https://ads.tiktok.com/business/en-US/blog/9-creative-tips-to-drive-auction-ad-performance)
- **STRONG (adjacent).** Survival past 5 s predicts overall watch percentage (r about 0.93). — [arXiv 2410.00289](https://arxiv.org/html/2410.00289v1)

### Inferences
- **Rule 5.1: The in-point is the first content word of a sentence.** Strip leading "so / um / uh / yeah / like / you know / I mean / and / but / right" tokens and any silence over about 150 ms before the first word. Keep 2-4 frames of pre-roll so the first phoneme isn't clipped.
- **Rule 5.2: Don't start mid-sentence** unless the fragment is itself a complete, understandable claim. Reject in-points whose first sentence contains an unresolved pronoun or reference ("he", "that", "this thing we talked about") with no antecedent in the clip. This is an inference from the self-containedness advice, not tested.
- **Rule 5.3: Inside the first 3 s, also remove short internal fillers and long pauses** (jump-cut), since this window carries the most weight.

### Gaps
- No A/B on filler-word removal or on sentence-boundary vs. mid-sentence starts.

---

## Q6. Endings: looping endings, cutting exactly on the payoff, trailing filler, end CTAs ("follow for part 2")

### Takeaway
Replays are platform-relevant on all three apps. YouTube counts each replay as a view since March 2025, and Instagram's watch time includes replays (secondary report). That rewards endings that flow back into the opening. However, evidence that *engineered loops* raise rewatches is anecdotal only. No study was found on "follow for part 2" CTAs. Instagram's top signals (watch time, likes per reach, sends per reach) are reported by secondary sources only. Ending exactly on the payoff, with no trailing filler, is the only ending rule that follows directly from the completion-oriented metrics.

### Cited Findings
- **STRONG (platform).** YouTube Shorts: since Mar 31 2025, every replay counts as a view, which YouTube itself ties to the looping format. — [PPC Land](https://ppc.land/youtube-changes-how-shorts-views-are-counted-from-march-31/); [Sprout Social](https://support.sproutsocial.com/hc/en-us/articles/35874991211533-YouTube-Shorts-View-Count-Update-March-2025)
- **WEAK (secondary, primary not found).** Instagram: Mosseri reportedly named watch time, likes per reach and sends per reach as the top Reels ranking signals in Jan 2025. Sends per reach is described as the main driver of non-follower reach. Watch time reportedly includes replays per the Instagram help centre. The "sends weigh 3-5x likes" multiplier has **no primary source** → MYTH/UNPROVEN. — [SocialPilot](https://www.socialpilot.co/de/blog/instagram-reels-algorithm); [Dataslayer](https://dataslayer.ai/blog/instagram-algorithm-2025-complete-guide-for-marketers); [eClincher](https://www.eclincher.com/articles/how-the-instagram-algorithm-works-in-2026)
- **WEAK (no official metric).** YouTube publishes no "loop rate". Third-party tools estimate it. — [Vidanalyze glossary](https://vidanalyze.com/glossary/loop-rate)
- **WEAK (anecdotes).** A creator reports a 14% rewatch rate on a short food clip vs. 3% on a 60 s tutorial, attributed to length. — [Neal Schaffer on Shorts looping](https://nealschaffer.com/youtube-shorts-looping/); [Flixier](https://flixier.com/blog/does-looping-your-video-increase-engagement). A Telegram post claims rewatches rose from 4% to 21% after tying the closing line to the opening hook (no sample, no method). — [HookConfessions](https://t.me/s/HookConfessions/17)
- **MYTH/UNPROVEN.** "Retention can exceed 100% via replays" and "2.5 average repeats" benchmarks have no primary source. — [Virvid blog](https://virvid.ai/blog/looping-structure-shorts-retention-2026)
- **MODERATE (dataset, 2023).** Engagement counts (likes, shares, comments) did not strongly correlate with Shorts view performance in the 5,400-Short dataset. Average view duration did. — [Lacombled 2023](https://medium.com/@antoinelacombled/cracking-the-youtube-shorts-algorithm-a-study-of-3-3-billion-views-4711fdf7931b)
- **MODERATE (ads).** Save the CTA for the end. Front-loaded brand messaging cut the paid 25% view rate by 44% (Billion Dollar Boy, via eMarketer snippet). — [eMarketer](https://www.emarketer.com/content/viewers-move-on-before-tiktok-videos-end)
- **No evidence found** on "follow for part 2" or "part 2" series CTAs (views, follows, completion). The search returned only general length and drop-off data. — e.g. [Socialinsider TikTok length study](https://socialinsider.io/blog/how-long-are-tiktok-videos)

### Inferences
- **Rule 6.1 (supported by metric design): End on the payoff.** Set the out-point at the end of the sentence that delivers the punchline, answer or reveal, plus a short tail (about 0.3-0.7 s, or the laugh or reaction if present). Cut trailing "yeah, so anyway", the host's follow-up question and any crosstalk. Every second after the payoff is pure drop-off risk on a completion-weighted metric.
- **Rule 6.2 (plausible, unproven): Prefer endings that loop.** When choosing between candidate out-points, give a small bonus to one whose last line semantically or rhythmically leads into the first line (for example, the clip opens on a question and ends on the answer that re-poses it). Also bonus a clean audio cut without music fade-out or black frames, so the replay seam is invisible. Don't add an artificial outro.
- **Rule 6.3: No spoken or burned-in "follow for part 2" by default.** There is no evidence, and it adds post-payoff seconds. If the user wants a series, keep it as caption or description text, or as a small overlay *during* the last spoken line, never as extra tail time.
- **Rule 6.4: Prefer shorter clips when the payoff allows.** Anecdotes show rewatch rates fall with length. The 2023 dataset shows longer *held* watch time wins, so length should follow how long the content holds, not a fixed target.

### Gaps
- No platform-published rewatch or loop-rate data, and no A/B on loop endings or on part-2 CTAs.
- Mosseri's Jan 2025 statement was not retrieved from a primary Instagram source. The firecrawl search was rate-limited and general web search returned only blogs.

---

## Q7. A/B tests or datasets from clipping tools (Opus Clip, Vizard, Submagic, Klap, Captions.ai, Descript) and creator analytics

### Takeaway
Only OpusClip publishes a "research hub". It claims 13.5M clips with 7-day view and like metrics and AI-classified hooks, but the scraped page exposes usage counts, not per-hook performance, and it is `noindex`. I found no published A/B tests from any clipping tool. The only creator dataset with numbers on openings was the 2023 5,400-Short study.

### Cited Findings
- **MODERATE.** OpusClip Research Hub: 13.5M-clip corpus, 2024-01 to 2026-04, TikTok and YouTube, AI-classified hooks, 7-day avg views and likes. The public data/stats hook page shows counts only, and the platform performance table is empty. Page metadata is `robots: noindex, nofollow`. — [OpusClip Research](https://www.opus.pro/research/how-to-use-data-statistics-hooks)
- **WEAK.** OpusClip blog: if retention drops sharply in the first 3 s, "your hook isn't compelling enough". Strong hooks keep 80-90% through 3 s. No method given. — [OpusClip blog](https://www.opus.pro/blog/tiktok-length-format-retention-data)
- **MODERATE.** 33-channel, 5,400-Short, 3.3B-view creator dataset (Nov 2023): VVSA under 60% performed poorly, 70-90% performed better, AVD over 50 s averaged 4.1M views, and engagement counts were weakly correlated. — [Lacombled](https://medium.com/@antoinelacombled/cracking-the-youtube-shorts-algorithm-a-study-of-3-3-billion-views-4711fdf7931b)
- **STRONG (academic).** SnapUGC, 90k Snapchat videos: ECR (watch over 5 s) correlates 0.926 with normalized watch percentage, and quality/MOS correlates weakly with engagement. — [arXiv 2410.00289](https://arxiv.org/html/2410.00289v1)

### Inferences
- **Rule 7.1: The tool should build its own feedback loop.** Log the in-point type (natural start, trimmed filler, teaser-first), first-sentence features, overlay on/off and out-point type (payoff, loop, CTA). Then join them with per-clip viewed-vs-swiped, engaged views and average % viewed, as the user's analytics allow. The public evidence is too thin to tune weights beyond the rules above.
- Summary rule set for the clipper, ordered by evidence strength: (1) Strongest line by about 3 s, no dead air (moderate). (2) First 5 s scored separately as a gate (strong, adjacent). (3) Strip leading filler and start at sentence boundaries (weak, consistent). (4) End on the payoff with no tail (inferred from metrics). (5) No title card that delays speech; an optional first-frame overlay of 8 words or fewer (unproven). (6) Loop bonus (weak). (7) No part-2 CTA tail (no evidence). (8) Flash-forward only as an A/B option (unproven, spoiler replication negative).

### Gaps
- Vizard, Submagic, Klap, Captions.ai and Descript: no published retention datasets or A/B results found.
- Hootsuite, Sprout, Buffer, Later, Socialinsider and Dash Hudson: no hook or ending-specific retention studies were retrieved within the call budget. Socialinsider has length studies only. The firecrawl search hit rate limits mid-task, which reduced coverage.
