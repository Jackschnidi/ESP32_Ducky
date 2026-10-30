#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDMouse.h"

USBHIDKeyboard Keyboard;
USBHIDMouse Mouse;

// Individueller Bluetooth-Name pro ESP32:
#define BLE_DEVICE_NAME "ESP32-S3 Keyboard"

// Tastaturlayout des Ziel-PCs: Deutsch (Schweiz), QWERTZ


/*
 * ============================================================
 * ESP32-S3 Bluetooth -> USB HID Keyboard
 * ============================================================
 *
 * Android
 *    |
 *    | BLE
 *    v
 * ESP32-S3
 *    |
 *    | USB HID
 *    v
 * Windows-PC
 *
 *
 * BLE-Protokoll:
 *
 *   DOWN CTRL
 *   DOWN C
 *   UP C
 *   UP CTRL
 *
 *   TEXT Hallo Welt
 *
 *   DELAY 500
 *
 *   RESET
 *
 * ============================================================
 */


/* ------------------------------------------------------------
 * BLE UUIDs
 * ------------------------------------------------------------ */

#define SERVICE_UUID \
    "7c7e0001-5e4d-4f8a-9b01-123456789001"

#define CHARACTERISTIC_UUID \
    "7c7e0002-5e4d-4f8a-9b01-123456789001"


BLECharacteristic *keyboardCharacteristic = nullptr;

bool deviceConnected = false;


/* ------------------------------------------------------------
 * Empfangspuffer
 * ------------------------------------------------------------ */

String commandLine;


/* ------------------------------------------------------------
 * Endlosschleife (LOOP)
 *
 *   LOOP START   -> ab jetzt werden Befehle nur aufgezeichnet
 *   ...Befehle...
 *   LOOP END     -> Aufzeichnung beendet, die Befehle laufen
 *                   endlos, auch ohne Bluetooth-Verbindung,
 *                   bis der ESP32 ausgesteckt wird
 *   LOOP STOP    -> Schleife anhalten (optional)
 * ------------------------------------------------------------ */

#include <vector>

std::vector<String> loopCommands;
bool loopRecording = false;
volatile bool loopRunning = false;
volatile uint32_t loopGeneration = 0;
SemaphoreHandle_t loopMutex = nullptr;
const size_t LOOP_MAX_COMMANDS = 500;


/* ------------------------------------------------------------
 * BLE Server Callbacks
 * ------------------------------------------------------------ */

class ServerCallbacks : public BLEServerCallbacks
{
    void onConnect(BLEServer *server)
    {
        deviceConnected = true;

        Serial.println();
        Serial.println("BLE verbunden.");
    }

    void onDisconnect(BLEServer *server)
    {
        deviceConnected = false;

        commandLine = "";

        /*
         * Sicherheit:
         * Falls beim Trennen noch eine Taste gedrückt war,
         * werden alle Tasten freigegeben.
         */

        if (!loopRunning)
        {
            Keyboard.releaseAll();
            Mouse.release(MOUSE_LEFT);
            Mouse.release(MOUSE_RIGHT);
            Mouse.release(MOUSE_MIDDLE);
        }

        Serial.println();
        Serial.println("BLE getrennt.");

        delay(100);

        server->getAdvertising()->start();

        Serial.println(
            "BLE Advertising neu gestartet."
        );
    }
};


/* ------------------------------------------------------------
 * Text über USB HID senden – SCHWEIZER TASTATUR (QWERTZ, de_CH)
 *
 * Der Windows-PC muss auf "Deutsch (Schweiz)" stehen.
 * Jedes Zeichen wird als physische Taste (HID-Code) plus
 * Shift / AltGr gesendet. Eingabe ist UTF-8 (ä, ö, ü, é, € ...).
 * Tote Tasten (^ ` ~) werden mit einem Leerzeichen abgeschlossen.
 * ------------------------------------------------------------ */

struct KeyStroke
{
    uint8_t code;
    bool shift;
    bool altgr;
    bool dead;
};

