(() => {
  "use strict";

  const ESP32_NAME = "ESP32-S3 Keyboard";
  const SERVICE_UUID = "7c7e0001-5e4d-4f8a-9b01-123456789001";
  const CHARACTERISTIC_UUID = "7c7e0002-5e4d-4f8a-9b01-123456789001";
  const BLE_CHUNK_SIZE = 20;
  const BLE_CHUNK_DELAY_MS = 60;

  const $ = id => document.getElementById(id);
  let device = null;
  let characteristic = null;
  let connected = false;
  let sending = false;

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

  async function connect() {
    if (!navigator.bluetooth) {
      setStatus("Web Bluetooth nicht verfügbar");
      showMessage("Bitte öffne die GitHub-Pages-Seite über HTTPS in Chrome auf Android oder Desktop-Chrome.", "error");
      return;
    }

    try {
      connectBtn.disabled = true;
      setStatus("ESP32 wird gesucht...");
      showMessage("Wähle im Bluetooth-Dialog „ESP32-S3 Keyboard“ aus.");
      device = await navigator.bluetooth.requestDevice({
        filters: [{ name: ESP32_NAME }],
        optionalServices: [SERVICE_UUID]
      });
      device.addEventListener("gattserverdisconnected", onDisconnected);
      setStatus("ESP32 gefunden – verbinde...");
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      characteristic = await service.getCharacteristic(CHARACTERISTIC_UUID);
      setConnected(true);
      setStatus("ESP32 bereit");
      showMessage("Bluetooth-Verbindung hergestellt.", "success");
    } catch (error) {
      characteristic = null;
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
    if (device?.gatt?.connected) device.gatt.disconnect();
    characteristic = null;
    setConnected(false);
    setStatus("ESP32 getrennt");
    showMessage("Verbindung getrennt.");
  }

  async function writeChunk(bytes) {
    if (!characteristic) throw new Error("Keine BLE-Verbindung.");
    if (typeof characteristic.writeValueWithoutResponse === "function") {
      await characteristic.writeValueWithoutResponse(bytes);
    } else {
      await characteristic.writeValue(bytes);
    }
  }

  // Match the Android app: append one final newline, encode UTF-8, send 20-byte
  // chunks, and wait 60 ms between chunks. This keeps command lines in the same
  // BLE stream so DELAY commands control timing on the ESP32 itself.
  async function sendScript() {
    if (!connected || !characteristic || sending) return;
    const text = scriptEl.value;
    if (!text.trim()) {
      showMessage("Bitte zuerst ein Script eingeben.", "error");
      return;
    }

    const fullText = text.endsWith("\n") ? text : text + "\n";
    const bytes = new TextEncoder().encode(fullText);
    const totalChunks = Math.ceil(bytes.length / BLE_CHUNK_SIZE);

    sending = true;
    sendBtn.disabled = true;
    $("progressWrap").hidden = false;
    $("progressBar").style.width = "0%";
    setStatus("Script wird gesendet...");
    showMessage("");

    try {
      for (let offset = 0, index = 0; offset < bytes.length; offset += BLE_CHUNK_SIZE, index++) {
        if (!characteristic) throw new Error("Bluetooth-Verbindung wurde getrennt.");
        const chunk = bytes.slice(offset, Math.min(offset + BLE_CHUNK_SIZE, bytes.length));
        await writeChunk(chunk);
        $("progressBar").style.width = `${Math.round(((index + 1) / totalChunks) * 100)}%`;
        $("progressText").textContent = `Paket ${index + 1} von ${totalChunks}`;
        if (offset + BLE_CHUNK_SIZE < bytes.length) await sleep(BLE_CHUNK_DELAY_MS);
      }
      setStatus("ESP32 bereit");
      showMessage("Script wurde an den ESP32 gesendet.", "success");
      $("progressText").textContent = "Übertragung abgeschlossen.";
    } catch (error) {
      setStatus("Fehler beim Senden");
      showMessage("Fehler beim Senden: " + (error?.message || error), "error");
    } finally {
      sending = false;
      sendBtn.disabled = !connected;
    }
  }

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
    const text = $("textValue").value;
    if (text.length > 0) {
      // Mirrors Android app behavior: insert the whole text after the TEXT prefix.
      insertAtCursor("TEXT " + text);
      $("textDialog").close();
    }
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
