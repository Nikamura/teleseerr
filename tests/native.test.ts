import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source =
  readFileSync("web/native.js", "utf8").replace(/export /g, "") +
  "\n({confirmAction,haptic,closingConfirmation,ensureWriteAccess,dismissKeyboard,canAddToHomeScreen})";
function load(webApp: any, confirm: (message: string) => boolean = () => true) {
  return runInNewContext(source, { window: { Telegram: webApp ? { WebApp: webApp } : undefined, confirm }, Promise });
}
const client = (version: number, extra: object = {}) => ({
  initData: "signed",
  isVersionAtLeast: (wanted: string) => version >= Number(wanted),
  ...extra,
});

test("confirmation uses the native popup in Telegram and the browser dialog elsewhere", async () => {
  const popups: any[] = [];
  const asked: string[] = [];
  const browser = (message: string) => { asked.push(message); return true; };
  const native = load(client(6.2, { showPopup: (params: any, done: (id: string) => void) => { popups.push(params); done("ok"); } }), browser);
  assert.equal(await native.confirmAction("Unlink?", { ok: "Unlink", destructive: true }), true);
  assert.equal(popups[0].buttons[0].type, "destructive");
  assert.equal(popups[0].buttons[1].type, "cancel");
  assert.equal(asked.length, 0);
  // Over the popup limit, a throwing client, an old client, the browser-login SDK and no SDK.
  assert.equal(await native.confirmAction("x".repeat(257)), true);
  const throwing = load(client(6.2, { showPopup: () => { throw new Error("WebAppPopupOpened"); } }), browser);
  assert.equal(await throwing.confirmAction("Busy?"), true);
  assert.equal(await load(client(6.1, { showPopup: () => assert.fail() }), browser).confirmAction("Old?"), true);
  assert.equal(await load({ ...client(9), initData: "", showPopup: () => assert.fail() }, browser).confirmAction("Browser?"), true);
  assert.equal(await load(undefined, () => false).confirmAction("None?"), false);
  assert.equal(asked.length, 4);
  const cancelled = load(client(6.2, { showPopup: (_p: any, done: (id: null) => void) => done(null) }));
  assert.equal(await cancelled.confirmAction("Dismissed?"), false);
});

test("optional native calls are version-gated and never throw", async () => {
  const calls: string[] = [];
  const full = client(9.1, {
    initDataUnsafe: { user: {} },
    HapticFeedback: { notificationOccurred: (t: string) => calls.push(t), selectionChanged: () => calls.push("selection") },
    enableClosingConfirmation: () => calls.push("closing-on"),
    disableClosingConfirmation: () => calls.push("closing-off"),
    requestWriteAccess: () => calls.push("write"),
    hideKeyboard: () => calls.push("keyboard"),
    checkHomeScreenStatus: (done: (s: string) => void) => done("missed"),
    addToHomeScreen: () => {},
  });
  const native = load(full);
  native.haptic("success"); native.haptic("selection");
  native.closingConfirmation(true); native.closingConfirmation(false);
  native.ensureWriteAccess(); native.ensureWriteAccess();
  let blurred = false;
  native.dismissKeyboard({ blur: () => { blurred = true; } });
  assert.deepEqual(calls, ["success", "selection", "closing-on", "closing-off", "write", "keyboard"]);
  assert.equal(blurred, true);
  assert.equal(await native.canAddToHomeScreen(), true);

  const old = load({ ...full, isVersionAtLeast: () => false, requestWriteAccess: () => assert.fail(), hideKeyboard: () => assert.fail() });
  old.haptic("error"); old.closingConfirmation(true); old.ensureWriteAccess(); old.dismissKeyboard(null);
  assert.equal(await old.canAddToHomeScreen(), false);
  const allowed = load({ ...full, initDataUnsafe: { user: { allows_write_to_pm: true } }, requestWriteAccess: () => assert.fail() });
  allowed.ensureWriteAccess();
  const none = load(undefined);
  none.haptic("success"); none.closingConfirmation(true); none.ensureWriteAccess(); none.dismissKeyboard(null);
  assert.equal(await none.canAddToHomeScreen(), false);
});