bool mapChar(uint32_t cp, KeyStroke &k)
{
    k = {0, false, false, false};

    /* Buchstaben (Y und Z sind bei QWERTZ vertauscht) */
    if (cp >= 'a' && cp <= 'z')
    {
        char c = (char)cp;
        if (c == 'y') c = 'z'; else if (c == 'z') c = 'y';
        k.code = 0x04 + (c - 'a');
        return true;
    }
    if (cp >= 'A' && cp <= 'Z')
    {
        char c = (char)cp;
        if (c == 'Y') c = 'Z'; else if (c == 'Z') c = 'Y';
        k.code = 0x04 + (c - 'A');
        k.shift = true;
        return true;
    }

    /* Ziffern */
    if (cp >= '1' && cp <= '9') { k.code = 0x1E + (cp - '1'); return true; }
    if (cp == '0') { k.code = 0x27; return true; }

    switch (cp)
    {
        case ' ':  k.code = 0x2C; return true;
        case '\n': k.code = 0x28; return true;
        case '\t': k.code = 0x2B; return true;

        /* Zahlenreihe mit Shift */
        case '+':  k.code = 0x1E; k.shift = true; return true;
        case '"':  k.code = 0x1F; k.shift = true; return true;
        case '*':  k.code = 0x20; k.shift = true; return true;
        case 0xE7: k.code = 0x21; k.shift = true; return true;   // ç
        case '%':  k.code = 0x22; k.shift = true; return true;
        case '&':  k.code = 0x23; k.shift = true; return true;
        case '/':  k.code = 0x24; k.shift = true; return true;
        case '(':  k.code = 0x25; k.shift = true; return true;
        case ')':  k.code = 0x26; k.shift = true; return true;
        case '=':  k.code = 0x27; k.shift = true; return true;

        /* Zahlenreihe mit AltGr */
        case 0xA6: k.code = 0x1E; k.altgr = true; return true;   // ¦
        case '@':  k.code = 0x1F; k.altgr = true; return true;
        case '#':  k.code = 0x20; k.altgr = true; return true;
        case 0xAC: k.code = 0x23; k.altgr = true; return true;   // ¬
        case '|':  k.code = 0x24; k.altgr = true; return true;
        case 0xA2: k.code = 0x25; k.altgr = true; return true;   // ¢

        /* Taste links von Backspace: ' ? */
        case '\'': k.code = 0x2D; return true;
        case '?':  k.code = 0x2D; k.shift = true; return true;

        /* Taste ^ ` ~ (tote Tasten) */
        case '^':  k.code = 0x2E; k.dead = true; return true;
        case '`':  k.code = 0x2E; k.shift = true; k.dead = true; return true;
        case '~':  k.code = 0x2E; k.altgr = true; k.dead = true; return true;

        /* ü è [ ] ! */
        case 0xFC: k.code = 0x2F; return true;                   // ü
        case 0xDC: k.code = 0x2F; k.shift = true; return true;   // Ü
        case 0xE8: k.code = 0x2F; k.shift = true; return true;   // è
        case '[':  k.code = 0x2F; k.altgr = true; return true;
        case '!':  k.code = 0x30; k.shift = true; return true;
        case ']':  k.code = 0x30; k.altgr = true; return true;

        /* ö é ä à { */
        case 0xF6: k.code = 0x33; return true;                   // ö
        case 0xD6: k.code = 0x33; k.shift = true; return true;   // Ö
        case 0xE9: k.code = 0x33; k.shift = true; return true;   // é
        case 0xE4: k.code = 0x34; return true;                   // ä
        case 0xC4: k.code = 0x34; k.shift = true; return true;   // Ä
        case 0xE0: k.code = 0x34; k.shift = true; return true;   // à
        case '{':  k.code = 0x34; k.altgr = true; return true;

        /* $ £ } (Taste links von Enter) */
        case '$':  k.code = 0x32; return true;
        case 0xA3: k.code = 0x32; k.shift = true; return true;   // £
        case '}':  k.code = 0x32; k.altgr = true; return true;

        /* § ° */
        case 0xA7: k.code = 0x35; return true;                   // §
        case 0xB0: k.code = 0x35; k.shift = true; return true;   // °

        /* , ; . : - _ */
        case ',':  k.code = 0x36; return true;
        case ';':  k.code = 0x36; k.shift = true; return true;
        case '.':  k.code = 0x37; return true;
        case ':':  k.code = 0x37; k.shift = true; return true;
        case '-':  k.code = 0x38; return true;
        case '_':  k.code = 0x38; k.shift = true; return true;

        /* < > \ (Taste links von Y) */
        case '<':  k.code = 0x64; return true;
        case '>':  k.code = 0x64; k.shift = true; return true;
        case '\\': k.code = 0x64; k.altgr = true; return true;

        /* Euro: AltGr + E */
        case 0x20AC: k.code = 0x08; k.altgr = true; return true;
    }

    return false;
}

