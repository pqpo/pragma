import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import electronPath from "electron";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pragma-mission-rename-ui-"));
try {
  await build({
    absWorkingDir: desktopRoot,
    stdin: {
      contents:
        'import { runMissionRenameUiTests, prepareMissionRenameVisual } from "./scripts/fixtures/mission-rename-ui.tsx"; window.runMissionRenameUiTests = runMissionRenameUiTests; window.prepareMissionRenameVisual = prepareMissionRenameVisual;',
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
      try {
        await win.loadFile(${JSON.stringify(join(temporaryRoot, "index.html"))});
        const result = await win.webContents.executeJavaScript('window.runMissionRenameUiTests()');
        const frame = () => win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        // Exercise genuine Chromium keyboard modality before capturing the focus ring.
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
        await frame();
        win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('DOM.enable');
        await win.webContents.debugger.sendCommand('CSS.enable');
        const { root } = await win.webContents.debugger.sendCommand('DOM.getDocument');
        const { nodeId } = await win.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '.mission-rename-input' });
        for (const [language, width, height, zoom] of [
          ['zh-Hans', 1440, 900, 1], ['en', 1080, 700, 1.25], ['zh-Hant', 1080, 700, 1.5],
        ]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await win.webContents.executeJavaScript('window.prepareMissionRenameVisual(' + JSON.stringify(language) + ')');
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['focus', 'focus-visible'] });
          await frame();
          await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 180))');
          const shadow = await win.webContents.executeJavaScript('getComputedStyle(document.querySelector(".mission-rename-input")).boxShadow');
          if (shadow === 'none') throw new Error('Keyboard focus ring is missing');
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-focused.png' , (await win.webContents.capturePage()).toPNG());
          await win.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
          await win.webContents.executeJavaScript('document.activeElement.blur()');
          await frame();
          await fs.writeFile(${JSON.stringify(temporaryRoot)} + '/' + language + '-normal.png', (await win.webContents.capturePage()).toPNG());
          await win.webContents.executeJavaScript('document.querySelector(".mission-rename-input").focus()');
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
      reject(new Error("Mission rename UI tests timed out"));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveResult();
      else reject(new Error(`Mission rename UI tests exited ${code}`));
    });
  });
  console.log(`Visual checks: ${temporaryRoot}`);
} catch (error) {
  await rm(temporaryRoot, { recursive: true, force: true });
  throw error;
}
