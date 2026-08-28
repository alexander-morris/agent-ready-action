#!/usr/bin/env bash
#
# agent-ready-action quick start.
#
#   curl -fsSL https://raw.githubusercontent.com/alexander-morris/agent-ready-action/main/install.sh | bash
#
# Writes a workflow into .github/workflows/, working out your site directory and
# host for you. Nothing is committed or pushed — you review the file first.
#
# Non-interactive:
#   curl -fsSL .../install.sh | bash -s -- --url https://example.com --yes
#
set -euo pipefail

ACTION_REF="${AGENT_READY_REF:-alexander-morris/agent-ready-action@v1}"
WORKFLOW_PATH=".github/workflows/agent-ready.yml"

URL=""
SITE_DIR=""
SCHEDULE="weekly"
ASSUME_YES=0
MODE="pr"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
agent-ready quick start

  --url <url>        The site to score. Prompted for if omitted.
  --site-dir <dir>   Servable root (public/, static/ ...). Auto-detected if omitted.
  --schedule <s>     weekly (default) | daily | monthly | manual
  --mode <m>         pr (default) | fix | scan
  --ref <owner/repo@ref>  Pin a different version of the action.
  --yes              Do not prompt. Requires --url.
  -h, --help         This.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)       URL="${2:-}"; shift 2 ;;
    --site-dir)  SITE_DIR="${2:-}"; shift 2 ;;
    --schedule)  SCHEDULE="${2:-}"; shift 2 ;;
    --mode)      MODE="${2:-}"; shift 2 ;;
    --ref)       ACTION_REF="${2:-}"; shift 2 ;;
    --yes|-y)    ASSUME_YES=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "unknown option: $1 (try --help)" ;;
  esac
done

# Prompts must read from the terminal: under `curl | bash` stdin is the script
# itself, so we open /dev/tty explicitly. Where there is no terminal at all
# (CI, a container) every prompt silently takes its default.
have_tty() {
  [ "$ASSUME_YES" = "1" ] && return 1
  { exec 3<>/dev/tty; } 2>/dev/null || return 1
  exec 3>&-
  return 0
}

prompt() {
  local message="$1" default="${2:-}" answer=""
  if ! have_tty; then
    printf '%s' "$default"
    return
  fi
  exec 3<>/dev/tty
  if [ -n "$default" ]; then printf '%s [%s]: ' "$message" "$default" >&3
  else printf '%s: ' "$message" >&3; fi
  IFS= read -r answer <&3 || answer=""
  exec 3>&-
  printf '%s' "${answer:-$default}"
}

echo
bold "agent-ready — AI agent readiness for your site, in CI"
dim  "Scores your site the way Cloudflare does, then opens a PR that fixes what's failing."
echo

# ---------------------------------------------------------------- repository

command -v git >/dev/null 2>&1 || die "git is required."
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[ -n "$REPO_ROOT" ] || die "Run this inside a git repository (the workflow has to live somewhere)."
cd "$REPO_ROOT"
ok "Repository: $REPO_ROOT"

# ---------------------------------------------------------------- site dir

detect_site_dir() {
  if   [ -f astro.config.mjs ] || [ -f astro.config.ts ] || [ -f astro.config.js ]; then echo "public"
  elif [ -f next.config.js ] || [ -f next.config.mjs ] || [ -f next.config.ts ];    then echo "public"
  elif [ -f nuxt.config.ts ] || [ -f nuxt.config.js ];                              then echo "public"
  elif [ -f svelte.config.js ];                                                     then echo "static"
  elif [ -f gatsby-config.js ] || [ -f gatsby-config.ts ];                          then echo "static"
  elif [ -f docusaurus.config.js ] || [ -f docusaurus.config.ts ];                  then echo "static"
  elif [ -f hugo.toml ] || [ -f hugo.yaml ] || { [ -f config.toml ] && [ -d content ]; }; then echo "static"
  elif [ -f _config.yml ] && [ -d _posts ];                                         then echo "."
  elif [ -d public ];                                                               then echo "public"
  elif [ -d static ];                                                               then echo "static"
  elif [ -d docs ];                                                                 then echo "docs"
  else echo ""
  fi
}

if [ -z "$SITE_DIR" ]; then
  SITE_DIR="$(detect_site_dir)"
  if [ -n "$SITE_DIR" ]; then ok "Site directory: ${SITE_DIR} (detected)"
  else warn "Could not detect a site directory — the action will work it out at run time."; fi
else
  ok "Site directory: ${SITE_DIR}"
fi

# ---------------------------------------------------------------- url

guess_url() {
  if [ -f CNAME ]; then printf 'https://%s' "$(tr -d '[:space:]' < CNAME)"; return; fi
  for f in public/CNAME static/CNAME docs/CNAME; do
    [ -f "$f" ] && { printf 'https://%s' "$(tr -d '[:space:]' < "$f")"; return; }
  done
  if [ -f package.json ] && command -v node >/dev/null 2>&1; then
    node -e 'try{const p=require("./package.json");const h=p.homepage||(p.repository&&p.repository.url);if(h&&/^https?:/.test(h))process.stdout.write(new URL(h).origin)}catch(e){}' 2>/dev/null && return
  fi
  printf ''
}

if [ -z "$URL" ]; then
  GUESS="$(guess_url)"
  URL="$(prompt "Which URL should be scored?" "$GUESS")"
