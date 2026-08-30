package com.agentterminal.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

public class ConnectionNotificationService extends Service {
    public static final String ACTION_START = "com.agentterminal.mobile.START_CONNECTION_NOTIFICATION";
    public static final String ACTION_UPDATE = "com.agentterminal.mobile.UPDATE_CONNECTION_NOTIFICATION";
    public static final String ACTION_DISCONNECT = "com.agentterminal.mobile.DISCONNECT_CONNECTION";
    public static final String EXTRA_HOST_NAME = "hostName";
    public static final String EXTRA_STATE = "state";
    public static final String STATE_CONNECTED = "connected";
    public static final String STATE_RECONNECTING = "reconnecting";
    // Use a new channel id whenever the channel configuration changes so
    // devices that already created an older channel get the new importance
    // and sound behavior instead of keeping the user-visible immutable
    // settings of the old channel forever.
    private static final String CHANNEL_ID = "agent-terminal-connection-v3";
    private static final int NOTIFICATION_ID = 9001;
    private static final String PREFS = "connection-notification";
    private static final String PREF_HOST_NAME = "hostName";
    private static final String PREF_STATE = "state";
    private static final long RECONNECT_TIMEOUT_MS = 30_000L;
    private static final long NETWORK_LOSS_DEBOUNCE_MS = 750L;
    private Handler reconnectTimeoutHandler;
    private boolean reconnectTimeoutScheduled;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    private final Runnable networkUnavailable = () -> markNetworkUnavailable();
    private final Runnable reconnectTimeout = () -> {
        reconnectTimeoutScheduled = false;
        sendBroadcast(new Intent(ConnectionNotificationPlugin.ACTION_RECONNECT_TIMED_OUT).setPackage(getPackageName()));
        clearStoredState(this);
        stopForeground(true);
        stopSelf();
    };

