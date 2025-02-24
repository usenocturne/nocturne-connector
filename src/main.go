package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/hdiniz/wpa_supplicant-go"
	alpine_builder "gitlab.com/raspi-alpine/go-raspi-alpine"
)

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

func main() {
	err := OpenrcStart("wpa_supplicant")
	if err != nil {
		fmt.Printf("Failed to start wpa_supplicant: %s\n", err)
		os.Exit(1)
	}

	var ctrl *wpa_supplicant.ControlInterface
	for i := 0; i < 10; i++ {
		ctrl, err = wpa_supplicant.Connect("/run/wpa_supplicant/wlan0")
		if err == nil {
			break
		}
		time.Sleep(1 * time.Second)
	}

	if ctrl == nil {
		fmt.Printf("Failed to connect to wpa_supplicant after retries: %s\n", err)
		os.Exit(1)
	}

	err = OpenrcStart("wpa_cli")
	if err != nil {
		fmt.Printf("Failed to start wpa_cli: %s\n", err)
	}

	ctx := context.TODO()

	res, _ := ctrl.SendRequest(ctx, "PING")
	if err != nil || res != "PONG\n" {
		fmt.Printf("Failed to ping wpa_supplicant control interface: %s\n", res)
		os.Exit(1)
	}

	fmt.Printf("Connected to wpa_supplicant control interface\n")

	go func() {
		err := ctrl.Listen(ctx, func(event wpa_supplicant.Event) {
			broadcastEvent(event)
		})
		if err != nil {
			log.Printf("Error listening to wpa_supplicant events: %v", err)
		}
	}()

	// WebSockets
	http.HandleFunc("/ws", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("Error upgrading to WebSocket: %v", err)
			return
		}

		clientsMux.Lock()
		clients[conn] = true
		clientsMux.Unlock()

		go func() {
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					clientsMux.Lock()
					delete(clients, conn)
					clientsMux.Unlock()
					conn.Close()
					break
				}
			}
		}()
	}))

	// GET /info
	http.HandleFunc("/info", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		versionBytes, err := os.ReadFile("/etc/nocturne-connector/version.txt")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to read version file: " + err.Error()})
			return
		}
		version := strings.TrimSpace(string(versionBytes))

		osVersionBytes, err := os.ReadFile("/etc/alpine-release")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to read alpine-release file: " + err.Error()})
			return
		}
		osVersion := strings.TrimSpace(string(osVersionBytes))

		uBootActive := alpine_builder.UBootActive()
		bootSlot := "unknown"
		if uBootActive == 2 {
			bootSlot = "A"
		} else if uBootActive == 3 {
			bootSlot = "B"
		}

		response := InfoResponse{
			Version:        version,
			OSVersion:      osVersion,
			ActiveBootSlot: bootSlot,
		}

		if err := json.NewEncoder(w).Encode(response); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	// GET /network
	http.HandleFunc("/network", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		res, err := ctrl.SendRequest(ctx, "STATUS")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send status command: " + err.Error()})
			return
		}

		lines := strings.Split(res, "\n")
		rawConfig := make(map[string]string)
		for _, line := range lines {
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				key := strings.TrimSpace(parts[0])
				value := strings.TrimSpace(parts[1])
				rawConfig[key] = value
			}
		}

		status := NetworkStatus{
			BSSID:          rawConfig["bssid"],
			Freq:           rawConfig["freq"],
			SSID:           rawConfig["ssid"],
			ID:             rawConfig["id"],
			WifiGeneration: rawConfig["wifi_generation"],
			KeyMgmt:        rawConfig["key_mgmt"],
			WPAState:       rawConfig["wpa_state"],
			IPAddress:      rawConfig["ip_address"],
		}

		if err := json.NewEncoder(w).Encode(status); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	// GET /network/list
	http.HandleFunc("/network/list", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		res, err := ctrl.SendRequest(ctx, "LIST_NETWORKS")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send list networks command: " + err.Error()})
			return
		}

		networks := []map[string]string{}
		scanner := bufio.NewScanner(strings.NewReader(res))
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}

			fields := strings.Split(line, "\t")
			if len(fields) != 4 {
				continue
			}

			network := map[string]string{
				"networkId": fields[0],
				"ssid":      fields[1],
				"bssid":     fields[2],
				"flags":     fields[3],
			}
			networks = append(networks, network)
		}

		if err := json.NewEncoder(w).Encode(networks); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	// GET /network/scan
	http.HandleFunc("/network/scan", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		res, err := ctrl.SendRequest(ctx, "SCAN")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send scan command: " + err.Error()})
			return
		} else if res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send scan command: " + res})
			return
		}

		select {
		case <-scanComplete:
		case <-time.After(10 * time.Second):
			w.WriteHeader(http.StatusRequestTimeout)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Scan timeout"})
			return
		}

		res, err = ctrl.SendRequest(ctx, "SCAN_RESULTS")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to get scan results: " + err.Error()})
			return
		}

		networks := []map[string]string{}
		scanner := bufio.NewScanner(strings.NewReader(res))
		for scanner.Scan() {
			line := scanner.Text()
			if line == "" {
				continue
			}

			fields := strings.Split(line, "\t")
			if len(fields) != 5 {
				continue
			}

			network := map[string]string{
				"bssid":     fields[0],
				"frequency": fields[1],
				"signal":    fields[2],
				"flags":     fields[3],
				"ssid":      fields[4],
			}
			networks = append(networks, network)
		}

		if err := json.NewEncoder(w).Encode(networks); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	// POST /network/connect
	http.HandleFunc("/network/connect", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		var requestData struct {
			SSID string `json:"ssid"`
			PSK  string `json:"psk"`
		}

		if err := json.NewDecoder(r.Body).Decode(&requestData); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Invalid request body: " + err.Error()})
			return
		}

		res, err := ctrl.SendRequest(ctx, "ADD_NETWORK")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send add network command: " + err.Error()})
			return
		}

		networkId := strings.TrimSpace(res)

		res, err = ctrl.SendRequest(ctx, fmt.Sprintf("SET_NETWORK %s ssid \"%s\"", networkId, requestData.SSID))
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send set network SSID command: " + err.Error()})
			return
		} else if res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send set network SSID command: " + res})
			return
		}

		if requestData.PSK == "" {
			res, err = ctrl.SendRequest(ctx, fmt.Sprintf("SET_NETWORK %s key_mgmt NONE", networkId))
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send set network key_mgmt command: " + err.Error()})
				return
			} else if res != "OK\n" {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send set network key_mgmt command: " + res})
				return
			}
		} else {
			res, err = ctrl.SendRequest(ctx, fmt.Sprintf("SET_NETWORK %s psk \"%s\"", networkId, requestData.PSK))
			if err != nil {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send set network PSK command: " + err.Error()})
				return
			} else if res != "OK\n" {
				w.WriteHeader(http.StatusInternalServerError)
				json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send set network PSK command: " + res})
				return
			}
		}

		res, err = ctrl.SendRequest(ctx, "SAVE_CONFIG")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to save config: " + err.Error()})
			return
		} else if res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to save config: " + res})
			return
		}

		if err := json.NewEncoder(w).Encode(OKResponse{Status: "success"}); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	// POST /network/select/{id}
	http.HandleFunc("/network/select/", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		id := strings.TrimPrefix(r.URL.Path, "/network/select/")
		if id == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Network id is required"})
			return
		}
		networkId := strings.TrimSpace(id)

		res, err := ctrl.SendRequest(ctx, fmt.Sprintf("SELECT_NETWORK %s", networkId))
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send select network command: " + err.Error()})
			return
		} else if res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send select network command: " + res})
			return
		}

		res, err = ctrl.SendRequest(ctx, "SAVE_CONFIG")
		if err != nil || res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to save config: " + err.Error()})
			return
		}

		if err := json.NewEncoder(w).Encode(OKResponse{Status: "success"}); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	// DELETE /network/remove/{id}
	http.HandleFunc("/network/remove/", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "DELETE" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		id := strings.TrimPrefix(r.URL.Path, "/network/remove/")
		if id == "" {
			w.WriteHeader(http.StatusBadRequest)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Network id is required"})
			return
		}
		networkId := strings.TrimSpace(id)

		res, err := ctrl.SendRequest(ctx, fmt.Sprintf("REMOVE_NETWORK %s", networkId))
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send remove network command: " + err.Error()})
			return
		} else if res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to send remove network command: " + res})
			return
		}

		res, err = ctrl.SendRequest(ctx, "SAVE_CONFIG")
		if err != nil || res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to save config: " + err.Error()})
			return
		}

		if err := json.NewEncoder(w).Encode(OKResponse{Status: "success"}); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Failed to encode JSON: " + err.Error()})
			return
		}
	}))

	port := os.Getenv("PORT")
	if port == "" {
		port = "20574"
	}

	log.Printf("Server starting on :%s", port)
	//if err := http.ListenAndServe(":"+port, nil); err != nil {
	if err := http.ListenAndServeTLS(":"+port, "/etc/nocturne-connector/cert.crt", "/etc/nocturne-connector/cert.key", nil); err != nil {
		log.Fatal(err)
	}
}
