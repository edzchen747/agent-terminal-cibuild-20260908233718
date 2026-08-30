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

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public class ConnectionNotificationService extends Service {
    public static final String ACTION_START = "com.agentterminal.mobile.START_CONNECTION_NOTIFICATION";
    public static final String ACTION_UPDATE = "com.agentterminal.mobile.UPDATE_CONNECTION_NOTIFICATION";
    public static final String ACTION_DISCONNECT = "com.agentterminal.mobile.DISCONNECT_CONNECTION";
    public static final String EXTRA_HOST_NAME = "hostName";
    public static final String EXTRA_STATE = "state";
    public static final String EXTRA_ENDPOINT = "endpoint";
    public static final String STATE_CONNECTED = "connected";
    public static final String STATE_RECONNECTING = "reconnecting";
    public static final String STATE_OFFLINE = "offline";
    // Use a new channel id whenever the channel configuration changes so
    // devices that already created an older channel get the new importance
    // and sound behavior instead of keeping the user-visible immutable
    // settings of the old channel forever.
    private static final String CHANNEL_ID = "agent-terminal-connection-v3";
    private static final int NOTIFICATION_ID = 9001;
    private static final String PREFS = "connection-notification";
    private static final String PREF_HOST_NAME = "hostName";
    private static final String PREF_STATE = "state";
    private static final String PREF_ENDPOINT = "endpoint";
    private static final long RECONNECT_TIMEOUT_MS = 30_000L;
    private static final long NETWORK_LOSS_DEBOUNCE_MS = 750L;
    // How often the native probe re-verifies that the desktop answers the
    // WebSocket upgrade. Tailscale keeps the UDP NAT mapping alive on its
    // own; this probe covers the app-level exit that tailscale cannot see.
    private static final long PROBE_INTERVAL_MS = 20_000L;
    private static final int PROBE_SOCKET_TIMEOUT_MS = 6_000;
    private Handler reconnectTimeoutHandler;
    private boolean reconnectTimeoutScheduled;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;
    // Runs on the main thread: schedules the probe and advances its timer.
    private final ExecutorService probeExecutor = Executors.newSingleThreadExecutor();
    private final AtomicBoolean probeArmed = new AtomicBoolean(false);
    private final AtomicBoolean probeRunning = new AtomicBoolean(false);
    private final Runnable probeLoop = () -> {
        if (!probeArmed.get() || probeRunning.get()) return;
        String endpoint = endpointFrom(getSharedPreferences(PREFS, MODE_PRIVATE));
        if (endpoint.isEmpty()) {
            resumeProbeLoop();
            return;
        }
        probeRunning.set(true);
        probeExecutor.execute(() -> {
            boolean alive = probeDesktop(endpoint);
            reconnectTimeoutHandler.post(() -> {
                probeRunning.set(false);
                if (!alive && STATE_CONNECTED.equals(storedState())) markUnavailable();
                if (probeArmed.get()) resumeProbeLoop();
            });
        });
    };

    private void resumeProbeLoop() {
        reconnectTimeoutHandler.postDelayed(probeLoop, PROBE_INTERVAL_MS);
    }
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
        if (!STATE_CONNECTED.equals(state) && !STATE_RECONNECTING.equals(state) && !STATE_OFFLINE.equals(state)) state = STATE_CONNECTED;
        // A sticky service restart means the WebView and its socket may have
        // died with the old process. Never recreate a notification claiming
        // that the desktop is connected until the WebView authenticates again.
        if (restoredAfterProcessDeath) state = STATE_RECONNECTING;
        String endpoint = intent == null ? preferences.getString(PREF_ENDPOINT, "") : intent.getStringExtra(EXTRA_ENDPOINT);
        if (endpoint == null || endpoint.isEmpty()) {
            // Reconnecting updates before the new socket opens carry no
            // endpoint; keep the last live one so the probe keeps watching
            // the endpoint it can actually reach.
            endpoint = preferences.getString(PREF_ENDPOINT, "");
        }
        if (endpoint == null) endpoint = "";
        preferences.edit().putString(PREF_HOST_NAME, hostName).putString(PREF_STATE, state).putString(PREF_ENDPOINT, endpoint).apply();

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
            .addAction(new NotificationCompat.Action.Builder(0, STATE_CONNECTED.equals(state) ? "Disconnect" : "Cancel", disconnectPendingIntent).build())
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        if (STATE_RECONNECTING.equals(state)) scheduleReconnectTimeout();
        else cancelReconnectTimeout();
        if (STATE_CONNECTED.equals(state)) {
            probeArmed.set(true);
            reconnectTimeoutHandler.removeCallbacks(probeLoop);
            reconnectTimeoutHandler.postDelayed(probeLoop, PROBE_INTERVAL_MS);
        } else {
            probeArmed.set(false);
            reconnectTimeoutHandler.removeCallbacks(probeLoop);
        }
    }

    private void markUnavailable() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        String hostName = preferences.getString(PREF_HOST_NAME, null);
        if (hostName == null || hostName.trim().isEmpty()) return;
        // The desktop stopped answering the probe: the tailscale layer is
        // fine (it keeps NAT mappings alive on its own) but the desktop app
        // is gone. Show reconnecting; the WebView takes the notification
        // back to connected after auth or a successful heartbeat, so the
        // probe itself never claims connected. The give-up timer is left to
        // the WebView's own loop, which runs once the screen is awake and
        // can actually retry; while the screen is off it cannot.
        preferences.edit().putString(PREF_STATE, STATE_RECONNECTING).apply();
        renderNotification(hostName, STATE_RECONNECTING);
        cancelReconnectTimeout();
    }

    /**
     * Completes Socket.connect and the WebSocket upgrade over the endpoint the
     * WebView socket is bound to. A live desktop answers 101 before the close
     * we send right after; a tailnet orphan connects at the node but never
     * reaches a local desktop app (probe dials through the same proxy), and a
     * dead node answers nothing at all. Tailscale's own keepalives are not
     * considered: the probe asks the desktop app itself.
     */
    private boolean probeDesktop(String endpoint) {
        try {
            URI parsed = new URI(endpoint);
            String host = parsed.getHost();
            int port = parsed.getPort() > 0 ? parsed.getPort() : (parsed.getScheme().equals("wss") ? 443 : 80);
            if (host == null) return true;
            try (Socket socket = new Socket()) {
                socket.connect(new InetSocketAddress(host, port), PROBE_SOCKET_TIMEOUT_MS);
                socket.setSoTimeout(PROBE_SOCKET_TIMEOUT_MS);
                BufferedOutputStream output = new BufferedOutputStream(socket.getOutputStream());
                String key = Base64.getEncoder().encodeToString(UUID.randomUUID().toString().getBytes(StandardCharsets.UTF_8));
                String request = "GET / HTTP/1.1\r\n"
                    + "Host: " + host + "\r\n"
                    + "Upgrade: websocket\r\n"
                    + "Connection: Upgrade\r\n"
                    + "Sec-WebSocket-Key: " + key + "\r\n"
                    + "Sec-WebSocket-Version: 13\r\n"
                    + "\r\n";
                output.write(request.getBytes(StandardCharsets.UTF_8));
                output.flush();
                BufferedInputStream input = new BufferedInputStream(socket.getInputStream());
                return readUpgradeAccepted(input);
            }
        } catch (Exception error) {
            return false;
        }
    }

    private boolean readUpgradeAccepted(BufferedInputStream input) throws IOException {
        // A network read may return a partial header. Loop until the status
        // line is complete, the stream ends, or the socket timeout fires.
        byte[] buffer = new byte[1024];
        StringBuilder header = new StringBuilder();
        while (readerHasStatusCode(header) == null) {
            int read = input.read(buffer);
            if (read < 0) return false;
            header.append(new String(buffer, 0, read, StandardCharsets.US_ASCII));
            if (header.length() > 1024) return false;
        }
        return "101".equals(readerHasStatusCode(header));
    }

    /** Returns the HTTP status code once the status line is complete, else null. */
    private String readerHasStatusCode(StringBuilder header) {
        int lineEnd = header.indexOf("\r\n");
        if (lineEnd < 0) return null;
        String statusLine = header.substring(0, lineEnd);
        if (!statusLine.startsWith("HTTP/1.1 ") && !statusLine.startsWith("HTTP/1.0 ")) return "";
        int codeStart = statusLine.indexOf(' ') + 1;
        if (codeStart + 3 > statusLine.length()) return null;
        return statusLine.substring(codeStart, codeStart + 3);
    }

    private String storedState() {
        SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        String state = preferences.getString(PREF_STATE, null);
        return state == null ? "" : state;
    }

    private String endpointFrom(SharedPreferences preferences) {
        String endpoint = preferences.getString(PREF_ENDPOINT, "");
        return endpoint == null ? "" : endpoint;
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
                // The route is back. A "waiting for internet" notification
                // upgrades to reconnecting so it never lingers past the
                // handoff; the give-up timer resumes only if the WebView has
                // not recovered on its own yet.
                SharedPreferences preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
                String storedState = preferences.getString(PREF_STATE, null);
                if (STATE_OFFLINE.equals(storedState)) {
                    String hostName = preferences.getString(PREF_HOST_NAME, null);
                    if (hostName != null && !hostName.trim().isEmpty()) {
                        preferences.edit().putString(PREF_STATE, STATE_RECONNECTING).apply();
                        renderNotification(hostName, STATE_RECONNECTING);
                    }
                } else if (STATE_RECONNECTING.equals(storedState)) {
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

    private String notificationText(String hostName, String state) {
        if (STATE_OFFLINE.equals(state)) return "Waiting for an internet connection to " + hostName + "…";
        if (STATE_RECONNECTING.equals(state) && !hasActiveNetwork()) {
            // The route is gone but the WebView has not called back yet: the
            // reconnect loop is paused by design, so do not promise a retry.
            return "Waiting for an internet connection to " + hostName + "…";
        }
        return STATE_RECONNECTING.equals(state)
            ? "Reconnecting to " + hostName + "…"
            : "Connected to " + hostName;
    }

    private boolean hasActiveNetwork() {
        if (connectivityManager == null) return true;
        try {
            return connectivityManager.getActiveNetwork() != null;
        } catch (RuntimeException ignored) {
            return true;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        cancelReconnectTimeout();
        probeArmed.set(false);
        if (reconnectTimeoutHandler != null) {
            reconnectTimeoutHandler.removeCallbacks(networkUnavailable);
            reconnectTimeoutHandler.removeCallbacks(probeLoop);
        }
        probeExecutor.shutdownNow();
        if (connectivityManager != null && networkCallback != null) {
            try { connectivityManager.unregisterNetworkCallback(networkCallback); } catch (RuntimeException ignored) { }
        }
        connectivityManager = null;
        networkCallback = null;
        super.onDestroy();
    }
}
