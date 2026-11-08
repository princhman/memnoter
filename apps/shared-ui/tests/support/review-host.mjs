// A fake native side for review-native.html: answers the core commands the
// review session makes and records posted state. `loadCard(card, revealed)`
// puts one card in the queue and shows it.
export function installReviewHost() {
  window.__states = [];
  window.__writes = [];
  window.installTestBridge({ native: message => {
    if (message.kind === 'event') {
      if (message.event === 'reviewState') window.__states.push(message.payload);
      return;
    }
    let value = null;
    if (message.command === 'review_card' || message.command === 'undo_review') {
      window.__writes.push(message.command);
      Object.assign(window.__card, message.args.card ?? message.args.previous);
    }
    if (message.command === 'due_cards') value = window.__card ? [structuredClone(window.__card)] : [];
    if (['unindexed_modules', 'unindexed_card_modules'].includes(message.command)) value = [];
    queueMicrotask(() => window.__memnoterBridge.resolve(message.id, value));
  } });
  window.loadCard = async (card, revealed) => {
    window.__card = { moduleId: card.id, moduleName: '', section: [],
      dueAt: Date.now() - 60000, stability: 0, stabilityFast: 0, difficulty: 0,
      scheduledDays: 0, learningStep: 0, state: 0, scheduleStatus: 'new',
      lastReviewAt: null, lapses: 0, fsrsModel: null, ...card };
    await window.memnoterReview.load(card.id + card.reps);
    if (revealed) window.memnoterReview.reveal();
  };
}