    @Override
    public void onCreate() {
        super.onCreate();
        reconnectTimeoutHandler = new Handler(Looper.getMainLooper());
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // High importance (heads-up capable feature status, never muted)
            // but silent: no sound, vibration, or lights, so the ongoing
            // connection notification never interrupts but still ranks high.
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Terminal connection", NotificationManager.IMPORTANCE_HIGH);
            channel.setSound(null, null);
            channel.enableVibration(false);
            channel.enableLights(false);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        registerNetworkCallback();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_DISCONNECT.equals(intent.getAction())) {
            cancelReconnectTimeout();
            sendBroadcast(new Intent(ConnectionNotificationPlugin.ACTION_DISCONNECT_REQUESTED).setPackage(getPackageName()));
            clearStoredState(this);
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        boolean restoredAfterProcessDeath = intent == null;
        String hostName = intent == null ? preferences.getString(PREF_HOST_NAME, null) : intent.getStringExtra(EXTRA_HOST_NAME);
        if (restoredAfterProcessDeath && (hostName == null || hostName.trim().isEmpty())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (hostName == null || hostName.trim().isEmpty()) hostName = "Agent Terminal";
        String state = intent == null ? preferences.getString(PREF_STATE, STATE_RECONNECTING) : intent.getStringExtra(EXTRA_STATE);
        if (!STATE_CONNECTED.equals(state) && !STATE_RECONNECTING.equals(state)) state = STATE_CONNECTED;
        // A sticky service restart means the WebView and its socket may have
        // died with the old process. Never recreate a notification claiming
        // that the desktop is connected until the WebView authenticates again.
        if (restoredAfterProcessDeath) state = STATE_RECONNECTING;
        preferences.edit().putString(PREF_HOST_NAME, hostName).putString(PREF_STATE, state).apply();

        renderNotification(hostName, state);
        return START_STICKY;
    }

    private void renderNotification(String hostName, String state) {
        Intent openIntent = new Intent(this, MainActivity.class)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent openPendingIntent = PendingIntent.getActivity(this, 9002, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent disconnectIntent = new Intent(this, ConnectionNotificationService.class).setAction(ACTION_DISCONNECT);
        PendingIntent disconnectPendingIntent = PendingIntent.getService(this, 9003, disconnectIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_terminal)
            .setContentTitle("Agent Terminal")
            .setContentText(notificationText(hostName, state))
            .setContentIntent(openPendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            // High priority, but silent: no sound or vibration for a status
            // notification that is up for hours at a time. On pre-O devices
            // the flags below take effect; on O+ the channel above governs.
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setSilent(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(new NotificationCompat.Action.Builder(0, "Disconnect", disconnectPendingIntent).build())
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        if (STATE_RECONNECTING.equals(state)) scheduleReconnectTimeout();
        else cancelReconnectTimeout();
    }

    private void registerNetworkCallback() {
        connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        if (connectivityManager == null) return;
        networkCallback = new ConnectivityManager.NetworkCallback() {
            @Override
            public void onAvailable(Network network) {
                // Avoid showing a reconnect during a quick Wi-Fi-to-cellular
                // handoff. JavaScript still has to authenticate or complete
                // a heartbeat before the notification returns to connected.
                reconnectTimeoutHandler.removeCallbacks(networkUnavailable);
                // The route is back; resume the give-up timer only if the
                // WebView has not recovered on its own yet.
                SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
                if (STATE_RECONNECTING.equals(preferences.getString(PREF_STATE, null))) {
                    scheduleReconnectTimeout();
                }
            }

            @Override
            public void onLost(Network network) {
                // A WebSocket can remain OPEN after the underlying route is
                // gone. Update the service-owned notification after a short
                // handoff grace period; the WebView will move it back to
                // connected after auth or a successful heartbeat. Also pause
                // the give-up timer: reconnects are deferred until the route
                // returns, and give-up would only drain the battery.
                reconnectTimeoutHandler.removeCallbacks(networkUnavailable);
                cancelReconnectTimeout();
                reconnectTimeoutHandler.postDelayed(networkUnavailable, NETWORK_LOSS_DEBOUNCE_MS);
            }
        };
        try {
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (RuntimeException ignored) {
            connectivityManager = null;
            networkCallback = null;
        }
    }

    private void markNetworkUnavailable() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        String hostName = preferences.getString(PREF_HOST_NAME, null);
        if (hostName == null || hostName.trim().isEmpty()) return;
        preferences.edit().putString(PREF_STATE, STATE_RECONNECTING).apply();
        renderNotification(hostName, STATE_RECONNECTING);
        // The route is gone: wait for connectivity to return before giving up.
        cancelReconnectTimeout();
    }

    private void scheduleReconnectTimeout() {
        if (reconnectTimeoutScheduled) return;
        // Without an active network no reconnect attempt can succeed; holding
        // the device awake just to give up would drain the battery. Wait for
        // the route to return (onAvailable re-arms the timer) instead.
        if (connectivityManager != null && connectivityManager.getActiveNetwork() == null) return;
        reconnectTimeoutScheduled = true;
        reconnectTimeoutHandler.postDelayed(reconnectTimeout, RECONNECT_TIMEOUT_MS);
    }

    private void cancelReconnectTimeout() {
        if (reconnectTimeoutHandler != null) reconnectTimeoutHandler.removeCallbacks(reconnectTimeout);
        reconnectTimeoutScheduled = false;
    }

    public static void markReconnecting(Context context) {
        SharedPreferences preferences = context.getSharedPreferences(PREFS, MODE_PRIVATE);
        String hostName = preferences.getString(PREF_HOST_NAME, null);
        if (hostName == null || hostName.trim().isEmpty()) return;
        Intent intent = new Intent(context, ConnectionNotificationService.class)
            .setAction(ACTION_UPDATE)
            .putExtra(EXTRA_HOST_NAME, hostName)
            .putExtra(EXTRA_STATE, STATE_RECONNECTING);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ContextCompat.startForegroundService(context, intent);
            else context.startService(intent);
        } catch (RuntimeException ignored) {
            // The Activity may be in the middle of being recreated. The next
            // successful WebView connection will update the notification.
        }
    }

    public static void clearStoredState(Context context) {
        context.getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
    }

    private static String notificationText(String hostName, String state) {
        return STATE_RECONNECTING.equals(state)
            ? "Reconnecting to " + hostName + "…"
            : "Connected to " + hostName;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        cancelReconnectTimeout();
        if (reconnectTimeoutHandler != null) reconnectTimeoutHandler.removeCallbacks(networkUnavailable);
        if (connectivityManager != null && networkCallback != null) {
            try { connectivityManager.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
        }
        connectivityManager = null;
        networkCallback = null;
        super.onDestroy();
    }
}
