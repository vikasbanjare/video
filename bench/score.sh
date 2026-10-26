#!/bin/bash
# score.sh — Clean up on every test video and transcript, current rules vs script mode.
cd "$(dirname "$0")"
run() {  # data-dir human-map words label
  printf '%-34s' "$4"
  DATA=$1 HUMAN=$2 WORDS=$3 node replay.js | grep -E '^with script: speech|^script lines' | sed -E 's/.*— /rules: /; s/^script lines: /       lines: /' | paste -sd' ' -
  printf '%-34s' ''
  DATA=$1 HUMAN=$2 WORDS=$3 SCRIPTMODE=1 node replay.js | grep -E '^with script: speech|^script lines' | sed -E 's/.*— /+mode: /; s/^script lines: /       lines: /' | paste -sd' ' -
}
run data        acc3.json  words_local_hi.json  "Edelweiss / local"
run data        acc3.json  local_hi_mc0.json    "Edelweiss / local -mc 0"
run data/ashish human.json words_local_hi.json  "Ashish / local"
run data/ashish human.json words_mc0.json       "Ashish / local -mc 0"
run data/ashish human.json words_loopfix.json   "Ashish / local + loop repair"
run data        acc3.json  words_loopfix.json   "Edelweiss / local + loop repair"
