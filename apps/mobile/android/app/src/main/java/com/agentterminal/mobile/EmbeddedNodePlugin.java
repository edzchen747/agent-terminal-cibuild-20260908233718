package com.agentterminal.mobile;

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
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

/**
 * Process-isolated bridge for the signed embedded node shipped in a release.
 * Development APKs can omit the optional executable; the web layer then uses
 * the embedded node is unavailable after retaining the same node identity.
 */
@CapacitorPlugin(name = "EmbeddedNode")
public class EmbeddedNodePlugin extends Plugin {
    private static final String TAG = "EmbeddedNode";
    // One process-isolated tsnet node per paired desktop. Each process owns
    // its own state directory (and therefore node identity); the map lets
    // several hosts' nodes run side by side (e.g. hosts-page registration
    // checks) without ever restarting the live host's node.
    private final Map<File, Process> nodeProcesses = new HashMap<>();
    private final ExecutorService processWatcher = Executors.newSingleThreadExecutor();

    @PluginMethod
    public synchronized void start(PluginCall call) {
        String controlUrl = call.getString("controlUrl");
        String privateKey = call.getString("privateKey");
        String nodeId = call.getString("nodeId");
        String remoteEndpoint = call.getString("remoteEndpoint");
        String authKey = call.getString("authKey");
        String stateKey = call.getString("stateKey");
        boolean hasAuthKey = authKey != null && !authKey.isEmpty();
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
            Log.e(TAG, "embedded node executable not executable at " + executable.getAbsolutePath());
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
                "--proxy-listen", "127.0.0.1:0"
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
    public synchronized void stop(PluginCall call) {
        String stateKey = call.getString("stateKey");
        if (stateKey == null || stateKey.isEmpty()) {
            stopAllNodeProcesses();
        } else {
            // Only the host's own node is stopped, so background checks can
            // tear down the node they started without touching the live
            // connection's node.
            stopNodeProcess(stateDirFor(stateKey));
        }
        call.resolve();
    }

    private void stopNodeProcess(File stateDir) {
        if (stateDir == null) return;
        destroyNodeProcess(stateDir);
    }

    private void stopAllNodeProcesses() {
        for (File stateDir : new HashMap<>(nodeProcesses).keySet()) destroyNodeProcess(stateDir);
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
            synchronized (EmbeddedNodePlugin.this) {
                if (nodeProcesses.get(stateDir) == process) nodeProcesses.remove(stateDir);
            }
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
    protected synchronized void handleOnDestroy() {
        Log.i(TAG, "bridge destroyed; stopping node processes");
        stopAllNodeProcesses();
        processWatcher.shutdownNow();
        super.handleOnDestroy();
    }

    private File bundledExecutable() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libembedded-node.so");
    }

    /**
     * One tsnet state directory per paired desktop. The state directory is
     * where tsnet persists the node key, so this is what makes every host
     * keep its own phone-side node (enrolled under that host's Headscale
     * user) instead of sharing one identity that can only ever belong to a
     * single pairing group. The legacy shared directory is kept as the
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
                    String errorMessage = json.optString("errorMessage", "");
                    String errorDetail = json.optString("errorDetail", "");
                    if (!errorCode.isEmpty()) result.put("errorCode", errorCode);
                    if (!errorMessage.isEmpty()) result.put("errorMessage", errorMessage);
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
