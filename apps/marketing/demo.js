// Progressive demo on the marketing homepage. Without this file the three
// examples stay visible as static text. With it, one step shows at a time.
(() => {
  const root = document.querySelector("[data-demo]");
  if (!root) return;
  document.documentElement.classList.add("demo-ready");

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const steps = [...root.querySelectorAll("[data-step]")];
  const tabs = [...root.querySelectorAll("[data-demo-tab]")];
  const live = root.querySelector("[data-demo-live]");
  const pauseBtn = root.querySelector("[data-demo-pause]");
  const cloze = root.querySelector("[data-cloze]");
  const showAnswer = root.querySelector("[data-show-answer]");
  const back = root.querySelector("[data-review-back]");
  const grades = root.querySelector("[data-grades]");
  const result = root.querySelector("[data-grade-result]");
  const gradeButtons = [...root.querySelectorAll("[data-grade]")];
  let index = 0;
  let timer = 0;
  let generation = 0;
  let paused = reduce;

  const setCloze = (open) => {
    cloze.setAttribute("aria-pressed", open ? "true" : "false");
    cloze.setAttribute("aria-label", open ? "Hide the word 2x" : "Show the hidden word");
  };

  const resetReview = () => {
    showAnswer.hidden = false;
    back.hidden = true;
    grades.hidden = true;
    result.hidden = true;
    result.textContent = "";
    gradeButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
  };

  const revealReview = () => {
    showAnswer.hidden = true;
    back.hidden = false;
    grades.hidden = false;
  };

  const markPaused = () => {
    paused = true;
    clearTimeout(timer);
    pauseBtn.setAttribute("aria-pressed", "true");
    pauseBtn.textContent = "Play";
  };

  const show = (next) => {
    const ticket = ++generation;
    index = (next + steps.length) % steps.length;
    const step = steps[index];
    steps.forEach((panel) => {
      panel.classList.remove("is-shown");
      panel.hidden = true;
    });
    if (step.id === "panel-cloze") setCloze(reduce);
    if (step.id === "panel-review") resetReview();
    step.hidden = false;
    tabs.forEach((tab, i) => {
      const on = i === index;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    });
    if (live) live.textContent = step.dataset.label || "";
    if (reduce) {
      step.classList.add("is-shown");
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (ticket === generation) step.classList.add("is-shown");
      }));
    }
    if (!reduce && !paused && step.id === "panel-cloze") {
      setTimeout(() => { if (ticket === generation && !paused) setCloze(true); }, 1100);
    }
    if (!reduce && !paused && step.id === "panel-review") {
      setTimeout(() => { if (ticket === generation && !paused) revealReview(); }, 1100);
    }
    clearTimeout(timer);
    if (!paused && !reduce) timer = setTimeout(() => show(index + 1), 7600);
  };

  tabs.forEach((tab, i) => tab.addEventListener("click", () => { markPaused(); show(i); }));
  root.querySelector("[role=tablist]").addEventListener("keydown", (event) => {
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    let next = null;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });

  pauseBtn.addEventListener("click", () => {
    if (paused) {
      paused = false;
      pauseBtn.setAttribute("aria-pressed", "false");
      pauseBtn.textContent = "Pause";
      clearTimeout(timer);
      timer = setTimeout(() => show(index + 1), 7600);
    } else {
      markPaused();
    }
  });

  cloze.addEventListener("click", () => {
    markPaused();
    setCloze(cloze.getAttribute("aria-pressed") !== "true");
  });
  showAnswer.addEventListener("click", () => { markPaused(); revealReview(); });
  gradeButtons.forEach((button) => button.addEventListener("click", () => {
    markPaused();
    revealReview();
    gradeButtons.forEach((other) => other.setAttribute("aria-pressed", other === button ? "true" : "false"));
    result.hidden = false;
    result.textContent = `Graded ${button.dataset.grade}. FSRS-7 picks the next date from this card's history. This page does not run the scheduler.`;
  }));

  document.querySelectorAll(".nav-more a").forEach((link) => {
    link.addEventListener("click", () => { const menu = link.closest("details"); if (menu) menu.open = false; });
  });

  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden && !paused && !reduce) timer = setTimeout(() => show(index + 1), 7600);
  });

  if (reduce) pauseBtn.hidden = true;
  show(0);
})();

// Feature frames step through real screenshots. Reduced motion keeps the first frame.
(() => {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const stage of document.querySelectorAll("[data-sequence]")) {
    const slides = [...stage.querySelectorAll(".stage-slide")];
    if (slides.length < 2) continue;
    let index = Math.max(0, slides.findIndex((slide) => slide.classList.contains("is-on")));
    const show = (next) => {
      slides[index].classList.remove("is-on");
      slides[index].setAttribute("aria-hidden", "true");
      index = next;
      slides[index].classList.add("is-on");
      slides[index].removeAttribute("aria-hidden");
    };
    if (reduce) continue;
    let timer = setInterval(() => show((index + 1) % slides.length), 3400);
    document.addEventListener("visibilitychange", () => {
      clearInterval(timer);
      if (!document.hidden) timer = setInterval(() => show((index + 1) % slides.length), 3400);
    });
  }
})();
