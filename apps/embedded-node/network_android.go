//go:build android

package main

import (
	"github.com/wlynxg/anet"
	"tailscale.com/net/netmon"
)

// Android 11 and newer prohibit untrusted apps from using the netlink calls
// used by Go's net.Interfaces. anet uses the Android-compatible RTM_GETADDR
// and ioctl path instead, and netmon supports registering that implementation.
func configureNetworkInterfaceGetter() {
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
