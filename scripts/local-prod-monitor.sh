#!/bin/bash
# local-prod-monitor.sh — zero-token prod health check, runs on Mew's Mac mini via cron.
# Read-only against the VPS; alerts to Discord ONLY when something crosses a threshold.
# Install (macOS crontab):  crontab -e  →  23 */4 * * * /Users/mewsocialmacmini/projects/AI_content_Mew_social/scripts/local-prod-monitor.sh
# Log: /tmp/heroai-local-monitor.log · Alert dedupe: /tmp/heroai-monitor-lastalert

SSH_KEY="$HOME/.ssh/hostinger_heroai_codex"
HOST="root@72.62.196.230"
LOG="/tmp/heroai-local-monitor.log"
DEDUPE="/tmp/heroai-monitor-lastalert"

OUT=$(ssh -o ConnectTimeout=15 -o BatchMode=yes -i "$SSH_KEY" "$HOST" '
cd /var/www/ai-content || exit 9
# 1) non-cron pm2 apps not online (cron apps stopped = by design)
BAD=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
CRON={\"trial-expiry\",\"founding-sweep\",\"renewal-reminders\",\"cleanup-videos\",\"reconcile-processing\",\"reconcile-ai-images\",\"mine-loanwords\",\"disk-watch\",\"db-backup\",\"media-cleanup\"}
apps=json.load(sys.stdin)
print(\",\".join(p[\"name\"]+\":\"+p[\"pm2_env\"][\"status\"] for p in apps if p[\"name\"] not in CRON and p[\"pm2_env\"][\"status\"]!=\"online\") or \"none\")
")
# 2) jobs stuck processing > 30 min
STUCK=$(sqlite3 -readonly prisma/dev.db "SELECT COUNT(*) FROM VideoJob WHERE status=\"processing\" AND updatedAt < (strftime(\"%s\",\"now\")-1800)*1000;")
# 3) queued backlog right now
QUEUED=$(sqlite3 -readonly prisma/dev.db "SELECT COUNT(*) FROM VideoJob WHERE status=\"queued\";")
# 4) failed jobs last 4h
FAILED4H=$(sqlite3 -readonly prisma/dev.db "SELECT COUNT(*) FROM VideoJob WHERE status=\"failed\" AND updatedAt > (strftime(\"%s\",\"now\")-14400)*1000;")
# 5) disk used %
DISK=$(df / | awk "NR==2{gsub(\"%\",\"\",\$5); print \$5}")
# 6) nginx 5xx in the last 4 hours — match any of the 5 hour-prefixes (dd/Mon/yyyy:HH) covering now..now-4h UTC
HOURS=$(for i in 0 1 2 3 4; do date -u -d "-$i hours" +%d/%b/%Y:%H; done | paste -sd"|" -)
NX=$(awk -v re="$HOURS" "\$4 ~ re && \$9 ~ /^50[23]\$/ {c++} END{print c+0}" /var/log/nginx/access.log 2>/dev/null)
# 7) degraded-timing markers last 4h
DEG=$(sqlite3 -readonly prisma/dev.db "SELECT COUNT(*) FROM TelemetryEvent WHERE name=\"tts_timing_degraded\" AND createdAt > (strftime(\"%s\",\"now\")-14400)*1000;" 2>/dev/null || echo 0)
echo "BAD=$BAD STUCK=$STUCK QUEUED=$QUEUED FAILED4H=$FAILED4H DISK=$DISK NX5XX=$NX DEG=$DEG"
' 2>&1)

echo "$(date '+%F %T') $OUT" >> "$LOG"

# unreachable server = alert
if ! echo "$OUT" | grep -q "^BAD="; then
  ALERT="HERO AI monitor: SSH/collect FAILED — $OUT"
else
  eval "$(echo "$OUT" | tr ' ' '\n' | grep -E '^(BAD|STUCK|QUEUED|FAILED4H|DISK|NX5XX|DEG)=')"
  PROBLEMS=""
  [ "$BAD" != "none" ] && PROBLEMS="$PROBLEMS app:$BAD"
  [ "${STUCK:-0}" -gt 3 ] && PROBLEMS="$PROBLEMS stuck:$STUCK"
  [ "${QUEUED:-0}" -gt 10 ] && PROBLEMS="$PROBLEMS queue:$QUEUED"
  [ "${FAILED4H:-0}" -gt 8 ] && PROBLEMS="$PROBLEMS failed4h:$FAILED4H"
  [ "${DISK:-0}" -gt 70 ] && PROBLEMS="$PROBLEMS disk:${DISK}%"
  [ "${NX5XX:-0}" -gt 50 ] && PROBLEMS="$PROBLEMS 5xx:$NX5XX"
  [ "${DEG:-0}" -gt 5 ] && PROBLEMS="$PROBLEMS degradedSubs:$DEG"
  [ -n "$PROBLEMS" ] && ALERT="HERO AI monitor:$PROBLEMS → เปิด docs/runbooks/2026-07-18-launch-event.md §C/§D"
fi

if [ -n "$ALERT" ]; then
  # dedupe: same alert within 2h → skip
  LAST=$(cat "$DEDUPE" 2>/dev/null)
  NOW=$(date +%s)
  LAST_TS=${LAST%%|*}; LAST_MSG=${LAST#*|}
  if [ "$LAST_MSG" != "$ALERT" ] || [ $((NOW - ${LAST_TS:-0})) -gt 7200 ]; then
    WEBHOOK=$(ssh -o ConnectTimeout=10 -o BatchMode=yes -i "$SSH_KEY" "$HOST" 'grep ^ALERT_WEBHOOK_URL= /var/www/ai-content/.env | cut -d= -f2-')
    [ -n "$WEBHOOK" ] && curl -s -X POST -H 'Content-Type: application/json' -d "{\"content\":\"$ALERT\"}" "$WEBHOOK" >/dev/null
    echo "$NOW|$ALERT" > "$DEDUPE"
    osascript -e "display notification \"$ALERT\" with title \"HERO AI Monitor\"" 2>/dev/null
  fi
fi
