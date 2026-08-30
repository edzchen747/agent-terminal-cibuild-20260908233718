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
    private Process nodeProcess;
    private final ExecutorService processWatcher = Executors.newSingleThreadExecutor();

    @PluginMethod
    public synchronized void start(PluginCall call) {
        String controlUrl = call.getString("controlUrl");
        String privateKey = call.getString("privateKey");
        String nodeId = call.getString("nodeId");
        String remoteEndpoint = call.getString("remoteEndpoint");
        String authKey = call.getString("authKey");
        boolean hasAuthKey = authKey != null && !authKey.isEmpty();
        Log.i(TAG, "start requested: control=" + (controlUrl == null ? "null" : controlUrl) + " remote=" + (remoteEndpoint == null ? "null" : remoteEndpoint) + " authKey=" + (hasAuthKey ? "present" : "EMPTY") + " nodeId=" + (nodeId == null ? "null" : nodeId));
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
        if (nodeProcess != null && nodeProcess.isAlive()) {
            if (!hasAuthKey) {
                Log.i(TAG, "node process already running; returning saved status");
                JSObject result = readStatus(new File(getContext().getFilesDir(), "embedded-node-state"), nodeId);
                if (rejectForStatus(call, result)) return;
                logStatus(result);
                call.resolve(result);
                return;
            }
            // A fresh one-time key means the WebView detected that the saved
            // Headscale node was removed. Restart tsnet so the key is applied
            // instead of returning the stale process status.
            Log.i(TAG, "node process running with new auth key; restarting to re-register");
            stopNodeProcess();
        }
        try {
            File stateDir = new File(getContext().getFilesDir(), "embedded-node-state");
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
            nodeProcess = process;
            Log.i(TAG, "node process started " + process + " remote=" + remoteHost + ":" + remotePort + " dns=" + dnsServers);
            watchProcess(process);
            JSObject result = readStatus(stateDir, nodeId);
            if (rejectForStatus(call, result)) {
                logStatus(result);
                process.destroy();
                nodeProcess = null;
                return;
            }
            if (result.optString("endpoint", "").isEmpty()) {
                String message = process.isAlive()
                    ? "The embedded network node did not become ready."
                    : "The embedded network node stopped before becoming ready.";
                Log.e(TAG, message);
                process.destroy();
                nodeProcess = null;
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
        stopNodeProcess();
        call.resolve();
    }

    private void stopNodeProcess() {
        Process process = nodeProcess;
        nodeProcess = null;
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

    private void watchProcess(Process process) {
        processWatcher.execute(() -> {
            try {
                process.waitFor();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            synchronized (EmbeddedNodePlugin.this) {
                if (nodeProcess == process) nodeProcess = null;
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
        Log.i(TAG, "bridge destroyed; stopping node process");
        stopNodeProcess();
        processWatcher.shutdownNow();
        super.handleOnDestroy();
    }

    private File bundledExecutable() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, "libembedded-node.so");
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
