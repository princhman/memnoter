import { createRoot } from "react-dom/client";
import { CardFace } from "../components/card-face";
import { getScheduler, scheduleReview, previewDue, formatInterval, type StoredCard, type Grade } from "../lib/fsrs";
import { postNativeEvent } from "../lib/backend";
import { BRIDGE_VERSION, type ReviewApi } from "./protocol";
import "../App.css";
import "./review.css";
import "./theme";
import "katex/dist/katex.min.css";

// Only rich faces and the canonical scheduler live here. Navigation, queue and
// rating controls belong to SwiftUI. All persistence uses the ordinary bridge.
const root = createRoot(document.getElementById("root")!);
let shownAt = Date.now();
const api: ReviewApi = {
  show(card: StoredCard, revealed: boolean) {
    if (!revealed) shownAt = Date.now();
    root.render(<main key={`${card.id}:${card.reps}`} className="review-scroll-container p-8"><CardFace kind={card.kind} front={card.front} back={card.back} revealed={revealed} /></main>);
  },
  async preview(card: StoredCard) {
    const now = Date.now();
    const due = previewDue(await getScheduler(), card, now);
    return [1, 2, 3, 4].map(grade => formatInterval(due[grade as Grade] - now));
  },
  async rate(card: StoredCard, rating: Grade) {
    const result = scheduleReview(await getScheduler(), card, rating, Date.now(), Date.now() - shownAt);
    return result;
  },
};
window.memnoterReview = api;
postNativeEvent("ready", { protocolVersion: BRIDGE_VERSION });
