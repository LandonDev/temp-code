#!/usr/bin/env bash
set -euo pipefail
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ssh -o BatchMode=yes -o PasswordAuthentication=no box true
echo 'PASS: fresh key login'
failure=$(mktemp); info=$(mktemp); headers=$(mktemp)
trap 'rm -f "$failure" "$info" "$headers"' EXIT
if ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password \
  -o NumberOfPasswordPrompts=0 -o ConnectTimeout=10 box true 2> "$failure"; then
  echo 'ERROR: SSH password-only login succeeded' >&2; exit 1
fi
grep -q 'Permission denied (publickey)' "$failure" || { cat "$failure" >&2; exit 1; }
echo 'PASS: password authentication refused; server offers only publickey'
ssh -o BatchMode=yes box 'bash /opt/box-baseline/90-verify.sh'
cloudflared --config "$HERE/cloudflared-local.yml" tunnel info --output json tempcode-box > "$info"
python3 - "$info" <<'PY'
import json,sys
t=json.load(open(sys.argv[1]))
assert t['name']=='tempcode-box'
c=t.get('conns',[])
assert len(c)==1, f'Expected one connector, found {len(c)}'
assert c[0]['arch']=='linux_amd64', c[0]['arch']
assert any(x.get('origin_ip')=='104.194.11.2' for x in c[0].get('conns',[])), 'Box origin IP missing'
print('PASS: one Linux connector from 104.194.11.2')
PY
curl -sSI --connect-timeout 10 --max-time 20 https://tempcode.landonhale.com > "$headers"
grep -qi '^server: cloudflare' "$headers" || { cat "$headers"; exit 1; }
head -n 1 "$headers"
echo 'PASS: HTTPS reaches Cloudflare (502 expected before thread C starts 7677)'
