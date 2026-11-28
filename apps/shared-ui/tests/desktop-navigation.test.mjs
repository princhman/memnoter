import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import * as Y from "yjs";
import { browserHarness, installTestBridge } from "./support/browser.mjs";

const { createServer, webkit } = browserHarness(import.meta.url);

test("desktop toolbar spacing and Settings back navigation respect the platform and history", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const origin = `http://localhost:${server.httpServer.address().port}`;
    const newPage = async options => {
      const page = await browser.newPage(options);
      await page.route("https://api.github.com/repos/princhman/memnoter/releases/latest",
        route => route.fulfill({ status: 404, json: {} }));
      return page;
    };
    for (const platform of ["Win32", "Linux x86_64", "MacIntel"]) {
      for (const fullscreen of [false, true]) {
        const page = await newPage({ viewport: { width: 1000, height: 700 } });
        const setup = ({ platform, fullscreen }) => {
          Object.defineProperty(navigator, "platform", { value: platform });
          Object.defineProperty(navigator, "maxTouchPoints", { value: 0 });
          Object.defineProperty(navigator, "userAgent", { value: platform });
          window.installTestBridge({ tauri: { invoke: async (command, args) => {
            if (command === "plugin:window|is_fullscreen") return fullscreen;
            if (command.startsWith("plugin:")) return 1;
            if (command === "modules") return [{ id: "m1", name: "Algebra", heading_numbering: false }];
            if (command === "get_content") return { state: [], updates: [], files: [] };
            if (command === "add_update") return { id: 1, bytes: args.bytes };
            if (command === "spelling_languages") return { available: ["en-GB", "en-US"], selected: null };
            return [];
          } } });
        };
        await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup.toString()})(${JSON.stringify({ platform, fullscreen })});`);
        await page.goto(`${origin}/m1`);
        await page.locator(".tiptap[contenteditable=true]").waitFor();
        const toggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
        const expectedLeft = platform === "MacIntel" && !fullscreen ? 80 : 8;
        for (const collapsed of [false, true]) {
          if (collapsed) await toggle.click();
          await page.waitForFunction(expected => {
            const toggle = document.querySelector('button[aria-label="Toggle sidebar"]');
            return toggle?.getBoundingClientRect().x === expected;
          }, expectedLeft);
          assert.equal((await toggle.boundingBox()).x, expectedLeft, `${platform}, fullscreen=${fullscreen}, collapsed=${collapsed}`);
        }
        await toggle.click();
        await page.getByRole("link", { name: "Settings", exact: true }).click();
        await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.waitForURL(`${origin}/m1`);
        await page.locator(".tiptap[contenteditable=true]").waitFor();
        await page.close();
      }
    }
    // A direct launch has no previous app route, so Back goes home.
    const direct = await newPage();
    await direct.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; window.installTestBridge({ tauri: { invoke: async () => [] } });`);
    await direct.goto(`${origin}/settings`);
    await direct.getByRole("button", { name: "Back", exact: true }).click();
    await direct.waitForURL(`${origin}/`);
    await direct.close();
  } finally {
    await browser?.close();
    await server.close();
  }
});