void tapKey(uint8_t code, bool shift, bool altgr)
{
    if (shift) Keyboard.pressRaw(0xE1);   // Shift
    if (altgr) Keyboard.pressRaw(0xE6);   // AltGr (rechtes Alt)
    delay(2);

    Keyboard.pressRaw(code);
    delay(5);
    Keyboard.releaseRaw(code);

    if (altgr) Keyboard.releaseRaw(0xE6);
    if (shift) Keyboard.releaseRaw(0xE1);
    delay(5);
}

void typeCodepoint(uint32_t cp)
{
    KeyStroke k;

    if (!mapChar(cp, k))
    {
        Serial.print("Zeichen nicht auf Schweizer Tastatur: U+");
        Serial.println(cp, HEX);
        return;
    }

    tapKey(k.code, k.shift, k.altgr);

    if (k.dead)
    {
        tapKey(0x2C, false, false);   // Leerzeichen schliesst die tote Taste ab
    }
}

void typeText(const String &text)
{
    size_t i = 0;
    const size_t n = text.length();

    while (i < n)
    {
        uint8_t c = (uint8_t)text[i];
        uint32_t cp = 0;

        /* UTF-8 dekodieren */
        if (c < 0x80)
        {
            cp = c;
            i += 1;
        }
        else if ((c & 0xE0) == 0xC0 && i + 1 < n)
        {
            cp = ((c & 0x1F) << 6) | ((uint8_t)text[i + 1] & 0x3F);
            i += 2;
        }
        else if ((c & 0xF0) == 0xE0 && i + 2 < n)
        {
            cp = ((c & 0x0F) << 12) |
                 (((uint8_t)text[i + 1] & 0x3F) << 6) |
                 ((uint8_t)text[i + 2] & 0x3F);
            i += 3;
        }
        else
        {
            i += 1;     // ungültig / 4-Byte-Zeichen überspringen
            continue;
        }

        typeCodepoint(cp);
    }
}


/* ------------------------------------------------------------
 * Tastennamen -> USB-HID Usage Code
 *
 * WICHTIG:
 *
 * Diese Funktion liefert echte HID-Codes.
 *
 * Deshalb werden sie später mit
 *
 *   Keyboard.pressRaw()
 *   Keyboard.releaseRaw()
 *
 * verarbeitet.
 *
 * NICHT mit Keyboard.press().
 * ------------------------------------------------------------ */

