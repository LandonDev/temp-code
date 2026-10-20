#!/usr/bin/env bash
# Copy the Mac's harness transcripts to the box so the threads whose history
# moved there (scripts/mac/cutover-run.sh) resume natively instead of
# answering "No conversation found with session ID".
#
# The database move carried every thread's native session id, but not the
# files those ids name:
#   - Claude Code keeps one directory per cwd under ~/.claude/projects, named
#     by the slug rule <cwd with every character outside [A-Za-z0-9_-] as '-'>,
#     and <sessionId>.jsonl inside it. Each directory lands under the slug of
#     its cwd mapped through scripts/box/history-map.json (the importer's
#     mapping), read from the "cwd" field of its first transcript line; a cwd
#     the map does not cover keeps its Mac slug.
#   - Codex keeps rollouts by date under ~/.codex/sessions and finds a thread
#     by id, so that tree copies as it is.
# Re-runnable: nothing on the box is deleted, newer files win (-u).
#
#   bash scripts/mac/copy-claude-projects.sh [--dry-run]
#   TEMP_CODE_BOX_HOST=box   the ssh host (its login may sudo, as cutover-run.sh needs)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
map="$here/../box/history-map.json"
box=${TEMP_CODE_BOX_HOST:-box}
home_box=/srv/agents/home
dry=()
[[ ${1:-} == --dry-run ]] && dry=(-n)
say() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
command -v jq >/dev/null || { echo 'jq is required (brew install jq)' >&2; exit 2; }
[[ -f $map ]] || { echo "missing $map" >&2; exit 2; }
ssh -o BatchMode=yes "$box" 'sudo -n true' || { echo "ssh $box with passwordless sudo is required" >&2; exit 2; }

# Longest mapping first; roots before prefixes.
rules=$(
  jq -r '.roots | to_entries | sort_by(-(.key | length))[] | [.key, .value] | @tsv' "$map"
  jq -r '.prefixes | to_entries | sort_by(-(.key | length))[] | [.key, .value] | @tsv' "$map"
)
map_cwd() {
  local cwd=$1 from to
  while IFS=$'\t' read -r from to; do
    [[ -n $from ]] || continue
    if [[ $cwd == "$from" || $cwd == "$from"/* ]]; then
      printf '%s\n' "$to${cwd#"$from"}"
      return
    fi
  done <<<"$rules"
  printf '%s\n' "$cwd"
}
slug() { printf '%s' "$1" | sed 's/[^A-Za-z0-9_-]/-/g'; }

R=(rsync -rltzu --rsync-path='sudo rsync' "${dry[@]}")
dirs=0 files=0 skipped=0
for dir in "$HOME"/.claude/projects/*/; do
  dir=${dir%/}
  first=$(ls "$dir"/*.jsonl 2>/dev/null | head -1 || true)
  if [[ -z $first ]]; then skipped=$((skipped + 1)); continue; fi
  cwd=$(grep -m1 -o '"cwd":"[^"]*"' "$first" | head -1 | sed 's/^"cwd":"//; s/"$//' || true)
  if [[ -z $cwd ]]; then
    say "skip $(basename "$dir"): no cwd in $(basename "$first")"
    skipped=$((skipped + 1))
    continue
  fi
  dest="$home_box/.claude/projects/$(slug "$(map_cwd "$cwd")")"
  n=$(find "$dir" -name '*.jsonl' | wc -l | tr -d ' ')
  say "$(basename "$dir") ($n transcripts, cwd $cwd) -> $dest"
  if [[ ${#dry[@]} == 0 ]]; then
    ssh "$box" "sudo install -d -m 755 -o agents -g agents '$dest'"
  fi
  "${R[@]}" "$dir/" "$box:$dest/"
  dirs=$((dirs + 1)); files=$((files + n))
done

if [[ -d $HOME/.codex/sessions ]]; then
  n=$(find "$HOME/.codex/sessions" -name '*.jsonl' | wc -l | tr -d ' ')
  say "codex sessions ($n rollouts) -> $home_box/.codex/sessions"
  if [[ ${#dry[@]} == 0 ]]; then
    ssh "$box" "sudo install -d -m 755 -o agents -g agents '$home_box/.codex/sessions'"
  fi
  "${R[@]}" "$HOME/.codex/sessions/" "$box:$home_box/.codex/sessions/"
fi

if [[ ${#dry[@]} == 0 ]]; then
  ssh "$box" "sudo chown -R agents:agents '$home_box/.claude/projects' '$home_box/.codex/sessions' 2>/dev/null; sudo chmod -R u+rwX,go+rX '$home_box/.claude/projects'"
  say "on the box: $(ssh "$box" "sudo find '$home_box/.claude/projects' -name '*.jsonl' | wc -l | tr -d ' '") claude transcripts, $(ssh "$box" "sudo find '$home_box/.codex/sessions' -name '*.jsonl' | wc -l | tr -d ' '") codex rollouts"
fi
say "done: $dirs project dirs ($files transcripts) copied, $skipped dirs without transcripts skipped${dry[*]:+ (dry run)}"
