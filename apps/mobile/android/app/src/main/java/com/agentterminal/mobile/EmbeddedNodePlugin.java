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
        File executable = bundledExecutable();
        if (!executable.isFile()) {
            call.reject("The embedded node engine is not included in this build.");
            return;
        }
        if (!executable.canExecute()) {
            call.reject("The embedded node engine is not executable in this build.");
            return;
        }
        if (nodeProcess != null && nodeProcess.isAlive()) {
            if (authKey == null || authKey.isEmpty()) {
                JSObject result = readStatus(new File(getContext().getFilesDir(), "embedded-node-state"), nodeId);
                if (rejectForStatus(call, result)) return;
                call.resolve(result);
                return;
            }
            // A fresh one-time key means the WebView detected that the saved
            // Headscale node was removed. Restart tsnet so the key is applied
            // instead of returning the stale process status.
            stopNodeProcess();
        }
        try {
            File stateDir = new File(getContext().getFilesDir(), "embedded-node-state");
            if (!stateDir.exists() && !stateDir.mkdirs()) {
                call.reject("Could not create embedded node state directory.");
                return;
            }
            File statusFile = new File(stateDir, "status.json");
            if (statusFile.exists() && !statusFile.delete()) {
                call.reject("Could not reset the embedded node status.");
                return;
            }
            URI remote = new URI(remoteEndpoint);
            String remoteHost = remote.getHost();
            if (remoteHost == null) {
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
            String dnsServers = activeDnsServers();
            if (!dnsServers.isEmpty()) {
                builder.environment().put("AGENT_TERMINAL_DNS_SERVERS", dnsServers);
            }
            if (authKey != null && !authKey.isEmpty()) {
                builder.environment().put("AGENT_TERMINAL_NODE_AUTH_KEY", authKey);
            }
            builder.redirectError(ProcessBuilder.Redirect.appendTo(new File(getContext().getFilesDir(), "embedded-node.log")));
            Process process = builder.start();
            nodeProcess = process;
            watchProcess(process);
            JSObject result = readStatus(stateDir, nodeId);
            if (rejectForStatus(call, result)) {
                process.destroy();
                nodeProcess = null;
                return;
            }
            if (result.optString("endpoint", "").isEmpty()) {
                String message = process.isAlive()
                    ? "The embedded network node did not become ready."
                    : "The embedded network node stopped before becoming ready.";
                process.destroy();
                nodeProcess = null;
                call.reject(message);
                return;
            }
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
        process.destroy();
        try {
            if (!process.waitFor(2, TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
        }
    }

    private void watchProcess(Process process) {
        processWatcher.execute(() -> {
            try {
                process.waitFor();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            synchronized (EmbeddedNodePlugin.this) {
                if (nodeProcess == process) nodeProcess = null;
            }
        });
    }

    @Override
    protected synchronized void handleOnDestroy() {
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
