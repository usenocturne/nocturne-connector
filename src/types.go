package main

type InfoResponse struct {
	Version   string `json:"version"`
	OSVersion string `json:"osVersion"`
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