uint8_t getKeyCode(String key)
{
    key.trim();
    key.toUpperCase();


    /* --------------------------------------------------------
     * Buchstaben A-Z
     *
     * USB HID:
     *
     * A = 0x04
     * B = 0x05
     * ...
     * Z = 0x1D
     * -------------------------------------------------------- */

    if (
        key.length() == 1 &&
        key[0] >= 'A' &&
        key[0] <= 'Z'
    )
    {
        char letter = key[0];

        /* Schweizer QWERTZ: Y und Z vertauscht */
        if (letter == 'Y') letter = 'Z';
        else if (letter == 'Z') letter = 'Y';

        return 0x04 +
               (letter - 'A');
    }


    /* --------------------------------------------------------
     * Zahlen 1-9
     * -------------------------------------------------------- */

    if (
        key.length() == 1 &&
        key[0] >= '1' &&
        key[0] <= '9'
    )
    {
        return 0x1E +
               (key[0] - '1');
    }


    /* --------------------------------------------------------
     * Zahl 0
     * -------------------------------------------------------- */

    if (key == "0")
    {
        return 0x27;
    }


    /* --------------------------------------------------------
     * Funktionstasten
     * -------------------------------------------------------- */

    if (key == "F1")  return 0x3A;
    if (key == "F2")  return 0x3B;
    if (key == "F3")  return 0x3C;
    if (key == "F4")  return 0x3D;
    if (key == "F5")  return 0x3E;
    if (key == "F6")  return 0x3F;
    if (key == "F7")  return 0x40;
    if (key == "F8")  return 0x41;
    if (key == "F9")  return 0x42;
    if (key == "F10") return 0x43;
    if (key == "F11") return 0x44;
    if (key == "F12") return 0x45;


    /* --------------------------------------------------------
     * Steuerung
     * -------------------------------------------------------- */

    if (key == "ENTER")     return 0x28;
    if (key == "RETURN")    return 0x28;

    if (key == "ESC")       return 0x29;
    if (key == "ESCAPE")    return 0x29;

    if (key == "BACKSPACE") return 0x2A;
    if (key == "BACK")      return 0x2A;

    if (key == "TAB")       return 0x2B;

    if (key == "SPACE")     return 0x2C;

    if (key == "DELETE")    return 0x4C;
    if (key == "DEL")       return 0x4C;


    /* --------------------------------------------------------
     * Navigation
     * -------------------------------------------------------- */

    if (key == "RIGHT")     return 0x4F;
    if (key == "LEFT")      return 0x50;
    if (key == "DOWN")      return 0x51;
    if (key == "UP")        return 0x52;

    if (key == "HOME")      return 0x4A;
    if (key == "END")       return 0x4D;

    if (key == "PAGEUP")    return 0x4B;
    if (key == "PAGEDOWN")  return 0x4E;

    if (key == "INSERT")    return 0x49;


    /* --------------------------------------------------------
     * Modifier
     *
     * USB HID:
     *
     * CTRL  = E0
     * SHIFT = E1
     * ALT   = E2
     * GUI   = E3
     * -------------------------------------------------------- */

    if (key == "CTRL")
        return 0xE0;

    if (key == "CONTROL")
        return 0xE0;

    if (key == "SHIFT")
        return 0xE1;

    if (key == "ALT")
        return 0xE2;

    if (key == "ALTGR")
        return 0xE6;

    if (key == "GUI")
        return 0xE3;

    if (key == "WIN")
        return 0xE3;

    if (key == "WINDOWS")
        return 0xE3;


    /*
     * Unbekannte Taste
     */

    return 0;
}


/* ------------------------------------------------------------
 * Taste drücken
 *
 * WICHTIG:
 *
 * Hier wird pressRaw() verwendet.
 *
 * getKeyCode() liefert echte USB-HID-Codes.
 * ------------------------------------------------------------ */

void keyDown(String key)
{
    uint8_t code =
        getKeyCode(key);

    if (code == 0)
    {
        Serial.print(
            "Unbekannte Taste: "
        );

        Serial.println(key);

        return;
    }


    size_t result =
        Keyboard.pressRaw(code);


    Serial.print(
        "DOWN: "
    );

    Serial.print(key);

    Serial.print(
        "  HID=0x"
    );

    if (code < 16)
    {
        Serial.print("0");
    }

    Serial.print(
        code,
        HEX
    );

    Serial.print(
        "  result="
    );

    Serial.println(
        result
    );
}


/* ------------------------------------------------------------
 * Taste loslassen
 *
 * WICHTIG:
 *
 * Hier wird releaseRaw() verwendet.
 * ------------------------------------------------------------ */

void keyUp(String key)
{
    uint8_t code =
        getKeyCode(key);

    if (code == 0)
    {
        Serial.print(
            "Unbekannte Taste: "
        );

        Serial.println(key);

        return;
    }


    size_t result =
        Keyboard.releaseRaw(code);


    Serial.print(
        "UP: "
    );

    Serial.print(key);

    Serial.print(
        "  HID=0x"
    );

    if (code < 16)
    {
        Serial.print("0");
    }

    Serial.print(
        code,
        HEX
    );

    Serial.print(
        "  result="
    );

    Serial.println(
        result
    );
}


/* ------------------------------------------------------------
 * USB-Mausbefehle
 *
 * BLE-Protokoll:
 *   MOUSE MOVE <dx> <dy>
 *   MOUSE DOWN LEFT
 *   MOUSE UP LEFT
 *   MOUSE CLICK LEFT
 *   MOUSE SCROLL <wert>
 *   MOUSE RESET
 * ------------------------------------------------------------ */

uint8_t getMouseButton(String button)
{
    button.trim();
    button.toUpperCase();

    if (button == "LEFT") return MOUSE_LEFT;
    if (button == "RIGHT") return MOUSE_RIGHT;
    if (button == "MIDDLE") return MOUSE_MIDDLE;
    return 0;
}

