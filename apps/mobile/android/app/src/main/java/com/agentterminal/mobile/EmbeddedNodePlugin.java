package com.agentterminal.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
        File executable = installBundledExecutable();
        if (!executable.isFile() || !executable.canExecute()) {
            call.reject("The embedded node engine is not included in this build.");
            return;
        }
        if (nodeProcess != null && nodeProcess.isAlive()) {
            JSObject result = readStatus(new File(getContext().getFilesDir(), "embedded-node-state"), nodeId);
            if (rejectForStatus(call, result)) return;
            call.resolve(result);
            return;
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
        if (nodeProcess != null) {
            nodeProcess.destroy();
            nodeProcess = null;
        }
        call.resolve();
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
        if (nodeProcess != null) {
            nodeProcess.destroy();
            nodeProcess = null;
        }
        processWatcher.shutdownNow();
        super.handleOnDestroy();
    }

    private File installBundledExecutable() {
        File executable = new File(getContext().getFilesDir(), "embedded-node");
        if (executable.isFile() && executable.canExecute()) return executable;
        for (String abi : android.os.Build.SUPPORTED_ABIS) {
            String asset = "embedded-node/" + abi + "/embedded-node";
            try (InputStream input = getContext().getAssets().open(asset);
                 FileOutputStream output = new FileOutputStream(executable)) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
                executable.setExecutable(true, true);
                return executable;
            } catch (IOException ignored) {
                // Try the next ABI. Development APKs may contain no engine.
            }
        }
        return executable;
    }

    private JSObject readStatus(File stateDir, String nodeId) {
        JSObject result = new JSObject();
        result.put("nodeId", nodeId);
        File status = new File(stateDir, "status.json");
        for (int attempt = 0; attempt < 300; attempt++) {
            if (status.isFile()) {
                try {
                    JSONObject json = new JSONObject(new String(java.nio.file.Files.readAllBytes(status.toPath()), StandardCharsets.UTF_8));
                    result.put("nodeId", json.optString("nodeId", nodeId));
                    result.put("tailnetAddress", json.optString("tailnetAddress", null));
                    String errorCode = json.optString("errorCode", "");
                    String errorMessage = json.optString("errorMessage", "");
                    if (!errorCode.isEmpty()) result.put("errorCode", errorCode);
                    if (!errorMessage.isEmpty()) result.put("errorMessage", errorMessage);
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
        call.reject(message);
        return true;
    }
}