fi
[ -n "$URL" ] || die "A URL is required. Rerun with --url https://your-site.com"
case "$URL" in
  http://*|https://*) : ;;
  *) URL="https://$URL" ;;
esac
ok "Scoring: $URL"

# ---------------------------------------------------------------- schedule

case "$SCHEDULE" in
  daily)   CRON="0 8 * * *";  SCHEDULE_NOTE="every day at 08:00 UTC" ;;
  weekly)  CRON="0 8 * * 1";  SCHEDULE_NOTE="every Monday at 08:00 UTC" ;;
  monthly) CRON="0 8 1 * *";  SCHEDULE_NOTE="on the 1st of each month at 08:00 UTC" ;;
  manual)  CRON="";           SCHEDULE_NOTE="only when you run it by hand" ;;
  *) die "--schedule must be daily, weekly, monthly or manual" ;;
esac

# ---------------------------------------------------------------- write it

if [ -f "$WORKFLOW_PATH" ]; then
  REPLY_OVERWRITE="$(prompt "$WORKFLOW_PATH already exists. Overwrite? (y/N)" "n")"
  case "$REPLY_OVERWRITE" in
    y|Y|yes|YES) : ;;
    *) die "Left your existing workflow alone. Nothing was changed." ;;
  esac
fi

mkdir -p .github/workflows

{
  echo "# Scores this site's AI agent readiness and opens a PR with the fixes."
  echo "# Generated by: https://github.com/alexander-morris/agent-ready-action"
  echo "name: Agent Ready"
  echo
  echo "on:"
  echo "  workflow_dispatch:"
  if [ -n "$CRON" ]; then
    echo "  schedule:"
    echo "    - cron: '$CRON'"
  fi
  echo
  echo "permissions:"
  echo "  contents: write"
  echo "  pull-requests: write"
  echo
  echo "jobs:"
  echo "  agent-ready:"
  echo "    runs-on: ubuntu-latest"
  echo "    steps:"
  echo "      - uses: actions/checkout@v4"
  echo
  echo "      - uses: ${ACTION_REF}"
  echo "        env:"
  echo "          # Optional. With it, fixes are generated inside a disposable Tenki VM"
  echo "          # and the patched site is re-scored on a public preview URL before the"
  echo "          # PR is opened. Without it, everything runs on this runner instead."
  echo "          TENKI_API_KEY: \${{ secrets.TENKI_API_KEY }}"
  echo "        with:"
  echo "          url: ${URL}"
  if [ -n "$SITE_DIR" ] && [ "$SITE_DIR" != "." ]; then
    echo "          site-dir: ${SITE_DIR}"
  fi
  echo "          mode: ${MODE}"
  echo
  echo "          # open | balanced | closed — what AI crawlers may do with your content."
  echo "          ai-policy: balanced"
  echo
  echo "          # Optional. The free tier covers 50 scans a month per GitHub org;"
  echo "          # a key raises that and adds score history and drift alerts."
  echo "          # https://mitosislabs.ai/agent-ready"
  echo "          license-key: \${{ secrets.AGENT_READY_KEY }}"
  echo
  echo "          # Fill these in to publish real capability cards. Left empty on purpose:"
  echo "          # advertising an MCP server or API you do not run makes agents fail"
  echo "          # against your site, so nothing is generated until you say it exists."
  echo "          # mcp-endpoint: https://your-site.com/mcp"
  echo "          # openapi-url: /openapi.json"
  echo "          # api-docs-url: https://your-site.com/docs/api"
} > "$WORKFLOW_PATH"

ok "Wrote $WORKFLOW_PATH — runs $SCHEDULE_NOTE, plus on demand."

# ---------------------------------------------------------------- tenki secret

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  if gh secret list 2>/dev/null | grep -q '^TENKI_API_KEY'; then
    ok "TENKI_API_KEY is already set for this repository."
  else
    echo
    if have_tty; then
      dim "Optional: a Tenki API key (https://tenki.cloud) runs the fixers in a disposable"
      dim "VM and verifies the patched site on a real preview URL before opening the PR."
      dim "Leave blank to skip — the action falls back to the GitHub runner."
    fi
    KEY="$(prompt "Tenki API key (tk_...)" "")"
    if [ -n "$KEY" ]; then
      if printf '%s' "$KEY" | gh secret set TENKI_API_KEY >/dev/null 2>&1; then
        ok "Stored TENKI_API_KEY as a repository secret."
      else
        warn "Could not store the secret. Add it manually under Settings → Secrets → Actions."
      fi
    else
      dim "Skipped. Add it later with: gh secret set TENKI_API_KEY"
    fi
  fi
else
  echo
  dim "Optional: add a Tenki API key to run the fixers in a disposable VM and verify"
  dim "the result on a real preview URL:  gh secret set TENKI_API_KEY"
fi

# ---------------------------------------------------------------- done

echo
bold "Done. Next:"
echo "  1. Review the workflow:   cat $WORKFLOW_PATH"
echo "  2. Commit it:             git add $WORKFLOW_PATH && git commit -m 'Add agent-ready workflow'"
echo "  3. Push, then run it:     gh workflow run 'Agent Ready'"
echo
dim "Want to see the score before committing anything?"
echo "  npx --yes github:alexander-morris/agent-ready-action scan $URL"
echo
dim "The free tier covers 50 scans a month per GitHub org — no signup needed."
dim "More scans, score history and drift alerts: https://mitosislabs.ai/agent-ready"
echo
