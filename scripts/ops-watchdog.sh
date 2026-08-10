#!/usr/bin/env bash
# ops-watchdog.sh — OS-level, PM2-independent health watchdog (audit STAB-2).
#
# WHY: today the ONLY automated alert is disk-watch, which is itself a PM2 cron. If PM2 or
# the crons die, the alarm dies with them. This script runs from the ROOT crontab (NOT pm2),
# uses only plain bash + coreutils + curl + sqlite3 (+ python3 if present, for JSON), so it
# still fires even when node_modules / the Next app / pm2 apps are broken.
#
# CHECKS (each rate-limited to 1 alert/hour via a /tmp sentinel):
#   (a) pm2 process health  — ai-content / render-worker / mcp-video-worker must be "online",
#                             and no pm2 app may be "errored".
#   (b) cron heartbeats     — each cron writes <HEARTBEAT_DIR>/<name> on success; alert if a
#                             file's mtime is older than the cron's interval x2 (or missing
#                             past a boot grace period).
#   (c) disk                — df / usage over DISK_THRESHOLD (default 90%).
#   (d) web health          — GET http://127.0.0.1:3000/api/health must be 200 (probed twice).
#   (e) render queue depth  — RenderJob rows QUEUED for > 30 min => worker stalled.
#
# ALERTING: POSTs one JSON body ({"text":...,"content":...}) to $ALERT_WEBHOOK_URL — works for
# Slack ("text") and Discord ("content"). (For LINE Notify use a wrapper that reposts as
# `-d message=`; JSON is not LINE's format.) If $ALERT_WEBHOOK_URL is unset, alerts go to
# stderr so cron still logs them.
#
# INSTALL (run once, as root — do NOT add this to pm2):
#   sudo crontab -e
#   # then add exactly this line (set your webhook):
#   */15 * * * * ALERT_WEBHOOK_URL='https://hooks.slack.com/services/XXX' /var/www/ai-content/scripts/ops-watchdog.sh >> /var/log/ops-watchdog.log 2>&1
#
# Optional env overrides: APP_DIR, DB_PATH, HEARTBEAT_DIR, HEALTH_URL, DISK_THRESHOLD.
# Exits 0 always (a watchdog must not itself crash-loop the crontab).

set -u

# ── Config ────────────────────────────────────────────────────────────────────
APP_DIR="${APP_DIR:-/var/www/ai-content}"
DB_PATH="${DB_PATH:-$APP_DIR/prisma/dev.db}"
HEARTBEAT_DIR="${HEARTBEAT_DIR:-$APP_DIR/.cron-heartbeat}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
DISK_THRESHOLD="${DISK_THRESHOLD:-90}"
QUEUE_STALE_SEC="${QUEUE_STALE_SEC:-1800}"       # RenderJob QUEUED older than this = stalled
RATE_LIMIT_SEC="${RATE_LIMIT_SEC:-3600}"         # 1 alert per check per hour
SENTINEL_DIR="${SENTINEL_DIR:-/tmp/ops-watchdog}"

# Long-running pm2 apps that must be "online" (crons are "stopped" between runs BY DESIGN —
# they are covered by the heartbeat check, NOT here).
PM2_ONLINE_APPS="ai-content render-worker mcp-video-worker"

# Cron heartbeats to check: "<name>:<expected_interval_seconds>". Staleness = interval x2.
#   founding-sweep / reconcile-processing run every 15 min (900s);
#   cleanup-videos / trial-expiry / renewal-reminders / disk-watch run daily (86400s).
CRON_HEARTBEATS="
founding-sweep:900
reconcile-processing:900
reconcile-ai-images:900
cleanup-videos:86400
trial-expiry:86400
renewal-reminders:86400
disk-watch:86400
"

NOW="$(date +%s)"
HOST="$(hostname 2>/dev/null || echo unknown)"
mkdir -p "$SENTINEL_DIR" 2>/dev/null || true

# Boot/install grace marker: reference point for "missing heartbeat" so a fresh watchdog
# install does not false-alarm on daily crons that legitimately have not run yet.
BOOTSTRAP_MARKER="$SENTINEL_DIR/.bootstrap"
[ -f "$BOOTSTRAP_MARKER" ] || : > "$BOOTSTRAP_MARKER" 2>/dev/null || true

HAS_PY3=0
command -v python3 >/dev/null 2>&1 && HAS_PY3=1

# ── Helpers ─────────────────────────────────────────────────────────────────
# Minimal JSON string escaper (pure bash; no jq/python dependency for output).
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  s="${s//$'\r'/}"
  printf '"%s"' "$s"
}

send_alert() {
  local check="$1" msg="$2"
  local text="[HERO AI watchdog] ${HOST} — ${check}: ${msg}"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    local esc; esc="$(json_escape "$text")"
    curl -sf -m 10 -X POST -H "Content-Type: application/json" \
      -d "{\"text\":${esc},\"content\":${esc}}" \
      "$ALERT_WEBHOOK_URL" >/dev/null 2>&1 \
      || echo "[ops-watchdog] $(date -u +%FT%TZ) alert POST failed: ${text}" >&2
  else
    echo "[ops-watchdog] $(date -u +%FT%TZ) ALERT ${text}" >&2
  fi
}

# alert <check-key> <message> — sends at most once per RATE_LIMIT_SEC per check-key.
alert() {
  local check="$1" msg="$2"
  local sentinel="$SENTINEL_DIR/alert-${check}"
  if [ -f "$sentinel" ]; then
    local last; last="$(cat "$sentinel" 2>/dev/null || echo 0)"
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    if [ $((NOW - last)) -lt "$RATE_LIMIT_SEC" ]; then
      return 0
    fi
  fi
  echo "$NOW" > "$sentinel" 2>/dev/null || true
  send_alert "$check" "$msg"
}

