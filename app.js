(() => {
  "use strict";

  const SERVICE_UUID = "7c7e0001-5e4d-4f8a-9b01-123456789001";
  const CHARACTERISTIC_UUID = "7c7e0002-5e4d-4f8a-9b01-123456789001";
  const CHUNK_SIZE = 20;
  const CHUNK_DELAY_MS = 60;

  const $ = (id) => document.getElementById(id);
  const scriptEl = $("script");
  const status = $("status");
  const statusText = $("statusText");
  const connectBtn = $("connectBtn");
  const disconnectBtn = $("disconnectBtn");
  const runBtn = $("runBtn");
  const message = $("message");
  const progressWrap = $("progressWrap");
  const progressBar = $("progressBar");
  const progressText = $("progressText");

  let device = null;
  let server = null;
  let characteristic = null;
  let running = false;

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  function setStatus(connected, text) {
    status.classList.toggle("connected", connected);
    status.classList.toggle("disconnected", !connected);
    statusText.textContent = text;
    connectBtn.disabled = connected;
    disconnectBtn.disabled = !connected;
    runBtn.disabled = !connected || running;
  }

  function showMessage(text, type = "") {
    message.textContent = text;
    message.className = `message ${type}`.trim();
  }

  function updateLineCount() {
    const n = scriptEl.value.length ? scriptEl.value.split(/\r?\n/).length : 0;
    $("lineCount").textContent = `${n} ${n === 1 ? "Zeile" : "Zeilen"}`;
  }

  function insertAtCursor(text) {
    const start = scriptEl.selectionStart;
    const end = scriptEl.selectionEnd;
    const current = scriptEl.value;
    const prefix = current && start > 0 && current[start - 1] !== "\n" ? "\n" : "";
    const suffix = current && end < current.length && current[end] !== "\n" ? "\n" : "";
    const insertion = prefix + text + suffix;
    scriptEl.value = current.slice(0, start) + insertion + current.slice(end);
    const cursor = start + insertion.length;
    scriptEl.focus();
    scriptEl.setSelectionRange(cursor, cursor);
    updateLineCount();
  }

  function openDialog(id) {
    const dialog = $(id);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else alert("Bitte einen aktuellen Browser verwenden.");
  }

  async function connect() {
    if (!("bluetooth" in navigator)) {
      showMessage("Dieser Browser unterstützt Web Bluetooth nicht. Verwende Chrome auf Android oder Desktop-Chrome über HTTPS.", "error");
      return;
    }
    try {
      connectBtn.disabled = true;
      showMessage("Bluetooth-Gerät auswählen …");
      device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SERVICE_UUID]
      });
      device.addEventListener("gattserverdisconnected", onDisconnected);
      showMessage("Verbinde mit " + (device.name || "Bluetooth-Gerät") + " …");
      server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      setStatus(true, "Verbunden: " + (device.name || "Bluetooth-Gerät"));
      showMessage("Verbunden mit " + (device.name || "Bluetooth-Gerät") + ".", "success");
    } catch (error) {
      characteristic = null;
      if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
      setStatus(false, "Nicht verbunden");
      if (error && error.name === "NotFoundError") {
        showMessage("Kein Gerät ausgewählt.", "");
      } else {
        showMessage("Verbindung fehlgeschlagen: " + (error?.message || error), "error");
      }
    } finally {
      if (!characteristic) connectBtn.disabled = false;
    }
  }

  function onDisconnected() {
    characteristic = null;
    server = null;
    setStatus(false, "Nicht verbunden");
    showMessage("Bluetooth-Verbindung getrennt.", "error");
  }

  function disconnect() {
    if (characteristic) sendMouse("MOUSE RESET");
    if (device?.gatt?.connected) device.gatt.disconnect();
    characteristic = null;
    server = null;
    setStatus(false, "Nicht verbunden");
    showMessage("Verbindung getrennt.");
  }

  async function writePayload(payload) {
    if (!characteristic) throw new Error("Keine Bluetooth-Verbindung.");
    const bytes = new TextEncoder().encode(payload);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      if (!characteristic) throw new Error("Bluetooth-Verbindung wurde getrennt.");
      const chunk = bytes.slice(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
      if (typeof characteristic.writeValueWithoutResponse === "function") {
        await characteristic.writeValueWithoutResponse(chunk);
      } else {
        await characteristic.writeValue(chunk);
      }
      if (offset + CHUNK_SIZE < bytes.length) await sleep(CHUNK_DELAY_MS);
    }
  }

  function normalizeScript(raw) {
    // TEXT commands are line-based in the ESP32 firmware. Convert editor text to
    // UTF-8 command lines and preserve an explicit newline as an ENTER key pair.
    const sourceLines = raw.replace(/\r/g, "").split("\n");
    const commands = [];
    for (const sourceLine of sourceLines) {
      const line = sourceLine.trim();
      if (!line) continue;
      if (/^TEXT\s/i.test(line) && line.slice(5).includes("\n")) {
        // Kept for clarity; split() already separates lines before this point.
        commands.push(line);
      } else {
        commands.push(line);
      }
    }
    return commands;
  }

  async function runScript() {
    if (!characteristic || running) return;
    const commands = normalizeScript(scriptEl.value);
    if (!commands.length) {
      showMessage("Der Skript-Editor ist leer.", "error");
      return;
    }
    running = true;
    runBtn.disabled = true;
    progressWrap.hidden = false;
    progressBar.style.width = "0%";
    showMessage("");
    try {
      for (let i = 0; i < commands.length; i++) {
        const command = commands[i];
        progressText.textContent = `Befehl ${i + 1} von ${commands.length}: ${command}`;
        await writePayload(command + "\n");
        progressBar.style.width = `${Math.round(((i + 1) / commands.length) * 100)}%`;
        // Let the ESP32 process each command before sending the next one.
        await sleep(CHUNK_DELAY_MS);
      }
      progressText.textContent = "Alle Befehle gesendet.";
      showMessage(`${commands.length} Befehle gesendet.`, "success");
    } catch (error) {
      showMessage("Senden fehlgeschlagen: " + (error?.message || error), "error");
      if (device?.gatt && !device.gatt.connected) onDisconnected();
    } finally {
      running = false;
      runBtn.disabled = !characteristic;
    }
  }

  async function sendReset() {
    if (!characteristic) {
      showMessage("Verbinde zuerst den ESP32.", "error");
      return;
    }
    try {
      await writePayload("RESET\n");
      showMessage("RESET gesendet: Alle Tasten werden freigegeben.", "success");
    } catch (error) {
      showMessage("RESET konnte nicht gesendet werden: " + (error?.message || error), "error");
    }
  }


  // Mausbefehle werden einzeln und geordnet über dieselbe BLE-Characteristic gesendet.
  let mouseQueue = Promise.resolve();
  function sendMouse(command) {
    if (!characteristic) return;
    mouseQueue = mouseQueue.then(() => writePayload(command + "\n")).catch(error => {
      showMessage("Maus-Befehl fehlgeschlagen: " + (error?.message || error), "error");
    });
  }

  const touchpad = $("touchpad");
  let pointerActive = false;
  let lastX = 0, lastY = 0, lastMoveAt = 0;
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
    // Pointer movement is scaled slightly for a natural mouse feel.
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
  ["pointerup","pointercancel","lostpointercapture"].forEach(type => touchpad.addEventListener(type, endPointer));
  $("leftClick").addEventListener("click", () => sendMouse("MOUSE CLICK LEFT"));
  $("rightClick").addEventListener("click", () => sendMouse("MOUSE CLICK RIGHT"));
  $("middleClick").addEventListener("click", () => sendMouse("MOUSE CLICK MIDDLE"));
  touchpad.addEventListener("wheel", event => {
    if (!characteristic) return;
    const amount = Math.max(-127, Math.min(127, Math.round(event.deltaY / 12)));
    if (amount) sendMouse("MOUSE SCROLL " + amount);
    event.preventDefault();
  }, { passive:false });

  connectBtn.addEventListener("click", connect);
  disconnectBtn.addEventListener("click", disconnect);
  runBtn.addEventListener("click", runScript);
  scriptEl.addEventListener("input", updateLineCount);
  $("clearBtn").addEventListener("click", () => {
    scriptEl.value = "";
    updateLineCount();
    scriptEl.focus();
  });
  $("resetBtn").addEventListener("click", sendReset);

  $("textBtn").addEventListener("click", () => openDialog("textDialog"));
  $("insertTextConfirm").addEventListener("click", (event) => {
    event.preventDefault();
    const value = $("textValue").value.replace(/\r/g, "");
    if (!value) return;
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

  $("enterBtn").addEventListener("click", () => insertAtCursor("DOWN ENTER\nUP ENTER"));
  $("delayBtn").addEventListener("click", () => openDialog("delayDialog"));
  $("insertDelayConfirm").addEventListener("click", (event) => {
    event.preventDefault();
    const value = Number($("delayValue").value);
    if (!Number.isInteger(value) || value < 1 || value > 60000) {
      $("delayValue").reportValidity();
      return;
    }
    insertAtCursor("DELAY " + value);
    $("delayDialog").close();
  });
  $("comboBtn").addEventListener("click", () => openDialog("comboDialog"));
  $("insertComboConfirm").addEventListener("click", (event) => {
    event.preventDefault();
    const modifier = $("modifier").value;
    const key = $("comboKey").value;
    insertAtCursor(`DOWN ${modifier}\nDOWN ${key}\nUP ${key}\nUP ${modifier}`);
    $("comboDialog").close();
  });

  // If the browser tab is closed or the page is hidden, the GATT connection
  // is managed by the browser. There is no background BLE execution guarantee.
  setStatus(false, "Nicht verbunden");
  updateLineCount();
})();
