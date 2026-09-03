#!/usr/bin/env bash
# disable-upstream-workflows.sh — turn off the eleven workflows inherited from
# upstream, keeping only this fork's own `fork-checks.yml`.
#
# WHY THIS EXISTS
#   Being a fork suppresses several Actions triggers: `pull_request_target`,
#   `issues`, and `schedule` do not fire. That is the only reason upstream's
#   automations have been dormant here. Detaching from the fork network lifts the
#   suppression and they all become live at once:
#
#     ob1-gate-v2.yml               enforces upstream's contribution rules
#                                   (metadata.json, category folders) which this
#                                   fork deliberately does not follow — every
#                                   internal PR would go red
#     update-readme-contributions   runs on a schedule and rewrites README
#     auto-label / welcome-…        fire on every PR and issue
#     claude-issue-triage           needs ANTHROPIC_API_KEY we do not set
#     discord-announce              needs DISCORD_WEBHOOK_URL we do not set
#
# WHY DISABLE RATHER THAN DELETE
#   Deleting them would diverge from upstream in eleven more files and produce
#   conflicts on every rebase, for no benefit. Disabling is repo-level state, so
#   the files stay byte-identical to the pin and `git rebase` stays clean.
#   It is also reversible: `gh api ... /enable` puts any of them back.
#
# WHEN TO RUN
#   After detaching from the fork network. A workflow has to be registered before
#   it can be disabled, and registration happens on first eligible trigger — so
#   re-run this if a new one appears.
#
#   ./.github/disable-upstream-workflows.sh            # show what would change
#   ./.github/disable-upstream-workflows.sh --apply    # actually disable
set -euo pipefail

REPO="${OB1_REPO:-MHarris-SgyMd/OB1}"
KEEP="fork-checks.yml"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

echo "  repo: $REPO   keeping: $KEEP"
echo

registered=$(gh api "repos/$REPO/actions/workflows" --paginate \
  --jq '.workflows[] | "\(.id)\t\(.state)\t\(.path)"')

if [ -z "$registered" ]; then
  echo "  no workflows registered yet — nothing to do"
  exit 0
fi

changed=0
while IFS=$'\t' read -r id state path; do
  name="${path##*/}"
  if [ "$name" = "$KEEP" ]; then
    printf "  keep     %-34s %s\n" "$name" "$state"
    continue
  fi
  if [ "$state" = "disabled_manually" ]; then
    printf "  already  %-34s %s\n" "$name" "$state"
    continue
  fi
  if [ "$APPLY" -eq 1 ]; then
    gh api -X PUT "repos/$REPO/actions/workflows/$id/disable"
    printf "  DISABLED %-34s (was %s)\n" "$name" "$state"
  else
    printf "  would disable %-29s (currently %s)\n" "$name" "$state"
  fi
  changed=$((changed + 1))
done <<< "$registered"

echo
if [ "$APPLY" -eq 1 ]; then
  echo "  disabled $changed workflow(s). Re-enable one with:"
  echo "    gh api -X PUT repos/$REPO/actions/workflows/<id>/enable"
else
  [ "$changed" -eq 0 ] && echo "  nothing to change" || echo "  re-run with --apply to disable $changed"
fi
