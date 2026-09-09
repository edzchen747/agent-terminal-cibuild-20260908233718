package com.agentterminal.mobile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.util.Log;

import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Process-isolated bridge for the signed embedded node shipped in a release.
 * Development APKs can omit the optional executable; the web layer then
 * reports the embedded node is unavailable while retaining the same node
 * identity.
 *
 * Threading: Capacitor serializes every plugin method - including the
 * Preferences calls the hosts page relies on for its delete path - on one
 * shared plugin thread. The blocking lifecycle work here (spawning a node
 * process, polling its status for up to 30 seconds, waiting up to two
 * seconds for a process to exit) must therefore never run on that thread: a
 * hosts-page registration check starts an engine per registered desktop,
 * and while any of them is coming up a delete's Preferences round-trips
 * queue behind it, leaving the deleted row on screen until the engines
 * drain. start and stop instead hand their blocking work to a single
 * dedicated lifecycle thread - which still serializes the engine's own
 * start/stop - and return to the plugin thread immediately; the pending
 * call is resolved from that thread, which the bridge marshals back to the
 * WebView.
 */
@CapacitorPlugin(name = "EmbeddedNode")
public class EmbeddedNodePlugin extends Plugin {
    private static final String TAG = "EmbeddedNode";
    // One process-isolated tsnet node per paired desktop. Each process owns
    // its own state directory (and therefore node identity); the map lets
    // several hosts' nodes run side by side (e.g. hosts-page registration
    // checks) without ever restarting the live host's node. Concurrent
    // because the lifecycle executor, the watcher thread, and teardown all
    // touch it without a shared lock.
    private final Map<File, Process> nodeProcesses = new ConcurrentHashMap<>();
    private final ExecutorService processWatcher = Executors.newSingleThreadExecutor();
    // All blocking lifecycle work runs on this one dedicated thread, so a
    // start can never preempt another start or a stop while the shared
    // Capacitor plugin thread stays free for the app's other plugin calls.
    private final ExecutorService nodeLifecycle = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void start(PluginCall call) {
        final String controlUrl = call.getString("controlUrl");
        final String privateKey = call.getString("privateKey");
        final String nodeId = call.getString("nodeId");
        final String remoteEndpoint = call.getString("remoteEndpoint");
        final String authKey = call.getString("authKey");
        final String stateKey = call.getString("stateKey");
        final boolean hasAuthKey = authKey != null && !authKey.isEmpty();
        nodeLifecycle.execute(() -> doStart(call, controlUrl, privateKey, nodeId, remoteEndpoint, authKey, hasAuthKey, stateKey));
    }

