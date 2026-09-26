#!/bin/zsh
# Gilbert OS daily reconciliation — run by launchd, NOT by any application.
#
# Why launchd: the previous schedule lived inside the Claude desktop app, so it
# only fired if that app happened to be running at the time. Three consecutive
# weekdays (19-21 Aug 2026) were skipped silently and never retried. launchd is
# the OS's own scheduler: it runs whether or not any app is open, and with
# StartCalendarInterval it fires a missed run when the Mac next wakes.
#
# Covers BOTH halves now. The email sweep reads the Mail store on disk rather
# than driving Mail, which is why it can run unattended: Mail wedges within
# seconds under scripted access, but the .emlx files can be read directly since
# Full Disk Access was granted.
set -u
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
cd /Users/tomgilbert/GilbertOS || exit 1

LOG="$HOME/Library/Logs/GilbertOS/reconcile-$(date +%Y-%m-%d).log"

# --- SWEEP STALENESS ---------------------------------------------------------
# The sweep throws if it cannot read the Mail store (launchd's zsh does not
# inherit Full Disk Access). That throw used to land in a logfile nobody reads:
# it failed identically for 12 runs across 18 days and nothing said so. Computed
# out here, NOT inside the `{ } | tee` block - a pipe runs in a subshell and the
# variable would never reach the exit check below.
sweep_stale=0
stale_days=$(npx tsx --env-file=.env.local --env-file=.env.development.local scripts/sweep-staleness.mts 2>/dev/null | tail -1)
case "$stale_days" in ''|*[!0-9]*) stale_days=999 ;; esac
[ "$stale_days" -ge 2 ] && sweep_stale=1

{
if [ "$sweep_stale" = "1" ]; then
    echo "################################################################"
    echo "## EMAIL SWEEP IS STALE - last succeeded ${stale_days} days ago"
    echo "## Invoices are arriving by email and nothing is reading them."
    echo "## Usual cause: launchd's /bin/zsh lacks Full Disk Access."
    echo "## System Settings > Privacy & Security > Full Disk Access > +"
    echo "################################################################"
    echo
  fi
  echo "===== Gilbert OS reconciliation $(date '+%Y-%m-%d %H:%M:%S') ====="
  echo
  echo "--- Xero bill status -> OS payment status ---"
  npx tsx --env-file=.env.local --env-file=.env.development.local scripts/sync-xero-payments.mts --execute 2>&1 | tail -30
  echo
  echo "--- Bank payments vs OS invoices (report only) ---"
  npx tsx --env-file=.env.local --env-file=.env.development.local scripts/match-xero-spend.mts 2>&1 | tail -40
  echo
  echo "--- New invoice emails (sweeps every mailbox, including Clutter) ---"
  npx tsx --env-file=.env.local --env-file=.env.development.local scripts/sweep-mail-store.mts --days=7 2>&1 | tail -30
  echo
  echo "--- Payment status vs money actually in Xero ---"
  npx tsx --env-file=.env.local --env-file=.env.development.local scripts/refresh-supplier-paid.mts 2>&1 | tail -3
  npx tsx --env-file=.env.local --env-file=.env.development.local scripts/audit-payment-status.mts 2>&1 | tail -30
  echo
  echo "--- New OS invoices -> Xero bills ---"
  npx tsx --env-file=.env.local --env-file=.env.development.local scripts/push-invoices-to-xero.mts --execute 2>&1 | tail -20
  echo
  echo "===== finished $(date '+%H:%M:%S') ====="
} >> "$LOG" 2>&1

# Keep a stable pointer to the newest run so it is always one path to check.
ln -sf "$LOG" "$HOME/Library/Logs/GilbertOS/latest.log"

if [ "$sweep_stale" = "1" ]; then
  echo
  echo "EXITING NON-ZERO: the email half did not run (sweep stale ${stale_days}d)."
  exit 1
fi
