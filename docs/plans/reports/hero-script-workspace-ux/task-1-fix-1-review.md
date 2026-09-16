# Task 1 fix round 1 review

Reviewed `9e3dd720..92bddd8d` and the prior Task 1 blockers.

## Blocking findings

1. **[medium] Clearing the topic leaves the full editor visible.** `changeTopic()` only updates `topic` (`page.tsx:111-114`). Once a Hook is selected, clearing the topic unmounts `HookStep` through `topic.trim()` before its context effect can call `onSelectedHookChange(null)`. `selectedHook` therefore remains truthy and the full editor still renders (`page.tsx:154-155`), despite a blank topic. Clear/invalidate the selected Hook synchronously when its upstream context becomes invalid, and add this regression to the mounted fixture.

2. **[medium] Profile behavior coverage remains incomplete.** The new fixture only checks that two generic profiles appear. It does not exercise a revision-0 profile's editable legacy fields or a published profile's 409 read-only response and `manageUrl` routing, both explicit Task 1 checks. It also uses pointer actions only, leaving the required keyboard path unverified.

## Verified

The mounted local fixture passes: Hook/editor are initially hidden, tab switches retain generated/edited content, and a delayed profile response does not replace an explicit duration. The hydration guard also covers the prior restore race by marking restore authoritative.

`git diff --check 9e3dd720..92bddd8d` passes.

## Verdict

**BLOCK.** Fix the blank-topic progression state and complete the required profile/keyboard evidence.