    private void doStart(PluginCall call, String controlUrl, String privateKey, String nodeId, String remoteEndpoint, String authKey, boolean hasAuthKey, String stateKey) {
        File stateDir = stateDirFor(stateKey);
        Log.i(TAG, "start requested: control=" + (controlUrl == null ? "null" : controlUrl) + " remote=" + (remoteEndpoint == null ? "null" : remoteEndpoint) + " authKey=" + (hasAuthKey ? "present" : "EMPTY") + " nodeId=" + (nodeId == null ? "null" : nodeId) + " stateDir=" + stateDir.getName());
        File executable = bundledExecutable();
        Log.i(TAG, "bundledExecutable: " + executable.getAbsolutePath() + " isFile=" + executable.isFile() + " canExecute=" + executable.canExecute());
        if (!executable.isFile()) {
            Log.e(TAG, "embedded node executable missing at " + executable.getAbsolutePath());
            call.reject("The embedded node engine is not included in this build.");
            return;
        }
        if (!executable.canExecute()) {
            Log.e(TAG, "embedded node engine not executable at " + executable.getAbsolutePath());
            call.reject("The embedded node engine is not executable in this build.");
            return;
        }
        Process running = nodeProcesses.get(stateDir);
        if (running != null && running.isAlive()) {
            if (!hasAuthKey) {
                // This host's own tsnet node is already running; its
                // persisted identity and proxy endpoint are still valid.
                Log.i(TAG, "node process already running for " + stateDir.getName() + "; returning saved status");
                JSObject result = readStatus(stateDir, nodeId);
                if (rejectForStatus(call, result)) return;
                logStatus(result);
                call.resolve(result);
                return;
            }
            // A fresh one-time key means the saved Headscale node was
            // removed. Only this host's process must restart so the new
            // identity is the one that gets registered; every other host's
            // node keeps running untouched.
            Log.i(TAG, "node process running for " + stateDir.getName() + "; restarting it to re-register");
            stopNodeProcess(stateDir);
        }
        try {
            if (!stateDir.exists() && !stateDir.mkdirs()) {
                Log.e(TAG, "could not create state directory: " + stateDir.getAbsolutePath());
                call.reject("Could not create embedded node state directory.");
                return;
            }
            File statusFile = new File(stateDir, "status.json");
            if (statusFile.exists() && !statusFile.delete()) {
                Log.e(TAG, "could not reset status file: " + statusFile.getAbsolutePath());
                call.reject("Could not reset the embedded node status.");
                return;
            }
            URI remote = new URI(remoteEndpoint);
            String remoteHost = remote.getHost();
            if (remoteHost == null) {
                Log.e(TAG, "invalid remote endpoint: " + remoteEndpoint);
                call.reject("The remote node endpoint is invalid.");
                return;
            }
            int remotePort = remote.getPort() > 0 ? remote.getPort() : 47831;
            ProcessBuilder builder = new ProcessBuilder(
                executable.getAbsolutePath(),
                "--state-dir", stateDir.getAbsolutePath(),
                "--control-url", controlUrl == null ? "" : controlUrl,
                "--node-id", nodeId == null ? "" : nodeId,
                "--remote-address", remoteHost + ":" + remotePort,
                "--proxy-listen", "127.0.0.1:0",
                // ProcessBuilder gives the child an inherited stdin pipe that
                // we never write to. The node exits when it reaches EOF, so a
                // node cannot outlive the app process that started it - which
                // would otherwise leave it contending for the same node
                // identity as the next launch's process.
                "--exit-with-parent"
            );
            builder.environment().put("AGENT_TERMINAL_NODE_PRIVATE_KEY", privateKey == null ? "" : privateKey);
            // Android app processes have no writable HOME/TMPDIR, which makes
            // tailscale's logpolicy panic ("no safe place found to store log
            // state"). Pin the log state directory to our app-private state
            // dir, which is guaranteed to exist and be writable.
            builder.environment().put("TS_LOGS_DIR", stateDir.getAbsolutePath());
            String dnsServers = activeDnsServers();
            if (!dnsServers.isEmpty()) {
                builder.environment().put("AGENT_TERMINAL_DNS_SERVERS", dnsServers);
            }
            if (hasAuthKey) {
                builder.environment().put("AGENT_TERMINAL_NODE_AUTH_KEY", authKey);
            }
            builder.redirectError(ProcessBuilder.Redirect.appendTo(new File(getContext().getFilesDir(), "embedded-node.log")));
            Process process = builder.start();
            nodeProcesses.put(stateDir, process);
            Log.i(TAG, "node process started " + process + " stateDir=" + stateDir.getName() + " remote=" + remoteHost + ":" + remotePort + " dns=" + dnsServers);
            watchProcess(process, stateDir);
            // Polling for the node's status can take up to 30 seconds; it
            // runs on the lifecycle thread, so the shared plugin thread is
            // free to serve the app's other plugin calls while we wait.
            JSObject result = readStatus(stateDir, nodeId);
            if (rejectForStatus(call, result)) {
                logStatus(result);
                destroyNodeProcess(stateDir);
                return;
            }
            if (result.optString("endpoint", "").isEmpty()) {
                String message = process.isAlive()
                    ? "The embedded network node did not become ready."
                    : "The embedded network node stopped before becoming ready.";
                Log.e(TAG, message);
                destroyNodeProcess(stateDir);
                call.reject(message);
                return;
            }
            logStatus(result);
            call.resolve(result);
        } catch (Exception error) {
            Log.e(TAG, "Could not start the embedded node engine", error);
            String detail = error.getMessage();
            call.reject(detail == null || detail.isEmpty()
                ? "Could not start the embedded node engine."
                : "Could not start the embedded node engine: " + detail);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        final String stateKey = call.getString("stateKey");
        nodeLifecycle.execute(() -> {
            if (stateKey == null || stateKey.isEmpty()) {
                stopAllNodeProcesses();
            } else {
                // Only the host's own node is stopped, so background checks can
                // tear down the node they started without touching the live
                // connection's node.
                stopNodeProcess(stateDirFor(stateKey));
            }
            call.resolve();
        });
    }

    /**
     * Publish the desired port bridges for this host's node.
     *
     * The node polls this file and reconciles its listeners against it, so a
     * bridge can be added or removed while it runs. Writing works even with no
     * node process alive: the file is picked up on the next start, which is
     * what makes a bridge come up as soon as the connection does.
     */
    @PluginMethod
    public void setBridges(PluginCall call) {
        final String stateKey = call.getString("stateKey");
        final JSArray bridges = call.getArray("bridges", new JSArray());
        final int revision = call.getInt("revision", 0);
        nodeLifecycle.execute(() -> {
            File stateDir = stateDirFor(stateKey);
            if (!stateDir.exists() && !stateDir.mkdirs()) {
                call.reject("Could not create the embedded node state directory.");
                return;
            }
            try {
                JSONObject document = new JSONObject();
                document.put("revision", revision);
                document.put("bridges", bridges == null ? new JSArray() : bridges);
                // Atomic publish: the node must never read a half-written file.
                File target = new File(stateDir, "bridges.json");
                File temporary = new File(stateDir, "bridges.json.tmp");
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(temporary)) {
                    out.write(document.toString().getBytes(StandardCharsets.UTF_8));
                }
                if (!temporary.renameTo(target)) {
                    // renameTo does not replace on every filesystem.
                    if (!target.delete() || !temporary.renameTo(target)) {
                        call.reject("Could not publish the port bridge configuration.");
                        return;
                    }
                }
                Log.i(TAG, "published " + (bridges == null ? 0 : bridges.length()) + " bridge(s) revision=" + revision + " stateDir=" + stateDir.getName());
                call.resolve();
            } catch (Exception error) {
                Log.e(TAG, "Could not publish port bridges", error);
                call.reject("Could not publish the port bridge configuration.");
            }
        });
    }

