package com.agentterminal.mobile;

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ConnectionNotification")
public class ConnectionNotificationPlugin extends Plugin {
    public static final String ACTION_DISCONNECT_REQUESTED = "com.agentterminal.mobile.DISCONNECT_REQUESTED";
    public static final String ACTION_RECONNECT_TIMED_OUT = "com.agentterminal.mobile.RECONNECT_TIMED_OUT";
    private static final int NOTIFICATION_PERMISSION_REQUEST = 4201;
    private static final String SCREEN_STATE_EVENT = "screenState";
    private BroadcastReceiver connectionReceiver;
    private BroadcastReceiver powerStateReceiver;
    private PowerManager powerManager;
    private final Handler screenStateHandler = new Handler(Looper.getMainLooper());
    private final Runnable reportScreenState = () -> {
        JSObject data = screenState();
        notifyListeners(SCREEN_STATE_EVENT, data);
    };

    private JSObject screenState() {
        boolean awake = powerManager != null && powerManager.isInteractive();
        boolean sleeping = powerManager != null && powerManager.isDeviceIdleMode();
        JSObject data = new JSObject();
        data.put("awake", awake);
        data.put("sleeping", sleeping);
        return data;
    }

    @Override
    public void load() {
        powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        powerStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                screenStateHandler.removeCallbacks(reportScreenState);
                // Debounce quick screen flickers and handoffs; the runnable
                // reads the actual power state so a stale broadcast cannot win.
                screenStateHandler.postDelayed(reportScreenState, 250L);
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED);
        ContextCompat.registerReceiver(getContext(), powerStateReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED);

        connectionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (ACTION_RECONNECT_TIMED_OUT.equals(intent.getAction())) notifyListeners("reconnectTimedOut", null);
                else notifyListeners("disconnectRequested", null);
            }
        };
        IntentFilter filter2 = new IntentFilter();
        filter2.addAction(ACTION_DISCONNECT_REQUESTED);
        filter2.addAction(ACTION_RECONNECT_TIMED_OUT);
        ContextCompat.registerReceiver(getContext(), connectionReceiver, filter2, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @PluginMethod
    public void getScreenState(PluginCall call) {
        call.resolve(screenState());
    }

    @PluginMethod
    public void start(PluginCall call) {
        String hostName = call.getString("hostName", "Agent Terminal");
        Intent intent = new Intent(getContext(), ConnectionNotificationService.class)
            .setAction(ConnectionNotificationService.ACTION_START)
            .putExtra(ConnectionNotificationService.EXTRA_HOST_NAME, hostName)
            .putExtra(ConnectionNotificationService.EXTRA_ENDPOINT, call.getString("endpoint", ""));
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
            !ConnectionNotificationService.STATE_RECONNECTING.equals(state) &&
            !ConnectionNotificationService.STATE_OFFLINE.equals(state)) {
            call.reject("The connection notification state is invalid.");
            return;
        }
        Intent intent = new Intent(getContext(), ConnectionNotificationService.class)
            .setAction(ConnectionNotificationService.ACTION_UPDATE)
            .putExtra(ConnectionNotificationService.EXTRA_HOST_NAME, hostName)
            .putExtra(ConnectionNotificationService.EXTRA_STATE, state)
            .putExtra(ConnectionNotificationService.EXTRA_ENDPOINT, call.getString("endpoint", ""));
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
        if (powerStateReceiver != null) {
            getContext().unregisterReceiver(powerStateReceiver);
            powerStateReceiver = null;
        }
        screenStateHandler.removeCallbacks(reportScreenState);
        super.handleOnDestroy();
    }
}
