(() => {
  "use strict";

  const SERVICE_UUID = "7c7e0001-5e4d-4f8a-9b01-123456789001";
  const CHARACTERISTIC_UUID = "7c7e0002-5e4d-4f8a-9b01-123456789001";
  const BLE_CHUNK_SIZE = 20;
  const BLE_CHUNK_DELAY_MS = 60;

  const $ = id => document.getElementById(id);
  let device = null;
  let characteristic = null;
  let connected = false;
  let sending = false;

  // Tastenliste für die Tastenkombination (identisch zur GitHub-Pages-Version)
  const keyList = [
    "A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z",
    "0","1","2","3","4","5","6","7","8","9","ENTER","TAB","SPACE","BACK","ESC","LEFT","RIGHT","UP","DOWN",
    "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12"
  ];

  const statusEl = $("status");
  const connectBtn = $("connectBtn");
  const disconnectBtn = $("disconnectBtn");
  const sendBtn = $("sendBtn");
  const scriptEl = $("script");
  const messageEl = $("message");

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function setConnected(value) {
    connected = value;
    connectBtn.disabled = value;
    disconnectBtn.disabled = !value;
    sendBtn.disabled = !value || sending;
  }

  function showMessage(text, type = "") {
    messageEl.textContent = text;
    messageEl.className = `message ${type}`.trim();
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function insertAtCursor(text) {
    const currentText = scriptEl.value;
    const start = scriptEl.selectionStart;
    const end = scriptEl.selectionEnd;
    const before = currentText.substring(0, start);
    const after = currentText.substring(end);
    let insertion = text;

    if (before.length > 0 && !before.endsWith("\n")) insertion = "\n" + insertion;
    if (after.length > 0 && !after.startsWith("\n")) insertion += "\n";

    scriptEl.value = before + insertion + after;
    const cursor = before.length + insertion.length;
    scriptEl.focus();
    scriptEl.setSelectionRange(cursor, cursor);
  }

  function openDialog(id) {
    const dialog = $(id);
    if (dialog.showModal) dialog.showModal();
    else showMessage("Bitte einen aktuellen Browser verwenden.", "error");
  }

  /* ---------------- Verbindung ---------------- */

  async function connect() {
    if (!navigator.bluetooth) {
      setStatus("Web Bluetooth nicht verfügbar");
      showMessage("Bitte öffne die GitHub-Pages-Seite über HTTPS in Chrome auf Android oder Desktop-Chrome.", "error");
      return;
    }

    try {
      connectBtn.disabled = true;
      setStatus("ESP32 wird gesucht...");
      showMessage("Wähle im Bluetooth-Dialog deinen ESP32 aus.");
      // Filter über die Service-UUID: zeigt nur ESP32-Geräte mit diesem Sketch,
      // egal wie der Bluetooth-Name (BLE_DEVICE_NAME) lautet.
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID]
      });
      device.addEventListener("gattserverdisconnected", onDisconnected);
      setStatus("ESP32 gefunden – verbinde...");
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      setConnected(true);
      setStatus("ESP32 bereit: " + (device.name || "Bluetooth-Gerät"));
      showMessage("Bluetooth-Verbindung hergestellt.", "success");
    } catch (error) {
      characteristic = null;
      if (device?.gatt?.connected) device.gatt.disconnect();
      setConnected(false);
      if (error?.name === "NotFoundError") {
        setStatus("ESP32 wird gesucht...");
        showMessage("Kein Gerät ausgewählt.");
      } else {
        setStatus("Verbindung fehlgeschlagen");
        showMessage("Bluetooth-Verbindung fehlgeschlagen: " + (error?.message || error), "error");
      }
    }
  }

  function onDisconnected() {
    characteristic = null;
    setConnected(false);
    setStatus("ESP32 getrennt – erneut verbinden");
    showMessage("Bluetooth-Verbindung getrennt.", "error");
  }

  function disconnect() {
    if (characteristic) sendMouse("MOUSE RESET");
    if (device?.gatt?.connected) device.gatt.disconnect();
    characteristic = null;
    setConnected(false);
    setStatus("ESP32 getrennt");
    showMessage("Verbindung getrennt.");
  }

  /* ---------------- Senden ---------------- */

  async function writePayload(payload) {
    if (!characteristic) throw new Error("Keine Bluetooth-Verbindung.");
    const bytes = new TextEncoder().encode(payload);
    for (let offset = 0; offset < bytes.length; offset += BLE_CHUNK_SIZE) {
      if (!characteristic) throw new Error("Bluetooth-Verbindung wurde getrennt.");
      const chunk = bytes.slice(offset, Math.min(offset + BLE_CHUNK_SIZE, bytes.length));
      if (typeof characteristic.writeValueWithoutResponse === "function") {
        await characteristic.writeValueWithoutResponse(chunk);
      } else {
        await characteristic.writeValue(chunk);
      }
      if (offset + BLE_CHUNK_SIZE < bytes.length) await sleep(BLE_CHUNK_DELAY_MS);
    }
  }

  function normalizeScript(raw) {
    return raw.replace(/\r/g, "").split("\n").map(l => l.trim()).filter(Boolean);
  }

  async function sendScript() {
    if (!connected || !characteristic || sending) return;
    const commands = normalizeScript(scriptEl.value);
    if (!commands.length) {
      showMessage("Bitte zuerst ein Script eingeben.", "error");
      return;
    }

    sending = true;
    sendBtn.disabled = true;
    $("progressWrap").hidden = false;
    $("progressBar").style.width = "0%";
    setStatus("Script wird gesendet...");
    showMessage("");

    try {
      for (let i = 0; i < commands.length; i++) {
        $("progressText").textContent = `Befehl ${i + 1} von ${commands.length}: ${commands[i]}`;
        await writePayload(commands[i] + "\n");
        $("progressBar").style.width = `${Math.round(((i + 1) / commands.length) * 100)}%`;
        await sleep(BLE_CHUNK_DELAY_MS);
      }
      setStatus("ESP32 bereit");
      showMessage("Script wurde an den ESP32 gesendet.", "success");
      $("progressText").textContent = "Übertragung abgeschlossen.";
    } catch (error) {
      setStatus("Fehler beim Senden");
      showMessage("Fehler beim Senden: " + (error?.message || error), "error");
      if (device?.gatt && !device.gatt.connected) onDisconnected();
    } finally {
      sending = false;
      sendBtn.disabled = !connected;
    }
  }

  /* ---------------- Touchpad / Maus ---------------- */

  let mouseQueue = Promise.resolve();
  function sendMouse(command) {
    if (!characteristic) return;
    mouseQueue = mouseQueue.then(() => writePayload(command + "\n")).catch(error => {
      showMessage("Maus-Befehl fehlgeschlagen: " + (error?.message || error), "error");
    });
  }

  const touchpad = $("touchpad");
  let pointerActive = false;
  let lastX = 0, lastY = 0;
  let moveDX = 0, moveDY = 0, moveTimer = null;

  function flushMouseMove() {
    moveTimer = null;
    if (!characteristic || (!moveDX && !moveDY)) { moveDX = 0; moveDY = 0; return; }
    const dx = Math.max(-127, Math.min(127, Math.round(moveDX)));
    const dy = Math.max(-127, Math.min(127, Math.round(moveDY)));
    moveDX -= dx; moveDY -= dy;
    sendMouse(`MOUSE MOVE ${dx} ${dy}`);
    if (moveDX || moveDY) moveTimer = setTimeout(flushMouseMove, 65);
  }
  function queueMouseDelta(dx, dy) {
    moveDX += dx * 1.35;
    moveDY += dy * 1.35;
    if (!moveTimer) moveTimer = setTimeout(flushMouseMove, 18);
  }
  touchpad.addEventListener("pointerdown", event => {
    if (!characteristic) { showMessage("Verbinde zuerst den ESP32, um das Touchpad zu verwenden.", "error"); return; }
    pointerActive = true; lastX = event.clientX; lastY = event.clientY;
    try { touchpad.setPointerCapture(event.pointerId); } catch (_) {}
    touchpad.classList.add("touching");
    event.preventDefault();
  });
  touchpad.addEventListener("pointermove", event => {
    if (!pointerActive) return;
    const dx = event.clientX - lastX, dy = event.clientY - lastY;
    lastX = event.clientX; lastY = event.clientY;
    if (event.pointerType === "touch" && event.isPrimary === false) return;
    queueMouseDelta(dx, dy);
    event.preventDefault();
  });
  function endPointer(event) {
    pointerActive = false; touchpad.classList.remove("touching");
    if (moveTimer) { clearTimeout(moveTimer); moveTimer = null; }
    flushMouseMove();
    try { if (touchpad.hasPointerCapture(event.pointerId)) touchpad.releasePointerCapture(event.pointerId); } catch (_) {}
  }
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(type => touchpad.addEventListener(type, endPointer));
  touchpad.addEventListener("wheel", event => {
    if (!characteristic) return;
    const amount = Math.max(-127, Math.min(127, Math.round(event.deltaY / 12)));
    if (amount) sendMouse("MOUSE SCROLL " + amount);
    event.preventDefault();
  }, { passive: false });

  $("leftClick").addEventListener("click", () => sendMouse("MOUSE CLICK LEFT"));
  $("middleClick").addEventListener("click", () => sendMouse("MOUSE CLICK MIDDLE"));
  $("rightClick").addEventListener("click", () => sendMouse("MOUSE CLICK RIGHT"));

  /* ---------------- Buttons / Dialoge ---------------- */

  $("enterBtn").addEventListener("click", () => insertAtCursor("DOWN ENTER\nUP ENTER"));
  $("delayBtn").addEventListener("click", () => openDialog("delayDialog"));
  $("textBtn").addEventListener("click", () => openDialog("textDialog"));
  $("comboBtn").addEventListener("click", () => {
    updatePreview();
    openDialog("comboDialog");
  });
  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);
  sendBtn.addEventListener("click", sendScript);

  $("insertTextBtn").addEventListener("click", () => {
    const value = $("textValue").value.replace(/\r/g, "");
    if (!value) return;
    // Mehrzeiliger Text: je Zeile ein TEXT-Befehl, dazwischen ENTER
    const lines = value.split("\n");
    const commands = [];
    lines.forEach((line, index) => {
      if (line.length) commands.push("TEXT " + line);
      if (index < lines.length - 1) commands.push("DOWN ENTER\nUP ENTER");
    });
    insertAtCursor(commands.join("\n"));
    $("textDialog").close();
    $("textValue").value = "";
  });

  $("insertDelayBtn").addEventListener("click", () => {
    const value = Number($("delayValue").value);
    if (!Number.isInteger(value) || value <= 0) {
      $("delayValue").reportValidity();
      return;
    }
    insertAtCursor("DELAY " + value);
    $("delayDialog").close();
  });

  document.querySelectorAll("[data-close]").forEach(button => {
    button.addEventListener("click", () => $(button.dataset.close).close());
  });

  /* ---------------- Tastenkombination (Tasten wie GitHub Pages) ---------------- */

  const selectedKey = $("selectedKey");
  keyList.forEach(key => {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = key;
    selectedKey.appendChild(option);
  });
  selectedKey.value = "A";

  function getModifiers() {
    const modifiers = [];
    if ($("modCtrl").checked) modifiers.push("CTRL");
    if ($("modAlt").checked) modifiers.push("ALT");
    if ($("modShift").checked) modifiers.push("SHIFT");
    if ($("modWin").checked) modifiers.push("WIN");
    return modifiers;
  }

  function updatePreview() {
    const modifiers = getModifiers();
    const key = selectedKey.value || "A";
    $("comboPreview").textContent = "Kombination: " + (modifiers.length ? [...modifiers, key].join("+") : key);
  }

  ["modCtrl", "modAlt", "modShift", "modWin", "selectedKey"].forEach(id => {
    $(id).addEventListener("change", updatePreview);
  });

  $("insertComboBtn").addEventListener("click", () => {
    const modifiers = getModifiers();
    const key = selectedKey.value;
    const lines = [];
    modifiers.forEach(modifier => lines.push("DOWN " + modifier));
    lines.push("DOWN " + key, "UP " + key);
    modifiers.slice().reverse().forEach(modifier => lines.push("UP " + modifier));
    insertAtCursor(lines.join("\n"));
    $("comboDialog").close();
  });

  window.addEventListener("beforeunload", () => {
    if (device?.gatt?.connected) device.gatt.disconnect();
  });

  setConnected(false);
  setStatus("ESP32 wird gesucht...");
})();
