# Ops Guardrails Runbook (PR-4)

Prod box: Hostinger VPS — `ssh -i ~/.ssh/hostinger_heroai_codex root@72.62.196.230`
App dir: `/var/www/ai-content` · PM2 app: `ai-content`

> Policy: confirm with the team (Mew/wao) before SSHing into prod; run heavy
> steps off-peak. These steps are config-only and independent of any deploy.

## 1. pm2-logrotate (50MB × 5, compressed)

Why: the PM2 error log reached 414MB / 9.7M lines (2026-06-10 audit) —
unbounded logs eat the same disk renders need and make `pm2 logs` unusable.

Run on the VPS:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 5
pm2 set pm2-logrotate:compress true
pm2 save
```

`pm2 save` persists the module and its settings across reboots; installing the module briefly restarts only the logrotate worker — no impact on `ai-content`.

Verify:

```bash
pm2 conf pm2-logrotate
```

Expected: output like `$ pm2 set pm2-logrotate:max_size 50M`, `$ pm2 set pm2-logrotate:retain 5`, `$ pm2 set pm2-logrotate:compress true` (pm2 prints settings as `pm2 set` lines). If any of those three shows a different value, re-run the corresponding `pm2 set` command above.

The rotation worker checks sizes on each tick (default every 30s), so the existing oversized logs get rotated into compressed archives almost immediately. Confirm:

```bash
ls -lh /root/.pm2/logs/ | head -20
du -sh /root/.pm2/logs/
```

Expected: every live `*.log` is under 50M; `*.log.gz` archives appear
(at most 5 retained per log).
