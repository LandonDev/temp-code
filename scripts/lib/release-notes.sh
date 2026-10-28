# Sourced by scripts/release-publish.sh (and its test).
#
# cap_release_notes BUDGET PREV_TAG: reads the notes on stdin, one line per
# commit, newest first, and prints whole lines while the total stays within
# BUDGET bytes (newlines included; bytes are never fewer than the characters
# GitHub counts). When lines were dropped the last line says how many:
# "… and N more commits since PREV_TAG". GitHub refuses a release body over
# 125,000 characters, which 604 commits once passed.
cap_release_notes() {
  LC_ALL=C awk -v budget="$1" -v prev="$2" '
    { lines[NR] = $0 }
    END {
      total = 0; kept = 0
      for (i = 1; i <= NR; i++) {
        if (total + length(lines[i]) + 1 > budget) break
        total += length(lines[i]) + 1; kept = i
      }
      if (kept < NR) {
        tail = "… and " (NR - kept) " more commits" (prev != "" ? " since " prev : "")
        # Make room for the tail line by dropping more lines when needed.
        while (kept > 0 && total + length(tail) > budget) {
          total -= length(lines[kept]) + 1; kept--
          tail = "… and " (NR - kept) " more commits" (prev != "" ? " since " prev : "")
        }
      }
      for (i = 1; i <= kept; i++) print lines[i]
      if (kept < NR) print tail
    }'
}
