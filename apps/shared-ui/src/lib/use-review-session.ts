import { useEffect, useState, useSyncExternalStore } from 'react';
import { useSelector } from '@tanstack/react-store';
import { appStore } from './store';
import { useCreatedAtCutoff } from './card-sync';
import { ReviewSession } from './review-session';

export function useReviewSession(moduleId?: string, autoLoad = true) {
  const [session] = useState(() => new ReviewSession());
  const cutoff = useCreatedAtCutoff();
  const learnAhead = useSelector(appStore, state => state.learnAhead);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  useEffect(() => { session.setLearnAhead(learnAhead); }, [session, learnAhead]);
  useEffect(() => { if (autoLoad) void session.load(moduleId, cutoff); }, [session, moduleId, cutoff, autoLoad]);
  return { session, cutoff, ...state };
}
