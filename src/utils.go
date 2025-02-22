package main

import (
	"fmt"
	"os"
	"os/exec"
)

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