void processMouseCommand(String command)
{
    command.trim();

    if (command.startsWith("MOUSE MOVE "))
    {
        String values = command.substring(11);
        int separator = values.indexOf(' ');
        if (separator < 0) return;

        int dx = constrain(values.substring(0, separator).toInt(), -127, 127);
        int dy = constrain(values.substring(separator + 1).toInt(), -127, 127);
        Mouse.move((int8_t)dx, (int8_t)dy, 0);
        return;
    }

    if (command.startsWith("MOUSE DOWN "))
    {
        uint8_t button = getMouseButton(command.substring(11));
        if (button) Mouse.press(button);
        return;
    }

    if (command.startsWith("MOUSE UP "))
    {
        uint8_t button = getMouseButton(command.substring(9));
        if (button) Mouse.release(button);
        return;
    }

    if (command.startsWith("MOUSE CLICK "))
    {
        uint8_t button = getMouseButton(command.substring(12));
        if (button)
        {
            Mouse.press(button);
            delay(25);
            Mouse.release(button);
        }
        return;
    }

    if (command.startsWith("MOUSE SCROLL "))
    {
        int amount = constrain(command.substring(13).toInt(), -127, 127);
        Mouse.move(0, 0, (int8_t)amount);
        return;
    }

    if (command == "MOUSE RESET")
    {
        Mouse.release(MOUSE_LEFT);
        Mouse.release(MOUSE_RIGHT);
        Mouse.release(MOUSE_MIDDLE);
        return;
    }

    Serial.print("Unbekannter Maus-Befehl: ");
    Serial.println(command);
}


/* ------------------------------------------------------------
 * Befehlszeile verarbeiten
 * ------------------------------------------------------------ */

void processCommand(String command)
{
    command.trim();

    if (command.length() == 0)
    {
        return;
    }


    Serial.print(
        "Befehl: "
    );

    Serial.println(command);

    /* --------------------------------------------------------
     * LOOP
     * -------------------------------------------------------- */

    if (command == "LOOP START")
    {
        loopRunning = false;
        loopGeneration++;

        xSemaphoreTake(loopMutex, portMAX_DELAY);
        loopCommands.clear();
        xSemaphoreGive(loopMutex);

        loopRecording = true;
        Serial.println("Loop-Aufzeichnung gestartet.");
        return;
    }

    if (command == "LOOP END")
    {
        if (loopRecording)
        {
            loopRecording = false;

            if (loopCommands.size() > 0)
            {
                loopRunning = true;
                Serial.println("Loop laeuft (bis ESP ausgesteckt wird).");
            }
        }
        return;
    }

    if (command == "LOOP STOP")
    {
        loopRunning = false;
        loopRecording = false;
        loopGeneration++;

        Keyboard.releaseAll();
        Mouse.release(MOUSE_LEFT);
        Mouse.release(MOUSE_RIGHT);
        Mouse.release(MOUSE_MIDDLE);

        Serial.println("Loop gestoppt.");
        return;
    }

    if (loopRecording)
    {
        xSemaphoreTake(loopMutex, portMAX_DELAY);
        if (loopCommands.size() < LOOP_MAX_COMMANDS)
        {
            loopCommands.push_back(command);
        }
        xSemaphoreGive(loopMutex);
        return;
    }

    if (command.startsWith("MOUSE "))
    {
        processMouseCommand(command);
        return;
    }

    /* --------------------------------------------------------
     * DOWN
     * -------------------------------------------------------- */

    if (command.startsWith("DOWN "))
    {
        String key =
            command.substring(5);

        keyDown(key);

        return;
    }


    /* --------------------------------------------------------
     * UP
     * -------------------------------------------------------- */

    if (command.startsWith("UP "))
    {
        String key =
            command.substring(3);

        keyUp(key);

        return;
    }


    /* --------------------------------------------------------
     * TEXT
     * -------------------------------------------------------- */

    if (command.startsWith("TEXT "))
    {
        String text =
            command.substring(5);

        typeText(text);

        return;
    }


    /* --------------------------------------------------------
     * DELAY
     * -------------------------------------------------------- */

    if (command.startsWith("DELAY "))
    {
        String value =
            command.substring(6);

        long milliseconds =
            value.toInt();

        if (milliseconds > 0)
        {
            delay(milliseconds);
        }

        return;
    }


    /* --------------------------------------------------------
     * RESET
     * -------------------------------------------------------- */

    if (command == "RESET")
    {
        Keyboard.releaseAll();

        Serial.println(
            "Alle Tasten freigegeben."
        );

        return;
    }


    /* --------------------------------------------------------
     * Unbekannter Befehl
     * -------------------------------------------------------- */

    Serial.print(
        "Unbekannter Befehl: "
    );

    Serial.println(command);
}


