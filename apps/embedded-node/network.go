//go:build !android

package main

// configureNetworkInterfaceGetter is a no-op on platforms where the standard
// library can enumerate network interfaces normally.
func configureNetworkInterfaceGetter() {}