test("long breadcrumbs remain within the desktop header", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Computer Architecture and Concurrency ".repeat(12), heading_numbering: false }];
        if (command === "get_content") return { state: [], updates: [], files: [] };
        if (command === "add_update") return { id: 1, bytes: args.bytes };
        return [];
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/m1`);
    await page.locator(".tiptap[contenteditable=true]").waitFor();
    for (const width of [1280, 800, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      for (let i = 0; i < 2; i++) {
        await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
        await page.waitForTimeout(400);
        const box = await page.evaluate(() => {
          const h = document.querySelector("header").getBoundingClientRect();
          const c = document.querySelector('[data-slot="breadcrumb-list"]').getBoundingClientRect();
          return { top: c.top, bottom: c.bottom, ht: h.top, hb: h.bottom, height: h.height };
        });
        await page.waitForFunction(() => {
          const label = document.querySelector('[aria-label="Select notes module"] span[title]');
          const node = label?.lastChild;
          const shown = node?.textContent ?? "";
          const range = document.createRange();
          if (node) range.selectNodeContents(node);
          const used = range.getBoundingClientRect().width;
          // Both ends stay, and the cut fills the width, including after it grows back.
          return shown.includes("…") && shown.startsWith("Comp") && shown.endsWith("rency ")
            && used <= label.clientWidth + 0.5 && label.clientWidth - used < 30;
        });
        assert.equal(box.height, 32);
        assert.ok(box.top >= box.ht && box.bottom <= box.hb, JSON.stringify(box));
      }
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("the desktop header hides Review while a worksheet is open and restores it on exit", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      localStorage.setItem("app-state", JSON.stringify({ modulePageByModule: { m1: "questions" } }));
      window.installTestBridge({ tauri: { invoke: async command => {
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Algebra" }];
        if (command === "question_bank_enabled") return true;
        if (command === "question_bank_get") return {
          questions: { q: { title: "Linear equations", order: 0, revisionId: "r" } },
          revisions: { r: { questionId: "q", rootPartId: "p", parts: { p: { label: "", cropIds: [] } } } },
          attempts: { a: { title: "Algebra practice", questions: [{ questionId: "q", revisionId: "r" }] } },
          answers: {}, crops: {},
        };
        if (command === "worksheet_answer_document_load") return { document: [0, 0], expected: "empty", plainText: null };
        if (command === "get_content") return { state: [], updates: [], files: [] };
        return [];
      } } });
    });
    await page.goto(`http://localhost:${server.httpServer.address().port}/m1`);
    const header = page.locator("header");
    const review = header.locator('a[href^="/review"]');
    await review.waitFor();
    await page.getByRole("button", { name: /Algebra practice/ }).click();
    await header.getByRole("button", { name: "Finish", exact: true }).waitFor();
    const scroller = header.getByRole("navigation", { name: "Worksheet questions" });
    const question = scroller.getByRole("button", { name: "Question 1: Linear equations", exact: true });
    assert.equal(await question.innerText(), "1");
    await review.waitFor({ state: "hidden" });
    await header.getByRole("button", { name: "Back to questions" }).click();
    await review.waitFor();
  } finally {
    await server.close();
  }
});

test("a focused heading renders inline math in the desktop breadcrumb", async () => {
  const doc = new Y.Doc();
  const heading = new Y.XmlElement("heading");
  heading.setAttribute("level", 1);
  heading.setAttribute("id", "ratios");
  heading.setAttribute("data-toc-id", "ratios");
  const formula = new Y.XmlElement("inlineMath");
  const tex = new Y.XmlText();
  tex.insert(0, String.raw`\frac{a}{b}`);
  formula.insert(0, [tex]);
  const prefix = new Y.XmlText();
  prefix.insert(0, "Ratios ");
  heading.insert(0, [prefix, formula]);
  doc.getXmlFragment("default").insert(0, [heading, new Y.XmlElement("paragraph")]);
  const state = Array.from(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  try {
    await server.listen();
    const browser = await webkit.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
    page.setDefaultTimeout(8000);
    await page.addInitScript(state => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return 1;
        if (command === "modules") return [{ id: "m1", name: "Algebra" }];
        if (command === "get_content") return { state, updates: [], files: [] };
        if (command === "add_update") return { id: 1, bytes: args.bytes };
        return [];
      } } });
    }, state);
    await page.goto(`http://localhost:${server.httpServer.address().port}/m1`);
    await page.locator(".tiptap > h1").hover();
    await page.getByRole("toolbar", { name: "Heading controls" }).getByRole("button", { name: "Focus on this section" }).click();
    await page.locator(".tiptap > h1.section-focus-start").waitFor();
    const breadcrumb = page.locator("header [data-slot=breadcrumb-page]").filter({ hasText: "Ratios" });
    await breadcrumb.waitFor();
    await breadcrumb.locator(".katex .mfrac").waitFor();
  } finally {
    await server.close();
  }
});

