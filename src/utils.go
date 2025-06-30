package main

import (
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	alpine_builder "gitlab.com/raspi-alpine/go-raspi-alpine"
)

type progressReader struct {
	reader       io.Reader
	total        int64
	read         int64
	lastUpdate   time.Time
	lastBytes    int64
	onProgress   func(int64, int64, float64)
	updatePeriod time.Duration
}

func newProgressReader(reader io.Reader, total int64, onProgress func(int64, int64, float64)) *progressReader {
	return &progressReader{
		reader:       reader,
		total:        total,
		onProgress:   onProgress,
		lastUpdate:   time.Now(),
		updatePeriod: time.Second / 4,
	}
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.reader.Read(p)
	if n > 0 {
		pr.read += int64(n)
		now := time.Now()
		if now.Sub(pr.lastUpdate) >= pr.updatePeriod {
			elapsed := now.Sub(pr.lastUpdate).Seconds()
			speed := float64(pr.read-pr.lastBytes) / elapsed / 1024 / 1024 // Convert to MB/s
			pr.onProgress(pr.read, pr.total, speed)
			pr.lastUpdate = now
			pr.lastBytes = pr.read
		}
	}
	return n, err
}

var rootPartitionA = "/dev/mmcblk0p2"
var rootPartitionB = "/dev/mmcblk0p3"

// From: https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/utils/sh.go#L19C1-L24C2
func runShell(command string) (string, error) {
	cmd := exec.Command("/bin/sh", "-c", command)
	cmd.Env = os.Environ()
	o, err := cmd.CombinedOutput()
	return string(o), err
}

// Adapted from: https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/machine/openrc/unit.go#L75
func OpenrcStart(service string) error {
	out, err := runShell(fmt.Sprintf("/etc/init.d/%s start", service))
	fmt.Printf("%s\n", out)
	if err != nil {
		return fmt.Errorf("%s (%w)", out, err)
	}
	return nil
}

// Adapted from: https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/machine/openrc/unit.go#L83
func OpenrcRestart(service string) error {
	out, err := runShell(fmt.Sprintf("/etc/init.d/%s restart", service))
	if err != nil {
		return fmt.Errorf("%s (%w)", out, err)
	}
	return nil
}

// Adapted from: https://github.com/kairos-io/kairos/blob/v1.6.0/pkg/machine/openrc/unit.go#L91
func OpenrcEnable(service string, runlevel string) error {
	_, err := runShell(fmt.Sprintf("ln -sf /etc/init.d/%s /etc/runlevels/default/%s", service, runlevel))
	return err
}

// Adapted from: https://gitlab.com/raspi-alpine/go-raspi-alpine/-/blob/2293efba9440/update.go#L102
func UpdateSystem(image string, sum string, onProgress func(ProgressMessage)) error {
	imgFile, err := os.Open(image)
	if err != nil {
		return fmt.Errorf("failed to open image: %w", err)
	}
	defer imgFile.Close()

	imgSha := sha256.New()
	if _, err := io.Copy(imgSha, imgFile); err != nil {
		return fmt.Errorf("failed to get sha256sum of image: %w", err)
	}

	s := fmt.Sprintf("%x", imgSha.Sum(nil))
	if s != sum {
		return fmt.Errorf("provided sum does not match: %s", s)
	}

	if _, err := imgFile.Seek(0, 0); err != nil {
		return fmt.Errorf("failed to seek image file: %w", err)
	}

	// A=2, B=3
	active := alpine_builder.UBootActive()
	rootPart := rootPartitionA
	if active == 2 {
		rootPart = rootPartitionB
	}

	inDecompress, err := gzip.NewReader(imgFile)
	if err != nil {
		return fmt.Errorf("failed to decompress image file: %w", err)
	}
	defer inDecompress.Close()

	tempFile, err := os.CreateTemp("", "uncompressed-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tempFile.Name())
	defer tempFile.Close()

	if _, err := io.Copy(tempFile, inDecompress); err != nil {
		return fmt.Errorf("failed to decompress image: %w", err)
	}

	uncompressedSize, err := tempFile.Seek(0, 2)
	if err != nil {
		return fmt.Errorf("failed to get uncompressed size: %w", err)
	}

	if _, err := imgFile.Seek(0, 0); err != nil {
		return fmt.Errorf("failed to seek image file: %w", err)
	}

	inDecompress, err = gzip.NewReader(imgFile)
	if err != nil {
		return fmt.Errorf("failed to decompress image file: %w", err)
	}
	defer inDecompress.Close()

	out, err := os.OpenFile(rootPart, os.O_WRONLY|os.O_TRUNC|os.O_SYNC, os.ModePerm)
	if err != nil {
		return fmt.Errorf("failed to open flash device: %w", err)
	}
	defer out.Close()

	progressReader := newProgressReader(inDecompress, uncompressedSize, func(complete, total int64, speed float64) {
		percent := float64(complete) / float64(total) * 100
		onProgress(ProgressMessage{
			Type:          "progress",
			Stage:         "flash",
			BytesComplete: complete,
			BytesTotal:    total,
			Speed:         float64(int(speed*10)) / 10,
			Percent:       float64(int(percent*10)) / 10,
		})
	})

	_, err = io.Copy(out, progressReader)
	if err != nil {
		return fmt.Errorf("failed to copy image: %w", err)
	}

	if active == 2 {
		return alpine_builder.UBootSetActive(3)
	} else {
		return alpine_builder.UBootSetActive(2)
	}
}
