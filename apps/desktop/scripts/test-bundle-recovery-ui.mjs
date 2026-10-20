import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electronPath from "electron";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-bundle-recovery-ui-"));
try {
  await build({
    absWorkingDir: desktopRoot,
    stdin: {
      contents:
        'import { runBundleRecoveryUiTests, prepareBundleRecoveryVisual, prepareBundleRuntimeVisual, prepareBundleConflictVisual, prepareBundleResumeVisual } from "./scripts/fixtures/bundle-recovery-ui.tsx"; Object.assign(window, { runBundleRecoveryUiTests, prepareBundleRecoveryVisual, prepareBundleRuntimeVisual, prepareBundleConflictVisual, prepareBundleResumeVisual });',
      resolveDir: desktopRoot,
    },
    outfile: join(temporaryRoot, "test.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".jpg": "dataurl", ".png": "dataurl", ".svg": "dataurl", ".ttf": "dataurl" },
    logLevel: "warning",
  });
  await writeFile(
    join(temporaryRoot, "index.html"),
    '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="./test.css"></head><body><div id="root"></div><script src="./test.js"></script></body></html>',
  );
  await writeFile(
    join(temporaryRoot, "main.cjs"),
    `
    const { app, BrowserWindow } = require('electron');
    const fs = require('node:fs/promises');
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ width: 1080, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
      win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
      try {
        await win.loadFile(${JSON.stringify(join(temporaryRoot, "index.html"))});
        const result = await win.webContents.executeJavaScript('window.runBundleRecoveryUiTests()');
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('DOM.enable');
        await win.webContents.debugger.sendCommand('CSS.enable');
        const frame = () => win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        for (const [language, width, height, zoom] of [
          ['zh-Hans', 1440, 900, 1], ['en', 1080, 700, 1.25], ['zh-Hant', 1080, 700, 1.5],
        ]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await win.webContents.executeJavaScript('window.prepareBundleRecoveryVisual(' + JSON.stringify(language) + ')');
          await frame();
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-normal.png', (await win.webContents.capturePage()).toPNG());
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
          await frame();
          const focus = await win.webContents.executeJavaScript('document.activeElement.matches(".pragma-bundle-discard-dialog button")');
          if (!focus) throw new Error('Confirmation keyboard focus is missing: ' + await win.webContents.executeJavaScript('document.activeElement.outerHTML'));
          // Hidden macOS windows do not always set the Chromium focus-visible heuristic.
          // Tab must move real focus first; force only the visual pseudo-state for capture.
          const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
          const dangerFocused = await win.webContents.executeJavaScript('document.activeElement.classList.contains("danger-button")');
          const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: dangerFocused ? '.pragma-bundle-discard-dialog .danger-button' : '.pragma-bundle-discard-dialog [data-dialog-initial-focus]' });
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
          await frame();
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-focused.png', (await win.webContents.capturePage()).toPNG());
        }
        win.setSize(1080, 700);
        win.webContents.setZoomFactor(1);
        await win.webContents.executeJavaScript('window.prepareBundleRuntimeVisual("zh-Hans")');
        await frame();
        await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/runtime-normal.png', (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript('document.querySelector("button[aria-label=模型]").focus()');
        const runtimeDocument = await win.webContents.debugger.sendCommand('DOM.getDocument');
        const runtimeModel = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: runtimeDocument.root.nodeId, selector: '[aria-label="模型"]' });
        await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: runtimeModel.nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
        await frame();
        await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/runtime-focused.png', (await win.webContents.capturePage()).toPNG());
        for (const [language, width, height, zoom] of [
          ['zh-Hans', 1080, 800, 1], ['en', 1080, 800, 1.25], ['zh-Hant', 720, 800, 1],
        ]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          win.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
          await win.webContents.executeJavaScript('window.prepareBundleConflictVisual(' + JSON.stringify(language) + ')');
          await frame();
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-conflicts-normal.png', (await win.webContents.capturePage()).toPNG());
          const conflictDocument = await win.webContents.debugger.sendCommand('DOM.getDocument');
          const conflictChoice = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: conflictDocument.root.nodeId, selector: '.pragma-bundle-conflict-choice button[aria-pressed="true"]' });
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: conflictChoice.nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
          await frame();
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-conflicts-focused.png', (await win.webContents.capturePage()).toPNG());
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId: conflictChoice.nodeId, forcedPseudoClasses: [] });
          const hoverPoint = await win.webContents.executeJavaScript('(() => { const rect = document.querySelector(".pragma-bundle-conflict-choice button").getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()');
          win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(hoverPoint.x * zoom), y: Math.round(hoverPoint.y * zoom) });
          await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 180))');
          const hoverVisible = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector(".pragma-bundle-conflict-choice .studio-action-tooltip")).visibility === "visible"');
          if (!hoverVisible) throw new Error('Conflict tooltip must appear on mouse hover');
          const visibleTips = await win.webContents.executeJavaScript('[...document.querySelectorAll(".pragma-bundle-conflict-choice [role=tooltip]")].filter(node => getComputedStyle(node).visibility === "visible").length');
          if (visibleTips !== 1) throw new Error('Only the hovered conflict tooltip should be visible');
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-conflicts-hover.png', (await win.webContents.capturePage()).toPNG());

        }
        for (const [language, zoom] of [['zh-Hans', 1], ['en', 1.25], ['zh-Hant', 1.5]]) {
          win.setSize(1080, 700);
          win.webContents.setZoomFactor(zoom);
          await win.webContents.executeJavaScript('window.prepareBundleResumeVisual(' + JSON.stringify(language) + ')');
          await frame();
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-resume.png', (await win.webContents.capturePage()).toPNG());
        }
        console.log(JSON.stringify(result));
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });
  `,
  );
  await new Promise((resolveResult, reject) => {
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [join(temporaryRoot, "main.cjs")], {
      env: environment,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Bundle recovery UI tests timed out"));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult();
      else reject(new Error(`Bundle recovery UI tests exited ${code}`));
    });
  });
  console.log(`Visual checks: ${temporaryRoot}`);
} catch (error) {
  await rm(temporaryRoot, { recursive: true, force: true });
  throw error;
}