/* ------------------------------------------------------------
 * BLE Characteristic Callback
 * ------------------------------------------------------------ */

class KeyboardCallbacks
    : public BLECharacteristicCallbacks
{
    void onWrite(
        BLECharacteristic *characteristic
    )
    {
        /*
         * ESP32 Core 3.3.11:
         *
         * getValue() liefert Arduino String.
         */

        String data =
            characteristic->getValue();


        if (data.length() == 0)
        {
            return;
        }


        Serial.print(
            "BLE Paket empfangen: "
        );

        Serial.println(data);


        /*
         * Paket Zeichen für Zeichen verarbeiten.
         */

        for (
            size_t i = 0;
            i < data.length();
            i++
        )
        {
            char c =
                data[i];


            /*
             * Ende einer Befehlszeile
             */

            if (c == '\n')
            {
                processCommand(
                    commandLine
                );

                commandLine = "";
            }


            /*
             * CR ignorieren
             */

            else if (c == '\r')
            {
                continue;
            }


            /*
             * Zeichen sammeln
             */

            else
            {
                commandLine += c;
            }
        }
    }
};


/* ------------------------------------------------------------
 * SETUP
 * ------------------------------------------------------------ */

void setup()
{
    loopMutex = xSemaphoreCreateMutex();

    Serial.begin(
        115200
    );

    delay(1000);


    Serial.println();

    Serial.println(
        "--------------------------------"
    );

    Serial.println(
        "ESP32-S3 Keyboard"
    );

    Serial.println(
        "--------------------------------"
    );


    /* --------------------------------------------------------
     * USB HID Tastatur und Maus starten
     * -------------------------------------------------------- */

    Keyboard.begin();
    Mouse.begin();

    USB.begin();

    Serial.println(
        "USB HID Keyboard gestartet."
    );


    /* --------------------------------------------------------
     * BLE starten
     * -------------------------------------------------------- */

    BLEDevice::init(BLE_DEVICE_NAME);


    BLEServer *server =
        BLEDevice::createServer();

    server->setCallbacks(
        new ServerCallbacks()
    );


    BLEService *service =
        server->createService(
            SERVICE_UUID
        );


    /* --------------------------------------------------------
     * BLE Characteristic
     * -------------------------------------------------------- */

    keyboardCharacteristic =
        service->createCharacteristic(
            CHARACTERISTIC_UUID,
            BLECharacteristic::PROPERTY_WRITE |
            BLECharacteristic::PROPERTY_WRITE_NR
        );


    keyboardCharacteristic->setCallbacks(
        new KeyboardCallbacks()
    );


    service->start();


    /* --------------------------------------------------------
     * BLE Advertising
     * -------------------------------------------------------- */

    BLEAdvertising *advertising =
        BLEDevice::getAdvertising();

    advertising->addServiceUUID(
        SERVICE_UUID
    );

    advertising->setScanResponse(
        true
    );

    advertising->setMinPreferred(
        0x06
    );

    advertising->setMaxPreferred(
        0x12
    );

    BLEDevice::startAdvertising();


    Serial.println(
        "BLE gestartet."
    );

    Serial.print("Bluetooth-Name: ");
    Serial.println(BLE_DEVICE_NAME);

    Serial.println(
        "Warte auf Android-App..."
    );
}


/* ------------------------------------------------------------
 * LOOP
 * ------------------------------------------------------------ */

void loop()
{
    if (loopRunning)
    {
        uint32_t generation = loopGeneration;

        std::vector<String> snapshot;

        xSemaphoreTake(loopMutex, portMAX_DELAY);
        snapshot = loopCommands;
        xSemaphoreGive(loopMutex);

        for (size_t i = 0; i < snapshot.size(); i++)
        {
            if (!loopRunning || loopRecording || generation != loopGeneration)
            {
                break;
            }

            processCommand(snapshot[i]);
        }
    }

    delay(10);
}