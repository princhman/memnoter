import { createRoot } from "react-dom/client";
import { CardFace } from "../components/card-face";
import { getScheduler, scheduleReview, type StoredCard, type Grade } from "../lib/fsrs";
import "../lib/backend";
import "../App.css";
import "./review.css";
import "katex/dist/katex.min.css";

// Only rich faces and the canonical scheduler live here. Navigation, queue and
// rating controls belong to SwiftUI. All persistence uses the ordinary bridge.
const root = createRoot(document.getElementById("root")!);
let shownAt = Date.now();
const api = {
  show(card: StoredCard, revealed: boolean) {
    if (!revealed) shownAt = Date.now();
    root.render(<main key={`${card.id}:${card.reps}`} className="review-scroll-container p-8"><CardFace kind={card.kind} front={card.front} back={card.back} revealed={revealed} /></main>);
  },
  async rate(card: StoredCard, rating: Grade) {
    const result = scheduleReview(await getScheduler(), card, rating, Date.now(), Date.now() - shownAt);
    return result;
  },
};
Object.assign(window, { memnoterReview: api });
// Use the same event envelope as the editor host.
(window as unknown as { webkit: { messageHandlers: { memnoter: { postMessage: (body: unknown) => void } } } }).webkit.messageHandlers.memnoter.postMessage({ kind: "event", event: "ready", payload: { protocolVersion: 1 } });
