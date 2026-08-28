//go:build android

package main

import (
	"context"
	"net"
	"net/netip"
	"os"
	"strings"

	"github.com/wlynxg/anet"
	"tailscale.com/net/dnscache"
	"tailscale.com/net/netmon"
)

// Android 11 and newer prohibit untrusted apps from using the netlink calls
// used by Go's net.Interfaces. anet uses the Android-compatible RTM_GETADDR
// and ioctl path instead, and netmon supports registering that implementation.
func configureNetworkInterfaceGetter() {
	configureAndroidResolver()

	// The Android binary is intentionally built with CGO disabled, so anet
	// cannot query the SDK level through android_get_device_api_level().
	// Explicitly select the Android 11+ implementation.
	anet.SetAndroidVersion(11)
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		interfaces, err := anet.Interfaces()
		if err != nil {
			return nil, err
		}

		result := make([]netmon.Interface, 0, len(interfaces))
		for index := range interfaces {
			iface := interfaces[index]
			addresses, err := anet.InterfaceAddrsByInterface(&iface)
			if err != nil {
				return nil, err
			}
			result = append(result, netmon.Interface{Interface: &iface, AltAddrs: addresses})
		}
		return result, nil
	})
}

// Android's /etc/resolv.conf points at a localhost DNS stub which is normally
// serviced by Android's libc/netd integration. The CGO-disabled Go resolver
// cannot use that integration, so receive the active network's DNS servers
// from the Java bridge and use them explicitly.
func configureAndroidResolver() {
	servers := make([]netip.Addr, 0)
	for _, value := range strings.Split(os.Getenv("AGENT_TERMINAL_DNS_SERVERS"), ",") {
		address, err := netip.ParseAddr(strings.TrimSpace(value))
		if err == nil {
			servers = append(servers, address)
		}
	}
	if len(servers) == 0 {
		servers = []netip.Addr{
			netip.MustParseAddr("1.1.1.1"),
			netip.MustParseAddr("8.8.8.8"),
		}
	}

	resolver := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _ string, _ string) (net.Conn, error) {
			var lastError error
			for _, server := range servers {
				network := "udp4"
				if server.Is6() {
					network = "udp6"
				}
				dialer := net.Dialer{}
				connection, err := dialer.DialContext(ctx, network, net.JoinHostPort(server.String(), "53"))
				if err == nil {
					return connection, nil
				}
				lastError = err
			}
			return nil, lastError
		},
	}

	// Tailscale's Android DNS cache owns its Forward resolver, so changing
	// only net.DefaultResolver would not affect control-plane lookups.
	net.DefaultResolver = resolver
	dnscache.Get().Forward = resolver
}
