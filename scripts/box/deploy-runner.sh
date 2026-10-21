#!/usr/bin/env bash
# The root side of "Deploy master to the box" (docs/box.md "Updating" →
# "Deploy from the app"). temp-code-deploy.path starts this oneshot when
# the app (the agents user) drops a ref into /run/temp-code/deploy/request;
# the ref is taken as master or a v1.0.N tag only, box-update runs with its
# output in /run/temp-code/deploy/log, and /run/temp-code/deploy/exit lands
# last with the status. The app reads only these files: it never runs
# anything as root. TEMP_CODE_DEPLOY_DIR and TEMP_CODE_BOX_UPDATE point a
# proof at a scratch directory and a fake launcher.
set -uo pipefail
dir=${TEMP_CODE_DEPLOY_DIR:-/run/temp-code/deploy}
box_update=${TEMP_CODE_BOX_UPDATE:-/usr/local/sbin/box-update}
request=$dir/request log=$dir/log exit_file=$dir/exit ref_file=$dir/ref
[[ -f $request ]] || exit 0
# One line, nothing else: the app writes exactly that.
ref=$(head -c 200 "$request" | tr -d '\n')
# Order matters for the app's reading of the directory: no `exit` and an
# empty `log` before `request` goes, so the state is never "finished" or
# "idle" between a request and its run.
rm -f "$exit_file"
: > "$log"
chmod 644 "$log"
printf '%s\n' "$ref" > "$ref_file"
chmod 644 "$ref_file"
rm -f "$request"
finish() {
  printf '%s\n' "$1" > "$exit_file.tmp"
  chmod 644 "$exit_file.tmp"
  mv -f "$exit_file.tmp" "$exit_file"
  exit 0
}
if [[ $ref != master && ! $ref =~ ^v1\.0\.[0-9]+$ ]]; then
  echo "ERROR: refused ref '$ref': master or a v1.0.N tag only" >> "$log"
  finish 2
fi
echo "== box-update $ref ($(date -u +%FT%TZ))" >> "$log"
"$box_update" "$ref" >> "$log" 2>&1
status=$?
echo "== box-update exited $status" >> "$log"
finish "$status"
