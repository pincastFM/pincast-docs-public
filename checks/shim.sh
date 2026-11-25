# Sourced before every shell sample. curl here sends the API address the docs print to
# PINCAST_API, refuses every other address and the no-account route, writes each call to
# SAMPLES_CALLS, and fails on an HTTP error unless the block's marker expects that status.
SAMPLES_REAL_API=https://api.pincast.fm/v1

curl() {
  local args=() a prev="" method="" url="" data=0
  for a in "$@"; do
    case "$a" in "$SAMPLES_REAL_API"*) a="$PINCAST_API${a#"$SAMPLES_REAL_API"}" ;; esac
    args+=("$a")
    case "$prev" in -X | --request) method="$a" ;; esac
    case "$a" in
      -d | --data | --data-raw | --data-binary) data=1 ;;
      http://* | https://*) [ -n "$url" ] || url="$a" ;;
    esac
    prev="$a"
  done
  if [ -z "$method" ]; then
    if [ "$data" = 1 ]; then method=POST; else method=GET; fi
  fi
  case "$url" in
    "$PINCAST_API"/*) ;;
    *) echo "samples: refused $method $url: a sample may call only the Pincast API" >&2; return 97 ;;
  esac
  local path="${url#"$PINCAST_API"}"
  path="${path%%\?*}"
  if [ "$method" = POST ] && [ "$path" = /test-apps ]; then
    echo "samples: refused POST /test-apps, the no-account route" >&2
    return 97
  fi
  local out code
  out="$(mktemp)"
  code="$(command curl -sS -o "$out" -w '%{http_code}' "${args[@]}")" || { cat "$out"; rm -f "$out"; return 1; }
  cat "$out"
  echo
  rm -f "$out"
  echo "api $method $path $code" >> "$SAMPLES_CALLS"
  case "$code" in 2??) return 0 ;; esac
  [ "$code" = "${SAMPLES_EXPECT:-}" ] && return 0
  echo "samples: $method $path answered $code" >&2
  return 1
}
