#include <WiFi.h>
#include <HTTPClient.h>
#include <BLEDevice.h>
#include <BLEScan.h>
#include <ArduinoJson.h> // Search for "ArduinoJson" in Library Manager

// WIFI SETTINGS
const char* ssid = "Tinker Space";
const char* password = "123tinkerspace";

// TARGET: Your Laptop's IP and Port
const char* serverUrl = "http://192.168.11.110:3000/data"; 

class ScoutCallbacks: public BLEAdvertisedDeviceCallbacks {
    void onResult(BLEAdvertisedDevice advertisedDevice) {
        if (WiFi.status() == WL_CONNECTED) {
            HTTPClient http;
            http.begin(serverUrl);
            http.addHeader("Content-Type", "application/json");

            // Prepare JSON Data
            StaticJsonDocument<200> doc;
            doc["node_id"] = 1;
            doc["rssi"] = advertisedDevice.getRSSI();
            doc["mac"] = advertisedDevice.getAddress().toString();

            String requestBody;
            serializeJson(doc, requestBody);

            // Send to Laptop
            int httpResponseCode = http.POST(requestBody);
            http.end();
        }
    }
};

void setup() {
    Serial.begin(115200);
    WiFi.begin(ssid, password);
    
    while (WiFi.status() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi Connected!");

    BLEDevice::init("");
    BLEScan* pBLEScan = BLEDevice::getScan();
    pBLEScan->setAdvertisedDeviceCallbacks(new ScoutCallbacks());
    pBLEScan->setActiveScan(true);
    pBLEScan->start(0, true); // Continuous scan
}

void loop() {
    // BLE scanning is handled in the background
    delay(1000);
}