# mtime of a path in epoch seconds (GNU or BSD stat), empty if missing.
file_mtime() {
  local f="$1"
  [ -e "$f" ] || return 1
  stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null
}

# ── (a) pm2 process health ─────────────────────────────────────────────────
check_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    alert pm2-missing "pm2 binary not found on PATH — cannot verify process health"
    return
  fi
  local jlist
  jlist="$(pm2 jlist 2>/dev/null)"
  if [ -z "$jlist" ] || [ "$jlist" = "[]" ]; then
    alert pm2-down "pm2 jlist empty — pm2 daemon down or no apps registered"
    return
  fi

  local app st
  for app in $PM2_ONLINE_APPS; do
    st="$(pm2_status "$jlist" "$app")"
    if [ "$st" != "online" ]; then
      alert "pm2-${app}" "pm2 app '${app}' is '${st}' (expected online)"
    fi
  done

  local errored
  errored="$(pm2_errored "$jlist")"
  if [ -n "$errored" ]; then
    alert pm2-errored "pm2 app(s) in errored state: ${errored}"
  fi
}

# status string for a pm2 app name (python3 preferred; grep fallback).
pm2_status() {
  local jlist="$1" name="$2"
  if [ "$HAS_PY3" = "1" ]; then
    PM2_JLIST="$jlist" PM2_NAME="$name" python3 -c '
import json, os
try:
    d = json.loads(os.environ["PM2_JLIST"])
except Exception:
    print("parse-error"); raise SystemExit
n = os.environ["PM2_NAME"]
print(next((a.get("pm2_env", {}).get("status", "unknown") for a in d if a.get("name") == n), "missing"))
' 2>/dev/null && return
  fi
  # Fallback: split on braces/commas, find the app's object, read its status.
  printf '%s' "$jlist" | tr '{},' '\n\n\n' \
    | grep -A40 "\"name\":\"${name}\"" \
    | grep -m1 '"status"' \
    | sed 's/.*"status":"\([^"]*\)".*/\1/' \
    | grep . || echo "missing"
}

# space-separated list of pm2 app names whose status == errored (empty if none).
pm2_errored() {
  local jlist="$1"
  if [ "$HAS_PY3" = "1" ]; then
    PM2_JLIST="$jlist" python3 -c '
import json, os
try:
    d = json.loads(os.environ["PM2_JLIST"])
except Exception:
    raise SystemExit
print(" ".join(a.get("name", "?") for a in d if a.get("pm2_env", {}).get("status") == "errored"))
' 2>/dev/null && return
  fi
  printf '%s' "$jlist" | grep -o '"status":"errored"' >/dev/null 2>&1 && echo "one-or-more"
}

# ── (b) cron heartbeats ─────────────────────────────────────────────────────
check_heartbeats() {
  local line name interval max_age mtime ref age
  local boot_mtime; boot_mtime="$(file_mtime "$BOOTSTRAP_MARKER" || echo "$NOW")"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    name="${line%%:*}"
    interval="${line##*:}"
    case "$interval" in ''|*[!0-9]*) continue ;; esac
    max_age=$((interval * 2))
    if mtime="$(file_mtime "$HEARTBEAT_DIR/$name")"; then
      ref="$mtime"
    else
      # No heartbeat yet: measure from watchdog install (boot marker), not epoch 0, so a
      # fresh install gets one interval x2 of grace before flagging a never-run cron.
      ref="$boot_mtime"
    fi
    age=$((NOW - ref))
    if [ "$age" -gt "$max_age" ]; then
      if [ -n "$mtime" ]; then
        alert "cron-${name}" "cron heartbeat stale: last run ${age}s ago (limit ${max_age}s)"
      else
        alert "cron-${name}" "cron heartbeat missing for ${age}s (limit ${max_age}s) — cron never ran?"
      fi
    fi
    mtime=""
  done <<EOF
$CRON_HEARTBEATS
EOF
}

# ── (c) disk ────────────────────────────────────────────────────────────────
check_disk() {
  local pct
  pct="$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')"
  case "$pct" in ''|*[!0-9]*) return ;; esac
  if [ "$pct" -gt "$DISK_THRESHOLD" ]; then
    alert disk "disk / at ${pct}% (threshold ${DISK_THRESHOLD}%)"
  fi
}

# ── (d) web health (probe twice to avoid a single-blip false alarm) ─────────
check_web() {
  local i
  for i in 1 2; do
    if curl -sf -m 10 -o /dev/null "$HEALTH_URL"; then
      return 0
    fi
    sleep 3
  done
  alert web "GET ${HEALTH_URL} failed 2x (non-200 or unreachable) — app down?"
}

# ── (e) render queue depth ──────────────────────────────────────────────────
check_queue() {
  command -v sqlite3 >/dev/null 2>&1 || return
  [ -f "$DB_PATH" ] || return
  local n
  n="$(sqlite3 "$DB_PATH" "select count(*) from RenderJob where status='QUEUED' and createdAt < (strftime('%s','now')-${QUEUE_STALE_SEC})*1000;" 2>/dev/null)"
  case "$n" in ''|*[!0-9]*) return ;; esac
  if [ "$n" -gt 0 ]; then
    alert queue "${n} RenderJob(s) QUEUED > $((QUEUE_STALE_SEC/60)) min — render worker stalled?"
  fi
}

# ── Run all checks (each isolated; one failing check must not skip the rest) ──
check_pm2         || true
check_heartbeats  || true
check_disk        || true
check_web         || true
check_queue       || true

exit 0
