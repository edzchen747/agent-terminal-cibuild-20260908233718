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
    public static final String ACTION_RECONNECT_TIMED_OUT = "com.agentterminal.mobile.RECONNECT_TIMED_OUT";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4201;
    private BroadcastReceiver connectionReceiver;

    @Override
    public void load() {
        connectionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_RECONNECT_TIMED_OUT.equals(intent.getAction())) notifyListeners("reconnectTimedOut", null);
                else notifyListeners("disconnectRequested", null);
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_DISCONNECT_REQUESTED);
        filter.addAction(ACTION_RECONNECT_TIMED_OUT);
        ContextCompat.registerReceiver(getContext(), connectionReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String hostName = call.getString("hostName", "Agent Terminal");
        Intent intent = new Intent(getContext(), ConnectionNotificationService.class)
            .setAction(ConnectionNotificationService.ACTION_START)
            .putExtra(ConnectionNotificationService.EXTRA_HOST_NAME, hostName);
        try {
            startService(intent);
        } catch (RuntimeException error) {
            call.reject("Could not start the connection service.", error);
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getActivity().checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            getActivity().requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATION_PERMISSION_REQUEST);
        }
        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        String hostName = call.getString("hostName", "Agent Terminal");
        String state = call.getString("state", ConnectionNotificationService.STATE_RECONNECTING);
        if (!ConnectionNotificationService.STATE_CONNECTED.equals(state) &&
            !ConnectionNotificationService.STATE_RECONNECTING.equals(state)) {
            call.reject("The connection notification state is invalid.");
            return;
        }
        Intent intent = new Intent(getContext(), ConnectionNotificationService.class)
            .setAction(ConnectionNotificationService.ACTION_UPDATE)
            .putExtra(ConnectionNotificationService.EXTRA_HOST_NAME, hostName)
            .putExtra(ConnectionNotificationService.EXTRA_STATE, state);
        try {
            startService(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Could not update the connection notification.", error);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().stopService(new Intent(getContext(), ConnectionNotificationService.class));
        ConnectionNotificationService.clearStoredState(getContext());
        call.resolve();
    }

    private void startService(Intent intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ContextCompat.startForegroundService(getContext(), intent);
        else getContext().startService(intent);
    }

    @Override
    protected void handleOnDestroy() {
        if (connectionReceiver != null) {
            getContext().unregisterReceiver(connectionReceiver);
            connectionReceiver = null;
        }
        super.handleOnDestroy();
    }
}
