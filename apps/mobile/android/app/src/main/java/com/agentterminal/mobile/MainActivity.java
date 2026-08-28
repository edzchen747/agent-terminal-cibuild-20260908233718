package com.agentterminal.mobile;

import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import android.util.Log;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "AgentTerminal";
    private WebViewListener rendererListener;
    private boolean rendererRecoveryScheduled;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(EmbeddedNodePlugin.class);
        registerPlugin(ConnectionNotificationPlugin.class);
        super.onCreate(savedInstanceState);
        getBridge().getWebView().setLongClickable(true);
        rendererListener = new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                if (rendererRecoveryScheduled) return true;
                rendererRecoveryScheduled = true;
                Log.e(TAG, "The WebView renderer exited; recreating the mobile client.");
                ConnectionNotificationService.markReconnecting(MainActivity.this);
                runOnUiThread(() -> {
                    if (isFinishing() || (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN_MR1 && isDestroyed())) return;
                    ViewParent parent = webView.getParent();
                    if (parent instanceof ViewGroup) ((ViewGroup) parent).removeView(webView);
                    webView.destroy();
                    recreate();
                });
                return true;
            }
        };
        getBridge().addWebViewListener(rendererListener);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getBridge().getWebView().setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
    }

    @Override
    public void onDestroy() {
        if (getBridge() != null && rendererListener != null) {
            getBridge().removeWebViewListener(rendererListener);
            rendererListener = null;
        }
        super.onDestroy();
    }
}
