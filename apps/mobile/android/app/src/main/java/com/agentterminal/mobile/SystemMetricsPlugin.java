package com.agentterminal.mobile;

import android.view.ViewConfiguration;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Exposes device system values the web layer cannot read.
 */
@CapacitorPlugin(name = "SystemMetrics")
public class SystemMetricsPlugin extends Plugin {

    /**
     * The Android system's long-press detection timeout (the
     * config_longPressTimeout resource, the same value the platform's own
     * long-press detection uses). The terminal's utility key pad takes it
     * as the boundary between a detected modifier-key hold and a tap, so
     * holding a modifier for as long as the system's own long-press
     * threshold no longer leaves it selected on release.
     */
    @PluginMethod
    public void longPressTimeoutMs(PluginCall call) {
        JSObject result = new JSObject();
        result.put("longPressTimeoutMs", ViewConfiguration.getLongPressTimeout());
        call.resolve(result);
    }
}
