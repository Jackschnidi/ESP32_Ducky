# DuckyKeyboardESP – Tastatur + Touchpad/Maus

Oberfläche und Tastenliste für Tastenkombinationen stammen aus der GitHub-Pages-Version
(CTRL/ALT/SHIFT/WIN als Checkboxen, Tasten A–Z, 0–9, ENTER, TAB, SPACE, BACK, ESC, Pfeile, F1–F12).
Zusätzlich enthalten: Touchpad, Maus-Klicks, Scrollen, mehrzeiliger Text.


## Bluetooth-Name
Im Sketch oben ändern: `#define BLE_DEVICE_NAME "ESP32-S3 Keyboard"`.
Die Webseite filtert nach der Service-UUID und zeigt im Browser-Dialog nur ESP32-Geräte mit diesem Sketch (egal welcher Name); nach dem Verbinden steht der Gerätename im Status.

## GitHub Pages
`index.html`, `style.css`, `app.js` (und README) in den Root-Ordner des Repos hochladen.
Settings → Pages → Deploy from a branch → `main` → `/(root)`. Web Bluetooth braucht HTTPS und Chrome.

## Schweizer Tastatur
Der Sketch sendet Text für ein Windows-System mit Layout „Deutsch (Schweiz)“ (QWERTZ), inkl. ä ö ü é è à ç € § ° @ # \ | ~ ^ ` { } [ ].
Bei DOWN/UP-Befehlen sind Y und Z vertauscht, damit z. B. CTRL+Z auf der Taste „Z“ des Schweizer Layouts landet. Zusätzlich gibt es `ALTGR`.

## Loop (Endlosschleife)
Checkbox „Endlos wiederholen“ aktivieren und Script senden: Der ESP32 speichert die Befehle (max. 500) und wiederholt sie endlos,
auch ohne Bluetooth-Verbindung, bis er ausgesteckt wird. Protokoll: `LOOP START` … Befehle … `LOOP END`.
Mit der Zeile `LOOP STOP` (als Script senden) lässt sich die Schleife anhalten. Tipp: ein `DELAY` im Script setzen, sonst läuft es mit voller Geschwindigkeit.

## Mausklick an Koordinaten
Button „Mausklick“ neben „Tastenkombination“. Im Dialog entweder ins Rechteck (Abbild des Bildschirms) tippen **oder** X/Y eintippen
(beides ist synchron). Die Bildschirmauflösung (Standard 1920×1080) wird im Browser gemerkt. Taste: Links/Rechts/Mitte, optional Doppelklick.
Eingefügt werden z. B. diese Zeilen:

    MOUSE GOTO 960 540 1920 1080
    MOUSE CLICK LEFT

`MOUSE GOTO x y breite hoehe` setzt den Zeiger absolut. Dafür meldet sich der ESP32 am PC zusätzlich als absolutes Zeigergerät an
(Report-ID 10), Sketch also neu flashen. Es zählt der Hauptbildschirm; bei skalierter Anzeige (z. B. 125 %) die skalierte Auflösung eintragen.
