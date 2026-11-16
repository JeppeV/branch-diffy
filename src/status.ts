import { UnstagedChange } from './git';

export const statusInfo: Record<UnstagedChange['status'], { label: string; color: string }> = {
  A: { label: 'Added', color: 'gitDecoration.addedResourceForeground' },
  M: { label: 'Modified', color: 'gitDecoration.modifiedResourceForeground' },
  D: { label: 'Deleted', color: 'gitDecoration.deletedResourceForeground' },
  R: { label: 'Renamed', color: 'gitDecoration.renamedResourceForeground' },
  C: { label: 'Copied', color: 'gitDecoration.addedResourceForeground' },
  T: { label: 'Type changed', color: 'gitDecoration.modifiedResourceForeground' },
  U: { label: 'Untracked', color: 'gitDecoration.untrackedResourceForeground' },
  '!': { label: 'Conflicted', color: 'gitDecoration.conflictingResourceForeground' },
};