test("the Notes breadcrumb returns from section focus to the whole note", async () => {
  const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
  let browser;
  try {
    await server.listen();
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
    page.setDefaultTimeout(6000);
    await page.route("https://api.github.com/repos/princhman/memnoter/releases/latest",
      route => route.fulfill({ status: 404, json: {} }));

    const chapters = [
      ["Introduction", "An algorithm is a sequence of steps for solving a problem."],
      ["Searching", "Binary search narrows a sorted range by comparing its middle element with the target."],
      ["Sorting", "Merge sort combines sorted runs into increasingly larger sorted runs."],
    ];
    const doc = new Y.Doc();
    doc.getXmlFragment("default").insert(0, chapters.flatMap(([title, body]) => {
      const heading = new Y.XmlElement("heading");
      heading.setAttribute("level", 1);
      heading.insert(0, [new Y.XmlText(title)]);
      const paragraph = new Y.XmlElement("paragraph");
      paragraph.insert(0, [new Y.XmlText(body)]);
      return [heading, paragraph];
    }));
    const state = Array.from(Y.encodeStateAsUpdate(doc));
    doc.destroy();

    const setup = state => {
      Object.defineProperty(navigator, "platform", { value: "MacIntel" });
      window.installTestBridge({ tauri: { invoke: async (command, args) => {
        if (command.startsWith("plugin:")) return null;
        if (command === "modules") return [{ id: "m1", name: "Algorithms", heading_numbering: false }];
        if (command === "get_content") return { state, updates: [], files: [] };
        if (command === "add_update") return { id: 1, bytes: args.bytes };
        if (command === "question_bank_enabled") return true;
        if (command === "question_bank_get") return null;
        return [];
      } } });
    };
    const origin = `http://localhost:${server.httpServer.address().port}`;
    await page.addInitScript(`window.installTestBridge = ${installTestBridge.toString()}; (${setup.toString()})(${JSON.stringify(state)});`);
    await page.goto(`${origin}/m1`);

    const trigger = page.getByRole("button", { name: "Select module section" });
    const menu = page.getByRole("menu");
    const menuRows = menu.locator('[role="menuitem"], [role="menuitemradio"], [role="separator"]');
    const sectionLabels = ["Notes", "Files", "Questions", "Review"];
    const wholeNote = menu.getByRole("menuitem", { name: "Whole Note", exact: true });
    const headings = page.locator(".tiptap > h1:visible");
    await headings.getByText("Searching", { exact: true }).waitFor();
    await trigger.click();
    await menu.getByRole("menuitemradio", { name: "Questions", exact: true }).waitFor();
    assert.deepEqual(await menuRows.allTextContents(), sectionLabels);
    await page.keyboard.press("Escape");

    for (const keyboard of [false, true]) {
      await headings.filter({ hasText: "Searching" }).hover();
      await page.getByRole("toolbar", { name: "Heading controls" })
        .getByRole("button", { name: "Focus on this section", exact: true }).click();
      await page.getByRole("navigation", { name: "breadcrumb" }).getByText("Searching", { exact: true }).waitFor();
      assert.deepEqual(await headings.allTextContents(), ["Searching"]);
      const headingTop = (await headings.first().boundingBox()).y;

      if (keyboard) await trigger.press("ArrowDown");
      else await trigger.click();
      await wholeNote.waitFor();
      assert.deepEqual(await menuRows.allTextContents(), [...sectionLabels, "", "Whole Note"]);
      assert.equal(await menuRows.nth(sectionLabels.length).getAttribute("role"), "separator");
      if (keyboard) {
        for (const label of sectionLabels) {
          const item = menu.getByRole("menuitemradio", { name: label, exact: true });
          assert.equal(await item.evaluate(node => node === document.activeElement), true, `focuses ${label}`);
          await page.keyboard.press("ArrowDown");
        }
        assert.equal(await wholeNote.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press("Enter");
      } else {
        await wholeNote.click();
      }

      await headings.filter({ hasText: "Introduction" }).waitFor();
      assert.deepEqual(await headings.allTextContents(), chapters.map(([title]) => title));
      const restoredTop = (await headings.filter({ hasText: "Searching" }).boundingBox()).y;
      assert.ok(Math.abs(restoredTop - headingTop) <= 1, "keeps the focused chapter at its reading position");
    }

    for (const [label, destination] of [
      ["Files", `${origin}/files?module=m1`],
      ["Questions", `${origin}/m1`],
      ["Review", `${origin}/review?module=m1`],
    ]) {
      await trigger.click();
      assert.equal(await wholeNote.count(), 0);
      await menu.getByRole("menuitemradio", { name: label, exact: true }).click();
      await page.waitForURL(destination);
      await trigger.getByText(label, { exact: true }).waitFor();
      await trigger.click();
      await menu.getByRole("menuitemradio", { name: "Notes", exact: true }).click();
      await trigger.getByText("Notes", { exact: true }).waitFor();
    }
  } finally {
    await browser?.close();
    await server.close();
  }
});
