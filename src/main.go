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

type InfoResponse struct {
	Version string `json:"version"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

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
	ctrl, err := wpa_supplicant.Connect("/run/wpa_supplicant/wlan0")
	if err != nil {
		fmt.Printf("failed to connect to wpa_supplicant: %s\n", err)
		os.Exit(1)
	}

	ctx := context.TODO()

	res, _ := ctrl.SendRequest(ctx, "PING")
	if res != "PONG\n" {
		fmt.Printf("failed to ping wpa_supplicant control interface: %s\n", res)
		os.Exit(1)
	}

	fmt.Printf("connected to wpa_supplicant control interface\n")

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

	// GET /hello
	http.HandleFunc("/hello", corsMiddleware(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "Method not allowed"})
			return
		}

		versionBytes, err := os.ReadFile("/etc/nocturne-connector/version.txt")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
			return
		}
		version := string(versionBytes)

		osVersionBytes, err := os.ReadFile("/etc/alpine-release")
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
			return
		}
		osVersion := string(osVersionBytes)

		uBootActive := alpine_builder.UBootActive()

		bootSlot := "unknown"
		if uBootActive == 2 {
			bootSlot = "A"
		} else if uBootActive == 3 {
			bootSlot = "B"
		}

		response := map[string]string{
			"version":        version,
			"osVersion":      osVersion,
			"activeBootSlot": bootSlot,
		}

		if err := json.NewEncoder(w).Encode(response); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
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

		networkInfo, err := alpine_builder.GetNetworkInfo()
		if err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
			return
		}

		if err := json.NewEncoder(w).Encode(networkInfo); err != nil {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
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
		if res != "OK\n" {
			w.WriteHeader(http.StatusInternalServerError)
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
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
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
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
			json.NewEncoder(w).Encode(ErrorResponse{Error: err.Error()})
			return
		}
	}))

	port := os.Getenv("PORT")
	if port == "" {
		port = "20574"
	}

	log.Printf("Server starting on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}
