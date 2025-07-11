package main

import (
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/hdiniz/wpa_supplicant-go"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

var (
	clients    = make(map[*websocket.Conn]bool)
	clientsMux sync.Mutex

	scanComplete = make(chan struct{})
)

func broadcastEvent(event wpa_supplicant.Event) {
	message := map[string]interface{}{
		"priority": event.Priority,
		"data":     event.Data,
	}

	if strings.Contains(event.Data, "CTRL-EVENT-SCAN-RESULTS") {
		select {
		case scanComplete <- struct{}{}:
		default:
		}
	}

	if strings.Contains(event.Data, "CTRL-EVENT-CONNECTED") {
		go func() {
			out, err := runShell("/etc/wpa_supplicant/wpa_cli.sh wlan0 CONNECTED")
			if err != nil {
				log.Printf("Error running wpa_cli CONNECTED: %v, output: %s", err, out)
			}
		}()
	}

	if strings.Contains(event.Data, "CTRL-EVENT-DISCONNECTED") {
		go func() {
			out, err := runShell("/etc/wpa_supplicant/wpa_cli.sh wlan0 DISCONNECTED")
			if err != nil {
				log.Printf("Error running wpa_cli DISCONNECTED: %v, output: %s", err, out)
			}
		}()
	}

	clientsMux.Lock()
	for client := range clients {
		if err := client.WriteJSON(message); err != nil {
			log.Printf("Error broadcasting to client: %v", err)
			client.Close()
			delete(clients, client)
		}
	}
	clientsMux.Unlock()
}
