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

func broadcastProgress(progress ProgressMessage) {
	clientsMux.Lock()
	for client := range clients {
		if err := client.WriteJSON(progress); err != nil {
			log.Printf("Error broadcasting progress to client: %v", err)
			client.Close()
			delete(clients, client)
		}
	}
	clientsMux.Unlock()
}

func broadcastCompletion(completion CompletionMessage) {
	clientsMux.Lock()
	for client := range clients {
		if err := client.WriteJSON(completion); err != nil {
			log.Printf("Error broadcasting completion to client: %v", err)
			client.Close()
			delete(clients, client)
		}
	}
	clientsMux.Unlock()
}
