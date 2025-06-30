package main

type InfoResponse struct {
	Version        string `json:"version"`
	OSVersion      string `json:"osVersion"`
	ActiveBootSlot string `json:"activeBootSlot"`
}

type OKResponse struct {
	Status string `json:"status"`
}

type ErrorResponse struct {
	Error string `json:"error"`
}

type NetworkStatus struct {
	BSSID          string `json:"bssid"`
	Freq           string `json:"freq"`
	SSID           string `json:"ssid"`
	ID             string `json:"id"`
	WifiGeneration string `json:"wifiGeneration"`
	KeyMgmt        string `json:"keyMgmt"`
	WPAState       string `json:"wpaState"`
	IPAddress      string `json:"ipAddress"`
}

type UpdateRequest struct {
	ImageURL string `json:"imageUrl"`
	SumURL   string `json:"sumUrl"`
}

type ProgressMessage struct {
	Type          string  `json:"type"`
	Stage         string  `json:"stage"`
	BytesComplete int64   `json:"bytesComplete"`
	BytesTotal    int64   `json:"bytesTotal"`
	Speed         float64 `json:"speed"`
	Percent       float64 `json:"percent"`
}

type UpdateStatus struct {
	InProgress bool   `json:"inProgress"`
	Stage      string `json:"stage"`
	Error      string `json:"error,omitempty"`
}

type CompletionMessage struct {
	Type    string `json:"type"`
	Stage   string `json:"stage"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}
