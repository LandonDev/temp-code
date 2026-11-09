# Sourced by release-publish.sh; uses its begin/end phase helpers.
install_publish_dependencies() {
  lock_digest=$(shasum -a 256 bun.lock) || return 1
  lock_digest=${lock_digest%% *}
  if [ -f node_modules/.tc-installed-lock ] &&
    [ "$(cat node_modules/.tc-installed-lock)" = "$lock_digest" ]; then
    echo "phase – install skipped (lockfile unchanged)"
    return 0
  fi

  begin install
  # A failed install can leave partial changes, so discard the old marker.
  rm -f node_modules/.tc-installed-lock || return 1
  bun install --frozen-lockfile >"$1" 2>&1 || { tail -40 "$1" >&2; return 1; }
  printf '%s\n' "$lock_digest" >node_modules/.tc-installed-lock || return 1
  end
}