    /**
     * What the node made of those bridges. Absent until it has reconciled at
     * least once, which the caller reads as "nothing to report yet".
     */
    @PluginMethod
    public void bridgeStatus(PluginCall call) {
        final String stateKey = call.getString("stateKey");
        nodeLifecycle.execute(() -> {
            JSObject result = new JSObject();
            result.put("bridges", new JSArray());
            File status = new File(stateDirFor(stateKey), "bridges-status.json");
            if (status.isFile()) {
                try {
                    JSONObject json = new JSONObject(new String(java.nio.file.Files.readAllBytes(status.toPath()), StandardCharsets.UTF_8));
                    JSONArray bridges = json.optJSONArray("bridges");
                    if (bridges != null) result.put("bridges", JSArray.from(bridges));
                } catch (Exception ignored) {
                    // The node may be mid-publish; an empty report is correct.
                }
            }
            call.resolve(result);
        });
    }

    private void stopNodeProcess(File stateDir) {
        if (stateDir == null) return;
        destroyNodeProcess(stateDir);
    }

    private void stopAllNodeProcesses() {
        for (File stateDir : new ArrayList<>(nodeProcesses.keySet())) destroyNodeProcess(stateDir);
    }

    private void destroyNodeProcess(File stateDir) {
        Process process = nodeProcesses.remove(stateDir);
        if (process == null) return;
        Log.i(TAG, "stopping node process " + process);
        process.destroy();
        boolean exited;
        try {
            exited = process.waitFor(2, TimeUnit.SECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            exited = false;
        }
        if (!exited) process.destroyForcibly();
        if (exited) Log.i(TAG, "node process stopped exit=" + process.exitValue());
    }

    private void watchProcess(Process process, File stateDir) {
        processWatcher.execute(() -> {
            try {
                process.waitFor();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            // Only clear the entry if this process is still the one tracked
            // for the state directory; a replacement process started in the
            // meantime keeps its own entry.
            nodeProcesses.remove(stateDir, process);
            Log.i(TAG, "node process exited exit=" + process.exitValue());
        });
    }

    private void logStatus(JSObject result) {
        String nodeId = result.optString("nodeId", "");
        String tailnetAddress = result.optString("tailnetAddress", "");
        String errorCode = result.optString("errorCode", "");
        String errorMessage = result.optString("errorMessage", "");
        String errorDetail = result.optString("errorDetail", "");
        String endpoint = result.optString("endpoint", "");
        Log.i(TAG, "status: nodeId=" + nodeId + " tailnetAddress=" + tailnetAddress + " endpoint=" + endpoint + " errorCode=" + errorCode + " errorMessage=" + errorMessage + " errorDetail=" + errorDetail);
    }

    @Override
    protected void handleOnDestroy() {
        Log.i(TAG, "bridge destroyed; stopping node processes");
        // Stop without waiting: the bridge is going away, so teardown must
        // not block on a process exit. Orphaned node processes are
        // acceptable here; they stay in the relay until inactivity expiry,
        // the same as an unpaired host's node.
        List<Process> processes = new ArrayList<>(nodeProcesses.values());
        nodeProcesses.clear();
        for (Process process : processes) {
            process.destroy();
        }
        processWatcher.shutdownNow();
        nodeLifecycle.shutdownNow();
        super.handleOnDestroy();
    }

    private File bundledExecutable() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libembedded-node.so");
    }

    /**
     * One tsnet state directory per paired desktop. The state directory is
     * where tsnet persists the node key, so this is what makes every host
     * keep its own phone-side node (enrolled under that host's Headscale
     * user) instead of sharing one identity that can only ever belong to
     * one pairing group. The legacy shared directory is kept as the
     * fallback so an old web layer still works.
     */
    private File stateDirFor(String stateKey) {
        String suffix = "";
        if (stateKey != null) {
            String sanitized = stateKey.replaceAll("[^A-Za-z0-9-]", "");
            if (!sanitized.isEmpty() && sanitized.length() <= 64) suffix = "-host-" + sanitized;
        }
        return new File(getContext().getFilesDir(), "embedded-node-state" + suffix);
    }

    private String activeDnsServers() {
        ConnectivityManager manager = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (manager == null) return "";
        Network network = manager.getActiveNetwork();
        if (network == null) return "";
        LinkProperties properties = manager.getLinkProperties(network);
        if (properties == null || properties.getDnsServers().isEmpty()) return "";
        StringBuilder result = new StringBuilder();
        for (java.net.InetAddress address : properties.getDnsServers()) {
            if (result.length() > 0) result.append(',');
            result.append(address.getHostAddress());
        }
        return result.toString();
    }

    private JSObject readStatus(File stateDir, String nodeId) {
        JSObject result = new JSObject();
        result.put("nodeId", nodeId);
        File status = new File(stateDir, "status.json");
        for (int attempt = 0; attempt < 600; attempt++) {
            if (status.isFile()) {
                try {
                    JSONObject json = new JSONObject(new String(java.nio.file.Files.readAllBytes(status.toPath()), StandardCharsets.UTF_8));
                    result.put("nodeId", json.optString("nodeId", nodeId));
                    result.put("tailnetAddress", json.optString("tailnetAddress", null));
                    String errorCode = json.optString("errorCode", "");
                    if (!errorCode.isEmpty()) result.put("errorCode", errorCode);
                    String errorMessage = json.optString("errorMessage", "");
                    if (!errorMessage.isEmpty()) result.put("errorMessage", errorMessage);
                    String errorDetail = json.optString("errorDetail", "");
                    if (!errorDetail.isEmpty()) result.put("errorDetail", errorDetail);
                    String proxyAddress = json.optString("proxyAddress", "");
                    if (!proxyAddress.isEmpty()) {
                        result.put("endpoint", "ws://" + proxyAddress);
                    }
                    return result;
                } catch (Exception ignored) {
                    // The engine may still be atomically publishing status.
                }
            }
            try {
                Thread.sleep(50L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return result;
            }
        }
        return result;
    }

    private boolean rejectForStatus(PluginCall call, JSObject result) {
        String errorCode = result.optString("errorCode", "");
        if (errorCode.isEmpty()) return false;
        String message = result.optString("errorMessage", "The embedded network node could not start.");
        String detail = result.optString("errorDetail", "");
        if (errorCode.equals("embedded_node_start_failed") && !detail.isEmpty()) {
            message += " (" + detail + ")";
        }
        call.reject(message, errorCode);
        return true;
    }
}
