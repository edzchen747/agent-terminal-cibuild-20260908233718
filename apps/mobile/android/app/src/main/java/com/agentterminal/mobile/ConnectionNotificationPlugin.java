package com.agentterminal.mobile;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ConnectionNotification")
public class ConnectionNotificationPlugin extends Plugin {
    public static final String ACTION_DISCONNECT_REQUESTED = "com.agentterminal.mobile.DISCONNECT_REQUESTED";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4201;
    private BroadcastReceiver disconnectReceiver;

    @Override
    public void load() {
        disconnectReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                notifyListeners("disconnectRequested", null);
            }
        };
        ContextCompat.registerReceiver(getContext(), disconnectReceiver, new IntentFilter(ACTION_DISCONNECT_REQUESTED), ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String hostName = call.getString("hostName", "Agent Terminal");
        Intent intent = new Intent(getContext(), ConnectionNotificationService.class)
            .setAction(ConnectionNotificationService.ACTION_START)
            .putExtra(ConnectionNotificationService.EXTRA_HOST_NAME, hostName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ContextCompat.startForegroundService(getContext(), intent);
        else getContext().startService(intent);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getActivity().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            getActivity().requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ConnectionNotificationService.class));
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (disconnectReceiver != null) {
            getContext().unregisterReceiver(disconnectReceiver);
            disconnectReceiver = null;
        }
        super.handleOnDestroy();
    }
}
