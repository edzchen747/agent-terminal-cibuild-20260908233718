/**
 * Tab bookkeeping for switching a terminal tab's shell.
 *
 * The host's `select_shell` has two outcomes:
 *
 * - The outgoing tab has no output yet: the host closes it and creates the
 *   replacement, which the renderer shows in the old tab's slot (the user
 *   just picked a different starter shell for a blank tab).
 * - The outgoing tab keeps its history: the host keeps it and creates the
 *   replacement after the project's last session, so the renderer must open
 *   the new tab after the last one and leave the kept tab in place.
 *
 * In both cases the host appends the replacement to the end of its own
 * session order, and the window's state-sync effect may have already
 * appended the replacement id to the local order before these updaters
 * run - so every function below dedupes the replacement first.
 */

import { findSplitGroup, type SplitGroup } from "./split-tabs.ts";

/**
 * The tab order after switching the active tab's shell.
 *
 * `outgoingRetained` tells whether the host kept the outgoing session
 * (it had output) or closed it (blank tab). Retained: the new tab opens
 * after the last one and every existing tab keeps its position. Closed:
 * the replacement takes over the outgoing tab's slot; when the outgoing
 * id is unknown locally, it falls back to the tail.
 */
export function shellSwitchSessionOrder(
  order: string[],
  outgoingId: string,
  replacementId: string,
  outgoingRetained: boolean
): string[] {
  const withoutReplacement = order.filter((id) => id !== replacementId);
  if (outgoingRetained) return [...withoutReplacement, replacementId];
  const mapped = withoutReplacement.map((id) => (id === outgoingId ? replacementId : id));
  return mapped.includes(replacementId) ? mapped : [...mapped, replacementId];
}

/**
 * The split groups after switching the active tab's shell.
 *
 * A closed blank tab leaves no pane behind, so the replacement takes its
 * place inside the split and the split keeps showing two live panes. A
 * retained tab keeps its history as a regular tab, so the split is left
 * exactly as it was and the new tab opens standalone after the last one -
 * no group ever references the replacement in that case.
 */
export function shellSwitchSplitGroups(
  groups: SplitGroup[],
  outgoingId: string,
  replacementId: string,
  outgoingRetained: boolean
): SplitGroup[] {
  const outgoingSplit = findSplitGroup(groups, outgoingId);
  if (!outgoingSplit || outgoingRetained) return groups;
  const sessionIds: [string, string] = outgoingSplit.sessionIds[0] === outgoingId
    ? [replacementId, outgoingSplit.sessionIds[1]]
    : [outgoingSplit.sessionIds[0], replacementId];
  return [
    ...groups.filter((group) => group.id !== outgoingSplit.id && !group.sessionIds.includes(replacementId)),
    { ...outgoingSplit, sessionIds }
  ];
}
